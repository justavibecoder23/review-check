import { createHash } from 'node:crypto';
import { reserveApifyCredential, reserveApifyCredentialSet } from './apify-credential-store.mjs';
import { createProgressReporter } from './sse.mjs';
import { timeoutAbortSignal } from './abort.mjs';

const DEFAULT_ACTOR_ID = 'zen-studio/shopee-product-reviews-scraper';
export const SHOPEE_DEMO_REVIEW_LIMIT = 20;
export const SHOPEE_PRODUCTION_REVIEW_LIMIT = 60;
// Actor chỉ hỗ trợ một mức sao mỗi run. Ba tầng 5★, 3★ và 1★ giữ được
// ba cực tích cực/trung tính/tiêu cực mà không tạo phần giao nhau.
export const SHOPEE_STAR_FILTERS = Object.freeze(['5', '3', '1']);

function actorPath(actorId) {
  return encodeURIComponent(String(actorId || DEFAULT_ACTOR_ID).trim().replace('/', '~'));
}

function compactErrorDetail(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function reviewKey(review) {
  if (review.reviewId !== undefined && review.reviewId !== null && String(review.reviewId)) {
    return `id:${review.reviewId}`;
  }
  return `hash:${createHash('sha256').update([
    review.itemId || '', review.authorId || review.author || '', review.createdAt || '',
    review.ratingStar || '', review.comment || ''
  ].join('|')).digest('hex')}`;
}

function normalizeReview(review) {
  const verificationValue = review.isVerifiedPurchase ?? review.isVerified ?? review.verified;
  return {
    reviewId: review.reviewId !== undefined && review.reviewId !== null ? String(review.reviewId) : null,
    itemId: review.itemId !== undefined && review.itemId !== null ? String(review.itemId) : null,
    authorId: review.authorId !== undefined && review.authorId !== null ? String(review.authorId) : null,
    rating: Number(review.ratingStar) || 0,
    text: String(review.comment || '').trim(),
    date: review.createdAt ? new Date(review.createdAt).toLocaleDateString('vi-VN') : 'Không rõ ngày',
    createdAt: review.createdAt || null,
    // Không được biến dữ liệu thiếu thành “đã xác minh”.
    verified: typeof verificationValue === 'boolean' ? verificationValue : null,
    author: review.author || 'Khách đã mua'
  };
}

async function runUnfiltered({ url, reviewLimit, starFilter, credential, fetchImpl, actorId, timeoutMs, signal }) {
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
        startUrls: [{ url }],
        ...(starFilter ? { starFilter } : {}),
        contentFilter: 'with comments',
        maxReviewsPerProduct: reviewLimit
      }),
      signal: timeoutAbortSignal(timeoutMs, signal)
    });
    if (!response.ok) {
      const detail = compactErrorDetail(await response.text());
      throw Object.assign(
        new Error(`Apify trả về HTTP ${response.status}${detail ? `: ${detail}` : ''}`),
        { statusCode: response.status }
      );
    }
    const items = await response.json();
    if (!Array.isArray(items)) throw new Error('Apify không trả về danh sách review hợp lệ.');
    const written = items.filter((item) => String(item?.comment || '').trim());
    return {
      ok: true,
      credentialId: credential.id,
      credentialLabel: credential.label,
      usageCount: credential.usageCount ?? null,
      reviewCount: written.length,
      latencyMs: Math.round(performance.now() - startedAt),
      items: written
    };
  } catch (error) {
    return {
      ok: false,
      credentialId: credential.id,
      credentialLabel: credential.label,
      usageCount: credential.usageCount ?? null,
      reviewCount: 0,
      latencyMs: Math.round(performance.now() - startedAt),
      statusCode: error?.statusCode || null,
      error: error?.message || 'Không lấy được reviews.',
      items: []
    };
  }
}

async function runStarFilter({ url, star, reviewLimit, credential, fetchImpl, actorId, timeoutMs, signal }) {
  const run = await runUnfiltered({ url, reviewLimit, starFilter: star, credential, fetchImpl, actorId, timeoutMs, signal });
  if (!run.ok) return { ...run, star };
  const matching = run.items.filter((item) => Number(item.ratingStar) === Number(star));
  return {
    ...run,
    star,
    droppedWrongRating: run.items.length - matching.length,
    reviewCount: matching.length,
    items: matching
  };
}

function legacyAllocation(credential) {
  return {
    groupId: credential.id || 'legacy-single-token',
    groupLabel: credential.label || 'legacy-single-token',
    source: credential.source || 'provided',
    maxUsesPerKey: null,
    retiresAfterReservation: false,
    reservedAt: null,
    warnings: credential.warnings || [],
    credential: { ...credential, usageCount: credential.usageCount ?? null }
  };
}

function validateAllocation(allocation) {
  if (!allocation?.credential?.token) throw new Error('Không có Apify key khả dụng.');
  return allocation;
}

function validateCredentialSet(credentialSet) {
  const credentials = Array.isArray(credentialSet?.credentials) ? credentialSet.credentials : [];
  const byStar = new Map(credentials.map((credential) => [String(credential.star), credential]));
  if (credentials.length !== SHOPEE_STAR_FILTERS.length || SHOPEE_STAR_FILTERS.some((star) => !byStar.get(star)?.token)) {
    throw new Error('Cần đủ 3 Apify key để chạy chế độ Shopee 60 review có lọc sao.');
  }
  return { ...credentialSet, credentials: SHOPEE_STAR_FILTERS.map((star) => byStar.get(star)) };
}

async function collectShopeeReviewsDemo(url, options = {}) {
  const progress = createProgressReporter(options.onProgress);
  const reviewLimit = Math.min(SHOPEE_DEMO_REVIEW_LIMIT, Math.max(1, Number.parseInt(String(options.reviewLimit ?? process.env.SHOPEE_REVIEW_LIMIT ?? SHOPEE_DEMO_REVIEW_LIMIT), 10) || SHOPEE_DEMO_REVIEW_LIMIT));
  const allocation = validateAllocation(options.allocation
    || (options.credential ? legacyAllocation(options.credential) : await reserveApifyCredential({ fetchImpl: options.redisFetchImpl })));
  const credential = allocation.credential;
  const fetchImpl = options.fetchImpl || fetch;
  const actorId = options.actorId || process.env.APIFY_ACTOR_ID || DEFAULT_ACTOR_ID;
  const configuredTimeout = Number(options.timeoutMs ?? process.env.APIFY_RUN_TIMEOUT_MS ?? 70_000);
  const timeoutMs = Number.isFinite(configuredTimeout)
    ? Math.min(110_000, Math.max(10_000, configuredTimeout))
    : 70_000;
  const startedAt = performance.now();

  const run = await runUnfiltered({ url, reviewLimit, credential, fetchImpl, actorId, timeoutMs, signal: options.signal });
  progress('collecting', 58, 'Đang lấy reviews...');
  const runs = [run];
  const successful = runs.filter((run) => run.ok);
  const usage = {
    provider: allocation.source,
    tracked: allocation.source === 'redis-vault',
    groupId: allocation.groupId,
    maxUsesPerKey: allocation.maxUsesPerKey,
    credentials: [{ id: credential.id, label: credential.label, usageCount: credential.usageCount }]
  };
  if (!successful.length) {
    const quotaFailure = runs.find((run) => [402, 403, 429].includes(run.statusCode));
    const detail = run.error;
    const error = new Error(quotaFailure
      ? `Apify key đang dùng không còn quyền/hạn mức hoặc đang bị giới hạn. ${detail}`
      : `Không lấy được reviews từ Apify. ${detail}`);
    error.statusCode = 502;
    throw error;
  }

  const seen = new Set();
  const deduplicated = [];
  let duplicateCount = 0;
  for (const run of runs) {
    for (const rawReview of run.items) {
      const key = reviewKey(rawReview);
      if (seen.has(key)) {
        duplicateCount += 1;
        continue;
      }
      seen.add(key);
      deduplicated.push(normalizeReview(rawReview));
    }
  }

  const warnings = [...(allocation.warnings || [])];
  if (allocation.retiresAfterReservation) {
    warnings.push(`Apify key đang dùng vừa hoàn tất lượt ${allocation.maxUsesPerKey}; lượt kế tiếp sẽ tự chuyển sang key dự phòng.`);
  }
  for (const run of runs.filter((item) => !item.ok)) warnings.push(run.error);
  if (duplicateCount) warnings.push(`Đã loại ${duplicateCount} review trùng trong dữ liệu trả về.`);

  const firstItem = successful.find((run) => run.items.length)?.items[0] || null;
  return {
    reviews: deduplicated,
    productMetaSource: firstItem,
    warnings,
    credential: {
      groupId: allocation.groupId,
      label: allocation.groupLabel,
      source: allocation.source,
      retiresAfterReservation: allocation.retiresAfterReservation,
      keys: [{ id: credential.id, label: credential.label, usageCount: credential.usageCount }]
    },
    usage,
    collection: {
      strategy: 'single-unfiltered',
      contentFilter: 'with comments',
      reviewLimit,
      targetMaximum: reviewLimit,
      returned: deduplicated.length,
      duplicateCount,
      latencyMs: Math.round(performance.now() - startedAt),
      runs: runs.map(({ items: _items, error, ...run }) => ({ ...run, ...(error ? { error } : {}) }))
    }
  };
}

async function collectShopeeReviewsProduction(url, options = {}) {
  const progress = createProgressReporter(options.onProgress);
  const perStarLimit = SHOPEE_PRODUCTION_REVIEW_LIMIT / SHOPEE_STAR_FILTERS.length;
  const credentialSet = validateCredentialSet(options.credentialSet || await reserveApifyCredentialSet({
    count: SHOPEE_STAR_FILTERS.length,
    stars: SHOPEE_STAR_FILTERS.map(Number),
    fetchImpl: options.redisFetchImpl
  }));
  const fetchImpl = options.fetchImpl || fetch;
  const actorId = options.actorId || process.env.APIFY_ACTOR_ID || DEFAULT_ACTOR_ID;
  const configuredTimeout = Number(options.timeoutMs ?? process.env.APIFY_RUN_TIMEOUT_MS ?? 70_000);
  const timeoutMs = Number.isFinite(configuredTimeout) ? Math.min(110_000, Math.max(10_000, configuredTimeout)) : 70_000;
  const startedAt = performance.now();
  const runs = await Promise.all(credentialSet.credentials.map((credential) => runStarFilter({
    url,
    star: String(credential.star),
    reviewLimit: perStarLimit,
    credential,
    fetchImpl,
    actorId,
    timeoutMs,
    signal: options.signal
  })));
  progress('collecting', 58, 'Đang lấy reviews...');
  const successful = runs.filter((run) => run.ok);
  if (!successful.length) {
    const detail = runs.map((run) => `${run.star}★: ${run.error}`).join(' | ');
    const error = new Error(`Không lấy được reviews Shopee từ 3 nhóm sao. ${detail}`);
    error.statusCode = 502;
    throw error;
  }

  const seen = new Set();
  const deduplicated = [];
  let duplicateCount = 0;
  for (const run of runs) {
    for (const rawReview of run.items) {
      const key = reviewKey(rawReview);
      if (seen.has(key)) {
        duplicateCount += 1;
        continue;
      }
      seen.add(key);
      if (deduplicated.length < SHOPEE_PRODUCTION_REVIEW_LIMIT) deduplicated.push(normalizeReview(rawReview));
    }
  }

  const warnings = [...(credentialSet.warnings || [])];
  for (const run of runs.filter((item) => !item.ok)) warnings.push(run.error);
  const wrongRatingCount = runs.reduce((sum, run) => sum + (run.droppedWrongRating || 0), 0);
  if (wrongRatingCount) warnings.push(`Đã bỏ ${wrongRatingCount} review không khớp bộ lọc sao.`);
  if (duplicateCount) warnings.push(`Đã loại ${duplicateCount} review trùng giữa các lượt lấy dữ liệu.`);
  const firstItem = successful.find((run) => run.items.length)?.items[0] || null;
  return {
    reviews: deduplicated,
    productMetaSource: firstItem,
    warnings,
    credential: {
      groupId: credentialSet.groupId,
      label: credentialSet.groupLabel,
      source: credentialSet.source,
      retiresAfterReservation: credentialSet.retiresAfterReservation,
      keys: credentialSet.credentials.map(({ id, label, star, usageCount }) => ({ id, label, star, usageCount }))
    },
    usage: {
      provider: credentialSet.source,
      tracked: credentialSet.source === 'redis-vault',
      groupId: credentialSet.groupId,
      maxUsesPerKey: credentialSet.maxUsesPerKey,
      credentials: credentialSet.credentials.map(({ id, label, star, usageCount }) => ({ id, label, star, usageCount }))
    },
    collection: {
      strategy: 'parallel-star-filters',
      ratingStrata: SHOPEE_STAR_FILTERS.map(Number).sort((a, b) => a - b),
      contentFilter: 'with comments',
      filters: [...SHOPEE_STAR_FILTERS],
      perStarLimit,
      targetMaximum: SHOPEE_PRODUCTION_REVIEW_LIMIT,
      returned: deduplicated.length,
      duplicateCount,
      latencyMs: Math.round(performance.now() - startedAt),
      runs: runs.map(({ items: _items, error, ...run }) => ({ ...run, ...(error ? { error } : {}) }))
    }
  };
}

export async function collectShopeeReviews(url, options = {}) {
  // Website luôn dùng thiết kế production 60 review. Chế độ demo chỉ còn là
  // tùy chọn tường minh cho test/local, tránh một env cũ vô tình kéo production
  // trở lại một account và 20 review.
  const mode = String(options.mode || 'production-60').toLowerCase();
  return mode === 'demo'
    ? collectShopeeReviewsDemo(url, options)
    : collectShopeeReviewsProduction(url, options);
}
