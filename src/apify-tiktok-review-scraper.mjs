import { createHash } from 'node:crypto';
import { finalizeTikTokCredential, reserveTikTokCredentials } from './apify-credential-store.mjs';
import { createProgressReporter } from './sse.mjs';

const DEFAULT_ACTOR_ID = 'web_wanderer/tiktok-reviews-scraper';
const MAX_REVIEWS = 100;
const STAR_FILTERS = Object.freeze(['5_star', '4_star', '3_star', '2_star', '1_star']);
const REVIEWS_PER_STAR = MAX_REVIEWS / STAR_FILTERS.length;

function actorPath(actorId) {
  return encodeURIComponent(String(actorId || DEFAULT_ACTOR_ID).trim().replace('/', '~'));
}

function compactErrorDetail(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function reviewKey(review) {
  const id = review?.review_id ?? review?.reviewId;
  if (id !== undefined && id !== null && String(id)) return `id:${id}`;
  return `hash:${createHash('sha256').update([
    review?.product_id || '', review?.reviewer_id || review?.reviewer_name || '', review?.review_time || '',
    review?.review_rating || '', review?.review_text || ''
  ].join('|')).digest('hex')}`;
}

function normalizeCreatedAt(value) {
  if (value === undefined || value === null || value === '') return null;
  const raw = String(value).trim();
  const timestamp = /^\d{10,13}$/.test(raw)
    ? Number(raw) * (raw.length <= 10 ? 1000 : 1)
    : raw;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeReview(review, productId) {
  const createdAt = normalizeCreatedAt(review.review_time);
  return {
    reviewId: review.review_id !== undefined && review.review_id !== null ? String(review.review_id) : null,
    itemId: review.product_id !== undefined && review.product_id !== null ? String(review.product_id) : String(productId),
    authorId: review.reviewer_id !== undefined && review.reviewer_id !== null ? String(review.reviewer_id) : null,
    rating: Number(review.review_rating) || 0,
    text: String(review.review_text || '').trim(),
    date: createdAt ? new Date(createdAt).toLocaleDateString('vi-VN') : 'Không rõ ngày',
    createdAt,
    verified: Boolean(review.is_verified_purchase),
    author: review.reviewer_name || review.user_name || 'Khách đã mua'
  };
}

async function runActor({ productId, reviewLimit, reviewFilter, credential, fetchImpl, actorId, timeoutMs }) {
  const startedAt = performance.now();
  const endpoint = `https://api.apify.com/v2/acts/${actorPath(actorId)}/run-sync-get-dataset-items`;
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        region: 'VN',
        product_ids: [String(productId)],
        reviews_limit: reviewLimit,
        reviews_filter: reviewFilter,
        reviews_sort: 'recommended',
        include_personal_information: false
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      const detail = compactErrorDetail(await response.text());
      throw Object.assign(new Error(`Apify trả về HTTP ${response.status}${detail ? `: ${detail}` : ''}`), {
        statusCode: response.status
      });
    }
    const items = await response.json();
    if (!Array.isArray(items)) throw new Error('Apify không trả về danh sách review TikTok hợp lệ.');
    return {
      ok: true,
      credentialId: credential.id,
      credentialLabel: credential.label,
      runCount: credential.runCount ?? null,
      filter: reviewFilter,
      requested: reviewLimit,
      billedReviewCount: items.length,
      reviewCount: items.filter((item) => String(item?.review_text || '').trim()).length,
      latencyMs: Math.round(performance.now() - startedAt),
      items
    };
  } catch (error) {
    return {
      ok: false,
      credentialId: credential.id,
      credentialLabel: credential.label,
      runCount: credential.runCount ?? null,
      filter: reviewFilter,
      requested: reviewLimit,
      billedReviewCount: 0,
      reviewCount: 0,
      latencyMs: Math.round(performance.now() - startedAt),
      statusCode: error?.statusCode || null,
      error: error?.message || 'Không lấy được reviews TikTok.',
      items: []
    };
  }
}

async function allocate(options) {
  if (options.allocation) return { allocation: options.allocation, strategy: options.allocation.credentials.length === 5 ? 'parallel-star-filters' : 'single-unfiltered' };
  try {
    return {
      allocation: await reserveTikTokCredentials({
        count: 5,
        reviewsPerCredential: REVIEWS_PER_STAR,
        fetchImpl: options.redisFetchImpl,
        maxReviewsPerKey: options.maxReviewsPerKey
      }),
      strategy: 'parallel-star-filters'
    };
  } catch (error) {
    if (error?.code !== 'INSUFFICIENT_KEYS') throw error;
    return {
      allocation: await reserveTikTokCredentials({
        count: 1,
        reviewsPerCredential: MAX_REVIEWS,
        fetchImpl: options.redisFetchImpl,
        maxReviewsPerKey: options.maxReviewsPerKey
      }),
      strategy: 'single-unfiltered'
    };
  }
}

export async function collectTikTokReviews(productId, options = {}) {
  if (!/^\d{8,25}$/.test(String(productId || ''))) throw new Error('Mã sản phẩm TikTok Shop không hợp lệ.');
  const progress = createProgressReporter(options.onProgress);
  const { allocation, strategy } = await allocate(options);
  if (!allocation?.credentials?.length) throw new Error('Không có Apify key khả dụng cho TikTok.');
  const fetchImpl = options.fetchImpl || fetch;
  const actorId = options.actorId || process.env.APIFY_TIKTOK_ACTOR_ID || DEFAULT_ACTOR_ID;
  const configuredTimeout = Number(options.timeoutMs ?? process.env.APIFY_RUN_TIMEOUT_MS ?? 70_000);
  const timeoutMs = Number.isFinite(configuredTimeout) ? Math.min(110_000, Math.max(10_000, configuredTimeout)) : 70_000;
  const startedAt = performance.now();
  const runs = await Promise.all(allocation.credentials.map((credential, index) => runActor({
    productId,
    reviewLimit: Math.min(credential.plannedReviews || (strategy === 'parallel-star-filters' ? REVIEWS_PER_STAR : MAX_REVIEWS), MAX_REVIEWS),
    reviewFilter: strategy === 'parallel-star-filters' ? STAR_FILTERS[index] : 'all',
    credential,
    fetchImpl,
    actorId,
    timeoutMs
  })));

  if (allocation.source === 'redis-vault') {
    await Promise.allSettled(runs.map((run, index) => (options.finalizeImpl || finalizeTikTokCredential)(
      allocation.credentials[index],
      {
        reviewCount: run.billedReviewCount,
        quotaExhausted: [402, 403, 429].includes(run.statusCode)
      },
      { fetchImpl: options.redisFetchImpl, maxReviewsPerKey: options.maxReviewsPerKey }
    )));
  }

  progress('collecting', 58, 'Đang lấy reviews...');
  const successful = runs.filter((run) => run.ok);
  if (!successful.length) {
    const quotaFailure = runs.find((run) => [402, 403, 429].includes(run.statusCode));
    const detail = runs[0]?.error || 'Không có dữ liệu trả về.';
    const error = new Error(quotaFailure
      ? `Apify key TikTok không còn quyền/hạn mức hoặc đang bị giới hạn. ${detail}`
      : `Không lấy được reviews TikTok từ Apify. ${detail}`);
    error.statusCode = 502;
    throw error;
  }

  const seen = new Set();
  const deduplicated = [];
  let duplicateCount = 0;
  let emptyCommentCount = 0;
  for (const run of runs) {
    for (const rawReview of run.items) {
      if (!String(rawReview?.review_text || '').trim()) {
        emptyCommentCount += 1;
        continue;
      }
      const key = reviewKey(rawReview);
      if (seen.has(key)) {
        duplicateCount += 1;
        continue;
      }
      seen.add(key);
      if (deduplicated.length < MAX_REVIEWS) deduplicated.push(normalizeReview(rawReview, productId));
    }
  }

  const warnings = [];
  for (const run of runs.filter((run) => !run.ok)) warnings.push(run.error);
  if (emptyCommentCount) warnings.push(`Đã bỏ ${emptyCommentCount} review TikTok không có bình luận viết.`);
  if (duplicateCount) warnings.push(`Đã loại ${duplicateCount} review TikTok trùng trong dữ liệu trả về.`);
  if (strategy === 'single-unfiltered') warnings.push('TikTok đang dùng một key không lọc sao vì không còn đủ 5 key có hạn mức để chia mẫu an toàn.');

  const firstItem = successful.find((run) => run.items.length)?.items[0] || null;
  return {
    reviews: deduplicated,
    productMetaSource: firstItem,
    productMeta: firstItem?.product_name ? { title: String(firstItem.product_name) } : {},
    warnings,
    credential: {
      source: allocation.source,
      keys: allocation.credentials.map(({ id, label, runCount, reviewCount, plannedReviews }) => ({
        id, label, runCount, reviewCount, plannedReviews
      }))
    },
    usage: {
      provider: allocation.source,
      tracked: allocation.source === 'redis-vault',
      platform: 'tiktok',
      maxReviewsPerKey: allocation.maxReviewsPerKey,
      credentials: allocation.credentials.map(({ id, label, runCount, reviewCount, plannedReviews }) => ({
        id, label, runCount, reviewCount, plannedReviews
      }))
    },
    collection: {
      strategy,
      filters: strategy === 'parallel-star-filters' ? STAR_FILTERS : ['all'],
      writtenCommentsOnly: true,
      perStarLimit: strategy === 'parallel-star-filters' ? REVIEWS_PER_STAR : null,
      targetMaximum: MAX_REVIEWS,
      returned: deduplicated.length,
      duplicateCount,
      emptyCommentCount,
      latencyMs: Math.round(performance.now() - startedAt),
      runs: runs.map(({ items: _items, error, ...run }) => ({ ...run, ...(error ? { error } : {}) }))
    }
  };
}
