import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { isRedisConfigured, redisCommand } from './redis-rest.mjs';
import {
  finalizeCounterpartCostCredential,
  reserveCounterpartCostCredential
} from './apify-credential-store.mjs';
import { classifyApifyFailure } from './apify-tiktok-runtime.mjs';
import { isGoogleLensConfigured, searchGoogleLens } from './counterpart/google-lens-provider.mjs';
import {
  cosineSimilarity,
  createVertexImageEmbedding,
  isVertexImageEmbeddingConfigured
} from './counterpart/vertex-image-embedding.mjs';

const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const INSUFFICIENT_CACHE_TTL_SECONDS = 12 * 60 * 60;
const EMPTY_CACHE_TTL_SECONDS = 60 * 60;
const MAX_CANDIDATES_TO_COMPARE = 12;
const MIN_REVIEW_COUNT = 20;
const MAX_IMAGE_BYTES = 7 * 1024 * 1024;
const SEARCH_DEADLINE_MS = 105_000;
const DEADLINE_SAFETY_MS = 5_000;

const MARKETPLACE_IMAGE_HOST = /(^|\.)(?:susercontent|shopeeusercontent|tiktokcdn|tiktokcdn-us|byteimg|ibyteimg|gstatic|googleusercontent)\.com$/i;
const SHOPEE_HOST = /(^|\.)shopee\.vn$/i;
const TIKTOK_HOST = /(^|\.)(?:tiktok\.com|tiktokshop\.com)$/i;
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'ao', 'bo', 'cai', 'cho', 'chinh', 'co', 'cua', 'den', 'duoc', 'hang', 'kem',
  'loai', 'mall', 'mau', 'mua', 'nam', 'nhieu', 'phien', 'pham', 'san', 'shop', 'shopee', 'tang',
  'the', 'tiktok', 'trang', 'tren', 'va', 'viet', 'voi', 'xuat'
]);
const MODEL_MARKERS = new Set([
  'air', 'galaxy', 'gen', 'iphone', 'max', 'mini', 'model', 'note', 'plus', 'pro', 'series', 'ultra'
]);

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

function envEnabled(env = process.env) {
  const flag = String(env.COUNTERPART_SEARCH_ENABLED ?? '').trim().toLowerCase();
  if (['false', '0', 'off', 'no'].includes(flag)) return false;
  return isGoogleLensConfigured(env) || (isRedisConfigured() && Boolean(String(env.APIFY_TOKEN_VAULT_KEY || '').trim()));
}

export function normalizePlatform(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized.includes('tiktok')) return 'TikTok Shop';
  if (normalized.includes('shopee')) return 'Shopee';
  return '';
}

export function targetPlatformFor(value) {
  const platform = normalizePlatform(value);
  if (platform === 'Shopee') return 'TikTok Shop';
  if (platform === 'TikTok Shop') return 'Shopee';
  return '';
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(?:shopee\s+viet\s+nam|tiktok\s+shop|official\s+store)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleTokens(value) {
  return normalizeText(value)
    .split(' ')
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

export function buildSearchQueries(title) {
  const tokens = titleTokens(title);
  if (!tokens.length) return [];
  const primary = tokens.slice(0, 12).join(' ').slice(0, 120);
  const modelTokens = tokens.filter((token) => /\d/.test(token) || token.length >= 6);
  const focused = [...new Set([...tokens.slice(0, 4), ...modelTokens.slice(0, 5)])].join(' ').slice(0, 100);
  return [...new Set([primary, focused].filter((query) => query.length >= 3))].slice(0, 2);
}

function tokenSimilarity(left, right) {
  const leftTokens = new Set(titleTokens(left));
  const rightTokens = new Set(titleTokens(right));
  if (!leftTokens.size || !rightTokens.size) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  const jaccard = intersection / Math.max(1, union);
  const containment = intersection / Math.max(1, Math.min(leftTokens.size, rightTokens.size));
  const leftModels = [...leftTokens].filter((token) => /\d/.test(token));
  const modelMatch = leftModels.length
    ? leftModels.filter((token) => rightTokens.has(token)).length / leftModels.length
    : containment;
  return clamp((jaccard * 0.5) + (containment * 0.35) + (modelMatch * 0.15));
}

export function parseMarketplaceCount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
  const raw = String(value ?? '').trim().toLowerCase().replace(/,/g, '.');
  if (!raw) return 0;
  const match = raw.match(/([\d.]+)\s*([km]|tr|tri[eệ]u)?/i);
  if (!match) return 0;
  const number = Number.parseFloat(match[1]);
  if (!Number.isFinite(number)) return 0;
  const multiplier = match[2] === 'k' ? 1_000 : ['m', 'tr', 'trieu', 'triệu'].includes(match[2]) ? 1_000_000 : 1;
  return Math.max(0, Math.round(number * multiplier));
}

function first(source, paths) {
  for (const path of paths) {
    const value = path.split('.').reduce((current, key) => current?.[key], source);
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  return undefined;
}

function validHttpUrl(value, kind = 'any') {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:') return '';
    if (kind === 'Shopee' && !SHOPEE_HOST.test(url.hostname)) return '';
    if (kind === 'TikTok Shop' && !TIKTOK_HOST.test(url.hostname)) return '';
    return url.href;
  } catch {
    return '';
  }
}

function shopeeImage(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^[\w-]{16,}$/.test(raw)) return `https://down-vn.img.susercontent.com/file/${raw}`;
  return validHttpUrl(raw);
}

function imageList(item, platform) {
  const values = [
    first(item, ['image', 'imageUrl', 'thumbnail', 'cover', 'productImage', 'product.image']),
    ...(Array.isArray(item.imageUrls) ? item.imageUrls : []),
    ...(Array.isArray(item.images) ? item.images : []),
    ...(Array.isArray(item.product?.images) ? item.product.images : [])
  ];
  return [...new Set(values.map((value) => platform === 'Shopee' ? shopeeImage(value) : validHttpUrl(value)).filter(Boolean))].slice(0, 3);
}

function normalizeCandidate(item, platform, index) {
  const title = String(first(item, ['title', 'name', 'productName', 'product.title', 'item.name']) || '').trim();
  const shopId = first(item, ['shopId', 'shop_id', 'shop.id']);
  const itemId = first(item, ['itemId', 'item_id', 'productId', 'product_id', 'id']);
  let url = validHttpUrl(first(item, ['productUrl', 'url', 'link', 'product.url']), platform);
  if (!url && platform === 'Shopee' && shopId && itemId) url = `https://shopee.vn/product/${shopId}/${itemId}`;
  const images = imageList(item, platform);
  if (!title || !url || !images.length) return null;
  const reviewCount = parseMarketplaceCount(first(item, [
    'reviewCount', 'ratingCount', 'commentCount', 'reviewsCount', 'totalReviews',
    'rating.count', 'rating.ratingCount', 'product.reviewCount', 'item.ratingCount'
  ]));
  return {
    id: String(itemId || createHash('sha1').update(url).digest('hex').slice(0, 16)),
    platform,
    title: title.slice(0, 240),
    url,
    image: images[0],
    images,
    price: String(first(item, ['currentPrice', 'price', 'priceText', 'product.price']) || '').slice(0, 80),
    rating: Number(first(item, ['rating', 'ratingAverage', 'product.rating'])) || null,
    reviewCount,
    shopName: String(first(item, ['sellerName', 'shopName', 'seller.name', 'shop.name']) || '').slice(0, 120),
    searchRank: Number(first(item, ['searchRank', 'rank', 'position'])) || index + 1,
    lensExact: Boolean(item.lensExact),
    discoveryMethod: String(item.discoveryMethod || 'actor-search')
  };
}

function flattenActorItems(payload) {
  if (!Array.isArray(payload)) return [];
  const output = [];
  for (const entry of payload) {
    if (!entry || typeof entry !== 'object') continue;
    const nested = [entry.products, entry.items, entry.data?.products, entry.data?.items].find(Array.isArray);
    if (nested) output.push(...nested);
    else output.push(entry);
  }
  return output;
}

export function normalizeActorCandidates(payload, platform) {
  const seen = new Set();
  const candidates = [];
  flattenActorItems(payload).forEach((item, index) => {
    const candidate = normalizeCandidate(item, platform, index);
    if (!candidate || seen.has(candidate.url)) return;
    seen.add(candidate.url);
    candidates.push(candidate);
  });
  return candidates;
}

function actorIdFor(platform, env = process.env) {
  const configured = platform === 'TikTok Shop'
    ? env.COUNTERPART_TIKTOK_SEARCH_ACTOR_ID
    : env.COUNTERPART_SHOPEE_SEARCH_ACTOR_ID;
  const fallback = platform === 'TikTok Shop'
    ? 'pro100chok/tiktok-shop-scraper-usage'
    : 'zen-studio/shopee-product-scraper';
  return String(configured || fallback).trim().replace('/', '~');
}

export function actorInputFor(platform, queries) {
  if (platform === 'TikTok Shop') {
    return {
      region: 'vn',
      scrapeType: 'search',
      searchKeywords: queries,
      maxItems: 30,
      includeReviews: false
    };
  }
  return {
    searchTerms: queries,
    region: 'VN',
    maxItems: 30,
    sort: 'relevance',
    includeEnrichment: false
  };
}

async function runSearchActor(platform, queries, options = {}) {
  const env = options.env || process.env;
  const actorId = actorIdFor(platform, env);
  const configuredTimeoutMs = Math.max(20_000, Math.min(100_000, Number(env.COUNTERPART_SEARCH_TIMEOUT_MS) || 55_000));
  const availableMs = Number.isFinite(Number(options.deadlineAt))
    ? Number(options.deadlineAt) - Date.now() - DEADLINE_SAFETY_MS
    : configuredTimeoutMs;
  if (availableMs < 5_000) {
    throw Object.assign(new Error('Không còn đủ thời gian để chạy Actor tìm kiếm.'), { code: 'COUNTERPART_DEADLINE', name: 'TimeoutError' });
  }
  const timeoutMs = Math.min(configuredTimeoutMs, availableMs);
  const plannedCostMicroUsd = platform === 'TikTok Shop'
    ? Number(env.COUNTERPART_TIKTOK_SEARCH_MAX_COST_MICRO_USD) || 250_000
    : Number(env.COUNTERPART_SHOPEE_SEARCH_MAX_COST_MICRO_USD) || 200_000;
  const allocation = await (options.reserveCounterpartImpl || reserveCounterpartCostCredential)({
    actorId: actorId.replace('~', '/'),
    plannedCostMicroUsd,
    pricingVersion: platform === 'TikTok Shop' ? 'tiktok-search-2026-09' : 'shopee-search-2026-09',
    fetchImpl: options.redisFetchImpl,
    usageFetchImpl: options.usageFetchImpl
  });
  const credential = allocation.credential;
  const fetchImpl = options.fetchImpl || fetch;
  const deadline = Date.now() + timeoutMs;
  const actorEndpoint = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}`;
  let actorRunId = null;
  let actualCostMicroUsd = null;
  let itemCount = 0;
  let statusCode = 0;
  let failureClass = '';
  let actorStarted = false;
  try {
    const response = await fetchImpl(`${actorEndpoint}/runs?waitForFinish=${Math.min(30, Math.max(1, Math.floor(timeoutMs / 1000)))}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(actorInputFor(platform, queries)),
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now()))
    });
    statusCode = response.status;
    if (!response.ok) {
      const detail = String(await response.text()).replace(/\s+/g, ' ').trim().slice(0, 240);
      throw Object.assign(new Error(`Actor tìm kiếm trả về HTTP ${response.status}${detail ? `: ${detail}` : ''}`), { statusCode: response.status });
    }
    let runBody = await response.json();
    let run = runBody?.data && typeof runBody.data === 'object' ? runBody.data : runBody;
    actorRunId = String(run?.id || '');
    actorStarted = Boolean(actorRunId);
    if (!actorRunId) throw new Error('Actor tìm kiếm không trả về runId.');
    const terminal = new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);
    while (!terminal.has(String(run?.status || '').toUpperCase())) {
      if (Date.now() >= deadline) throw Object.assign(new Error('Actor tìm kiếm vượt quá thời gian chờ.'), { name: 'TimeoutError' });
      const waitSeconds = Math.min(20, Math.max(1, Math.floor((deadline - Date.now()) / 1000)));
      const poll = await fetchImpl(`https://api.apify.com/v2/actor-runs/${encodeURIComponent(actorRunId)}?waitForFinish=${waitSeconds}`, {
        headers: { authorization: `Bearer ${credential.token}` },
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now()))
      });
      statusCode = poll.status;
      if (!poll.ok) throw Object.assign(new Error(`Không đọc được trạng thái Actor HTTP ${poll.status}.`), { statusCode: poll.status });
      const pollBody = await poll.json();
      run = pollBody?.data && typeof pollBody.data === 'object' ? pollBody.data : pollBody;
    }
    actualCostMicroUsd = Number.isFinite(Number(run?.usageTotalUsd))
      ? Math.max(0, Math.round(Number(run.usageTotalUsd) * 1_000_000))
      : null;
    if (String(run?.status || '').toUpperCase() !== 'SUCCEEDED') {
      throw Object.assign(new Error(`Actor tìm kiếm kết thúc với trạng thái ${run?.status || 'UNKNOWN'}.`), { statusCode: 502, failureClass: 'actor_run_failed' });
    }
    if (!run?.defaultDatasetId) throw new Error('Actor tìm kiếm không trả về datasetId.');
    const dataset = await fetchImpl(`https://api.apify.com/v2/datasets/${encodeURIComponent(run.defaultDatasetId)}/items?clean=true`, {
      headers: { authorization: `Bearer ${credential.token}` },
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now()))
    });
    statusCode = dataset.status;
    if (!dataset.ok) throw Object.assign(new Error(`Không đọc được dataset tìm kiếm HTTP ${dataset.status}.`), { statusCode: dataset.status });
    const payload = await dataset.json();
    if (!Array.isArray(payload)) throw new Error('Dataset tìm kiếm không hợp lệ.');
    itemCount = payload.length;
    return normalizeActorCandidates(payload, platform);
  } catch (error) {
    failureClass = error?.failureClass || classifyApifyFailure(error?.statusCode, error);
    throw error;
  } finally {
    const costPending = actorStarted && actualCostMicroUsd == null && !failureClass;
    await (options.finalizeCounterpartImpl || finalizeCounterpartCostCredential)(credential, {
      actorId: actorId.replace('~', '/'),
      actorRunId,
      // A successful run can briefly omit its final cost. Keep the reservation
      // pending so the next live usage snapshot reconciles it; never turn the
      // estimate into permanent local spending.
      actualCostMicroUsd: actualCostMicroUsd ?? 0,
      itemCount,
      statusCode,
      failureClass: costPending ? 'cost_pending' : failureClass,
      retryAfterMs: costPending ? 30 * 60 * 1_000 : undefined,
      actorStarted
    }, { fetchImpl: options.redisFetchImpl }).catch(() => null);
  }
}

function safeImageUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const trustedBlob = /\.public\.blob\.vercel-storage\.com$/i.test(url.hostname);
    return url.protocol === 'https:' && (MARKETPLACE_IMAGE_HOST.test(url.hostname) || trustedBlob) ? url.href : '';
  } catch {
    return '';
  }
}

async function fetchImageBuffer(value, options = {}) {
  const imageUrl = safeImageUrl(value);
  if (!imageUrl) throw new Error('Ảnh sản phẩm không thuộc CDN được phép.');
  const availableMs = Number.isFinite(Number(options.deadlineAt))
    ? Number(options.deadlineAt) - Date.now() - DEADLINE_SAFETY_MS
    : 5_500;
  if (availableMs < 1_000) throw Object.assign(new Error('Hết thời gian đối chiếu ảnh.'), { code: 'COUNTERPART_DEADLINE' });
  const response = await (options.fetchImpl || fetch)(imageUrl, {
    headers: { accept: 'image/avif,image/webp,image/jpeg,image/png' },
    redirect: 'follow',
    signal: AbortSignal.timeout(Math.min(5_500, availableMs))
  });
  if (!response.ok) throw new Error(`Không tải được ảnh HTTP ${response.status}`);
  const finalUrl = safeImageUrl(response.url || imageUrl);
  if (!finalUrl) throw new Error('Ảnh chuyển hướng ra ngoài CDN được phép.');
  const size = Number(response.headers.get('content-length')) || 0;
  if (size > MAX_IMAGE_BYTES) throw new Error('Ảnh vượt giới hạn dung lượng.');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error('Ảnh không hợp lệ.');
  return buffer;
}

export async function createImageFingerprint(buffer) {
  const pipeline = sharp(buffer, { failOn: 'warning', limitInputPixels: 24_000_000 }).rotate();
  const metadata = await pipeline.metadata();
  const { data, info } = await pipeline
    .clone()
    .resize(17, 16, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  const hash = [];
  const pixels = [];
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 17; x += 1) {
      const offset = ((y * 17) + x) * channels;
      const red = data[offset] || 0;
      const green = data[offset + 1] ?? red;
      const blue = data[offset + 2] ?? green;
      pixels.push(red, green, blue);
      if (x < 16) {
        const next = offset + channels;
        const gray = (red * 0.299) + (green * 0.587) + (blue * 0.114);
        const nextGray = ((data[next] || 0) * 0.299) + ((data[next + 1] ?? data[next] ?? 0) * 0.587) + ((data[next + 2] ?? data[next + 1] ?? data[next] ?? 0) * 0.114);
        hash.push(gray > nextGray ? 1 : 0);
      }
    }
  }
  return {
    hash,
    pixels,
    ratio: metadata.width && metadata.height ? metadata.width / metadata.height : 1
  };
}

export function compareImageFingerprints(left, right) {
  if (!left?.hash?.length || left.hash.length !== right?.hash?.length) return null;
  let differingBits = 0;
  for (let index = 0; index < left.hash.length; index += 1) differingBits += left.hash[index] === right.hash[index] ? 0 : 1;
  const hashScore = 1 - (differingBits / left.hash.length);
  const pixelLength = Math.min(left.pixels.length, right.pixels.length);
  let pixelDifference = 0;
  for (let index = 0; index < pixelLength; index += 1) pixelDifference += Math.abs(left.pixels[index] - right.pixels[index]);
  const pixelScore = 1 - (pixelDifference / Math.max(1, pixelLength * 255));
  const ratioScore = 1 - Math.min(1, Math.abs(Math.log((left.ratio || 1) / (right.ratio || 1))));
  return clamp((hashScore * 0.62) + (pixelScore * 0.32) + (ratioScore * 0.06));
}

async function mapLimit(items, limit, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return output;
}

function modelTokens(value) {
  const tokens = normalizeText(value).split(' ').filter(Boolean);
  return new Set(tokens.filter((token, index) => {
    if (/[a-z]/.test(token) && /\d/.test(token) && token.length >= 2) return true;
    if (!/^\d{1,4}$/.test(token)) return false;
    const previous = tokens[index - 1] || '';
    const next = tokens[index + 1] || '';
    return MODEL_MARKERS.has(previous) || MODEL_MARKERS.has(next);
  }));
}

function hasModelConflict(sourceTitle, candidateTitle) {
  const source = modelTokens(sourceTitle);
  const candidate = modelTokens(candidateTitle);
  if (!source.size || !candidate.size) return false;
  return ![...source].some((token) => candidate.has(token));
}

export function classifyCounterpartMatch(candidate, sourceTitle) {
  if (!candidate || candidate.imageScore == null || hasModelConflict(sourceTitle, candidate.title)) return 'unverified';
  if (candidate.lensExact && candidate.imageScore >= 0.68 && candidate.textScore >= 0.12) return 'exact';
  if (candidate.imageScore >= 0.80 && candidate.textScore >= 0.18) return 'exact';
  if (candidate.imageScore >= 0.67 && candidate.textScore >= 0.12) return 'variant';
  return 'unverified';
}

export function selectBestCandidate(candidates, sourceTitle) {
  const viable = candidates
    .filter((candidate) => candidate && Number.isFinite(candidate.matchScore))
    .map((candidate) => ({ ...candidate, matchClass: candidate.matchClass || classifyCounterpartMatch(candidate, sourceTitle) }))
    .filter((candidate) => ['exact', 'variant'].includes(candidate.matchClass))
    .filter((candidate) => candidate.matchScore >= 0.58)
    .sort((left, right) => right.matchScore - left.matchScore);
  if (!viable.length) return null;
  const closest = viable[0];
  const eligible = viable.filter((candidate) => {
    if (candidate.reviewCount < MIN_REVIEW_COUNT) return false;
    if (candidate.matchScore < closest.matchScore - 0.10) return false;
    if (candidate.imageScore < closest.imageScore - 0.10) return false;
    return true;
  });
  const selected = eligible[0] || closest;
  return {
    ...selected,
    hasEnoughReviews: selected.reviewCount >= MIN_REVIEW_COUNT,
    minimumReviewCount: MIN_REVIEW_COUNT,
    similarityPercent: Math.round(clamp(selected.matchScore) * 100),
    matchMethod: selected.matchEngine === 'vertex' ? 'google-vertex-image-and-metadata' : 'perceptual-image-and-metadata',
    sourceTitle: String(sourceTitle || '').slice(0, 240)
  };
}

export async function rankCandidatesBySimilarity(source, candidates, options = {}) {
  const sourceTitle = String(source.title || '');
  const prefiltered = candidates
    .map((candidate) => ({ ...candidate, textScore: tokenSimilarity(sourceTitle, candidate.title) }))
    .sort((left, right) => (Number(right.lensExact) - Number(left.lensExact)) || (right.textScore - left.textScore) || (left.searchRank - right.searchRank))
    .slice(0, MAX_CANDIDATES_TO_COMPARE);

  let sourceFingerprint = null;
  let sourceEmbedding = null;
  let sourceBuffer = null;
  try {
    sourceBuffer = await fetchImageBuffer(source.image, options);
    if (isVertexImageEmbeddingConfigured(options.env || process.env)) {
      try { sourceEmbedding = await createVertexImageEmbedding(sourceBuffer, options); } catch { sourceEmbedding = null; }
    }
    sourceFingerprint = await createImageFingerprint(sourceBuffer);
  } catch {
    // A result without verifiable image similarity is intentionally not shown.
  }

  const ranked = await mapLimit(prefiltered, 4, async (candidate) => {
    let imageScore = null;
    let matchEngine = null;
    if (sourceEmbedding || sourceFingerprint) {
      for (const image of candidate.images.slice(0, 1)) {
        try {
          const candidateBuffer = await fetchImageBuffer(image, options);
          let score = null;
          if (sourceEmbedding) {
            try {
              score = cosineSimilarity(sourceEmbedding, await createVertexImageEmbedding(candidateBuffer, options));
              matchEngine = score == null ? null : 'vertex';
            } catch {
              score = null;
            }
          }
          if (score == null && sourceFingerprint) {
            score = compareImageFingerprints(sourceFingerprint, await createImageFingerprint(candidateBuffer));
            matchEngine = score == null ? null : 'perceptual';
          }
          if (score != null && (imageScore == null || score > imageScore)) imageScore = score;
        } catch {
          // One broken image must not discard a valid candidate.
        }
      }
    }
    const searchRankScore = 1 - Math.min(1, (candidate.searchRank - 1) / 30);
    const exactBoost = candidate.lensExact ? 0.025 : 0;
    const matchScore = imageScore == null
      ? 0
      : (imageScore * 0.80) + (candidate.textScore * 0.17) + (searchRankScore * 0.03) + exactBoost;
    return { ...candidate, imageScore, matchEngine, matchScore: clamp(matchScore) };
  });
  return selectBestCandidate(ranked, sourceTitle);
}

export function rankActorCandidatesByMetadata(source, candidates) {
  const ranked = candidates.map((candidate) => {
    const textScore = tokenSimilarity(source.title, candidate.title);
    const searchRankScore = 1 - Math.min(1, (candidate.searchRank - 1) / 30);
    const matchScore = clamp((textScore * 0.92) + (searchRankScore * 0.08));
    const matchClass = textScore >= 0.62 ? 'exact' : textScore >= 0.34 ? 'variant' : 'unverified';
    return {
      ...candidate,
      textScore,
      imageScore: null,
      matchScore,
      matchClass,
      matchEngine: 'actor-metadata'
    };
  })
    .filter((candidate) => ['exact', 'variant'].includes(candidate.matchClass) && candidate.matchScore >= 0.36)
    .sort((left, right) => right.matchScore - left.matchScore);
  if (!ranked.length) return null;
  const closest = ranked[0];
  const eligible = ranked.filter((candidate) => candidate.reviewCount >= MIN_REVIEW_COUNT && candidate.matchScore >= closest.matchScore - 0.10);
  const selected = eligible[0] || closest;
  return {
    ...selected,
    hasEnoughReviews: selected.reviewCount >= MIN_REVIEW_COUNT,
    minimumReviewCount: MIN_REVIEW_COUNT,
    similarityPercent: Math.round(clamp(selected.matchScore) * 100),
    matchMethod: 'actor-metadata-fallback',
    sourceTitle: String(source.title || '').slice(0, 240)
  };
}

function sourceIdentity(source) {
  const platform = normalizePlatform(source.platform);
  const stable = source.itemId || source.productId || source.url || `${source.title}|${source.image}`;
  const imageIdentity = createHash('sha256').update(String(source.image || '')).digest('hex').slice(0, 12);
  return createHash('sha256').update(`${platform}|${stable}|${imageIdentity}`).digest('hex').slice(0, 32);
}

function cacheKey(source) {
  return `realview:counterpart:v3:lens-visual:${sourceIdentity(source)}`;
}

async function readCache(source, options = {}) {
  if (!isRedisConfigured()) return null;
  try {
    const serialized = await redisCommand(['GET', cacheKey(source)], { fetchImpl: options.redisFetchImpl, timeoutMs: 2_000 });
    return serialized ? JSON.parse(serialized) : null;
  } catch {
    return null;
  }
}

async function writeCache(source, value, ttlSeconds, options = {}) {
  if (!isRedisConfigured()) return;
  await redisCommand(['SET', cacheKey(source), JSON.stringify(value), 'EX', String(ttlSeconds)], {
    fetchImpl: options.redisFetchImpl,
    timeoutMs: 2_000
  }).catch(() => null);
}

function sanitizeSource(source = {}) {
  const platform = normalizePlatform(source.platform);
  return {
    platform,
    title: String(source.title || '').trim().slice(0, 240),
    url: validHttpUrl(source.url, platform),
    image: safeImageUrl(source.image),
    itemId: String(source.itemId || '').slice(0, 80),
    productId: String(source.productId || '').slice(0, 80)
  };
}

function shopeeIds(value) {
  try {
    const url = new URL(String(value || ''));
    const productPath = url.pathname.match(/\/product\/(\d+)\/(\d+)/i);
    if (productPath) return { shopId: productPath[1], itemId: productPath[2] };
    const legacy = decodeURIComponent(url.pathname).match(/-i\.(\d+)\.(\d+)(?:$|[/?])/i);
    return legacy ? { shopId: legacy[1], itemId: legacy[2] } : null;
  } catch {
    return null;
  }
}

async function validateShopeeMetadata(candidate, options = {}) {
  const ids = shopeeIds(candidate?.url);
  if (!ids) return candidate;
  try {
    const endpoint = new URL('https://shopee.vn/api/v4/pdp/get_pc');
    endpoint.searchParams.set('shop_id', ids.shopId);
    endpoint.searchParams.set('item_id', ids.itemId);
    const response = await (options.fetchImpl || fetch)(endpoint, {
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 RealViewCounterpart/2.0' },
      signal: AbortSignal.timeout(6_000)
    });
    if (!response.ok) return candidate;
    const body = await response.json();
    const item = body?.data?.item || body?.data || {};
    const images = Array.isArray(item.images) ? item.images.map(shopeeImage).filter(Boolean) : [];
    // Shopee's rating_count array starts with the aggregate total followed by
    // per-star buckets; summing the array would count the same reviews twice.
    const ratingCount = item?.item_rating?.rating_count;
    const reviewCount = parseMarketplaceCount(
      (Array.isArray(ratingCount) ? ratingCount[0] : ratingCount)
      ?? item?.rating_count
    );
    return {
      ...candidate,
      title: String(item.name || candidate.title).slice(0, 240),
      image: images[0] || candidate.image,
      images: images.length ? images.slice(0, 3) : candidate.images,
      reviewCount: reviewCount || candidate.reviewCount,
      rating: Number(item?.item_rating?.rating_star) || candidate.rating,
      shopName: String(item?.shop?.name || candidate.shopName || '').slice(0, 120),
      metadataVerified: true,
      itemId: ids.itemId,
      shopId: ids.shopId
    };
  } catch {
    return candidate;
  }
}

function mergeCandidates(primary, secondary) {
  const byUrl = new Map();
  for (const candidate of [...primary, ...secondary]) {
    const current = byUrl.get(candidate.url);
    if (!current) byUrl.set(candidate.url, candidate);
    else byUrl.set(candidate.url, {
      ...candidate,
      ...current,
      reviewCount: Math.max(Number(current.reviewCount) || 0, Number(candidate.reviewCount) || 0),
      rating: current.rating || candidate.rating,
      shopName: current.shopName || candidate.shopName,
      images: [...new Set([...(current.images || []), ...(candidate.images || [])])].slice(0, 3)
    });
  }
  return [...byUrl.values()];
}

export async function findCounterpart(rawSource, options = {}) {
  const env = options.env || process.env;
  const deadlineAt = Number(options.deadlineAt) || (Date.now() + SEARCH_DEADLINE_MS);
  const scopedOptions = { ...options, deadlineAt };
  if (!envEnabled(env)) return { status: 'disabled' };
  const source = sanitizeSource(rawSource);
  const targetPlatform = targetPlatformFor(source.platform);
  if (!source.platform || !targetPlatform || !source.title || !source.url) {
    return { status: 'unavailable', reason: 'invalid_source' };
  }
  const cached = await readCache(source, scopedOptions);
  if (cached) return { ...cached, cached: true };

  const queries = buildSearchQueries(source.title);
  if (!queries.length) return { status: 'unavailable', reason: 'missing_search_terms' };

  const stage = async (name, detail = {}) => options.onStage?.(name, detail);
  let lensCandidates = [];
  if (source.image && isGoogleLensConfigured(env)) {
    await stage('lens_searching');
    try {
      const lensSearch = options.searchGoogleLensImpl || searchGoogleLens;
      lensCandidates = normalizeActorCandidates(await lensSearch(source.image, targetPlatform, scopedOptions), targetPlatform);
    } catch (error) {
      await stage('lens_failed', { error: String(error?.message || '').slice(0, 160) });
    }
  }

  await stage('image_matching', { candidates: lensCandidates.length });
  let candidate = lensCandidates.length
    ? await (options.rankCandidatesImpl || rankCandidatesBySimilarity)(source, lensCandidates, scopedOptions)
    : null;
  let actorCandidates = [];
  if ((!candidate || Number(candidate.reviewCount) < MIN_REVIEW_COUNT) && deadlineAt - Date.now() > 10_000) {
    await stage('actor_fallback');
    try {
      const actorSearch = options.runSearchActorImpl || runSearchActor;
      actorCandidates = await actorSearch(targetPlatform, queries, scopedOptions);
      candidate = source.image
        ? await (options.rankCandidatesImpl || rankCandidatesBySimilarity)(source, mergeCandidates(lensCandidates, actorCandidates), scopedOptions)
        : (options.rankActorCandidatesImpl || rankActorCandidatesByMetadata)(source, actorCandidates);
      if (!candidate && actorCandidates.length) {
        candidate = (options.rankActorCandidatesImpl || rankActorCandidatesByMetadata)(source, actorCandidates);
      }
    } catch (error) {
      await stage('actor_unavailable', { code: error?.code || '', error: String(error?.message || '').slice(0, 160) });
    }
  }

  if (candidate && targetPlatform === 'Shopee') {
    await stage('metadata_validation');
    candidate = await validateShopeeMetadata(candidate, scopedOptions);
    candidate.hasEnoughReviews = Number(candidate.reviewCount) >= MIN_REVIEW_COUNT;
  }
  const generatedAt = new Date().toISOString();
  const result = candidate
    ? {
        status: 'ready',
        targetPlatform,
        candidate,
        generatedAt,
        discovery: {
          provider: candidate.discoveryMethod?.startsWith('google-lens') ? 'google-lens' : 'actor-fallback',
          visualValidation: candidate.matchMethod,
          metadataVerified: Boolean(candidate.metadataVerified || actorCandidates.some((item) => item.url === candidate.url))
        }
      }
    : { status: 'unavailable', targetPlatform, reason: 'no_verified_visual_match', generatedAt };
  const cacheTtl = candidate
    ? (candidate.hasEnoughReviews ? CACHE_TTL_SECONDS : INSUFFICIENT_CACHE_TTL_SECONDS)
    : EMPTY_CACHE_TTL_SECONDS;
  await writeCache(source, result, cacheTtl, scopedOptions);
  return result;
}

export const counterpartSearchInternals = {
  MIN_REVIEW_COUNT,
  cacheKey,
  safeImageUrl,
  tokenSimilarity
};
