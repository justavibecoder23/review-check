import { createHash } from 'node:crypto';
import { reserveApifyCredentialSet } from './apify-credential-store.mjs';

export const SHOPEE_STAR_FILTERS = Object.freeze(['5', '4', '3', '2', '1']);
const DEFAULT_ACTOR_ID = 'zen-studio/shopee-product-reviews-scraper';

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
  return {
    reviewId: review.reviewId !== undefined && review.reviewId !== null ? String(review.reviewId) : null,
    itemId: review.itemId !== undefined && review.itemId !== null ? String(review.itemId) : null,
    authorId: review.authorId !== undefined && review.authorId !== null ? String(review.authorId) : null,
    rating: Number(review.ratingStar) || 0,
    text: String(review.comment || '').trim(),
    date: review.createdAt ? new Date(review.createdAt).toLocaleDateString('vi-VN') : 'Không rõ ngày',
    createdAt: review.createdAt || null,
    verified: true,
    author: review.author || 'Khách đã mua'
  };
}

async function runStarFilter({ url, star, perStarLimit, credential, fetchImpl, actorId, timeoutMs }) {
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
        starFilter: star,
        contentFilter: 'with comments',
        maxReviewsPerProduct: perStarLimit
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      const detail = compactErrorDetail(await response.text());
      throw Object.assign(
        new Error(`Apify ${star} sao trả về HTTP ${response.status}${detail ? `: ${detail}` : ''}`),
        { statusCode: response.status }
      );
    }
    const items = await response.json();
    if (!Array.isArray(items)) throw new Error(`Apify ${star} sao không trả về danh sách review hợp lệ.`);
    const written = items.filter((item) => String(item?.comment || '').trim());
    const matching = written.filter((item) => Number(item.ratingStar) === Number(star));
    return {
      ok: true,
      star,
      credentialId: credential.id,
      credentialLabel: credential.label,
      usageCount: credential.usageCount ?? null,
      reviewCount: matching.length,
      droppedWrongRating: written.length - matching.length,
      latencyMs: Math.round(performance.now() - startedAt),
      items: matching
    };
  } catch (error) {
    return {
      ok: false,
      star,
      credentialId: credential.id,
      credentialLabel: credential.label,
      usageCount: credential.usageCount ?? null,
      reviewCount: 0,
      droppedWrongRating: 0,
      latencyMs: Math.round(performance.now() - startedAt),
      statusCode: error?.statusCode || null,
      error: error?.message || `Không cào được review ${star} sao.`,
      items: []
    };
  }
}

function legacyCredentialSet(credential) {
  return {
    groupId: credential.id || 'legacy-single-token',
    groupLabel: credential.label || 'legacy-single-token',
    source: credential.source || 'provided',
    maxUsesPerKey: null,
    retiresAfterReservation: false,
    reservedAt: null,
    warnings: credential.warnings || [],
    credentials: SHOPEE_STAR_FILTERS.map((star) => ({ ...credential, star: Number(star), usageCount: null }))
  };
}

function validateCredentialSet(credentialSet) {
  const credentials = Array.isArray(credentialSet?.credentials) ? credentialSet.credentials : [];
  const byStar = new Map(credentials.map((credential) => [String(credential.star), credential]));
  if (credentials.length !== SHOPEE_STAR_FILTERS.length || SHOPEE_STAR_FILTERS.some((star) => !byStar.get(star)?.token)) {
    throw new Error('Nhóm Apify được cấp phát không có đủ 5 key cho 5★, 4★, 3★, 2★ và 1★.');
  }
  return { ...credentialSet, credentials: SHOPEE_STAR_FILTERS.map((star) => byStar.get(star)) };
}

export async function collectShopeeReviewsParallel(url, options = {}) {
  const perStarLimit = Math.min(20, Math.max(1, Number.parseInt(String(options.perStarLimit ?? process.env.SHOPEE_REVIEWS_PER_STAR ?? 20), 10) || 20));
  const credentialSet = validateCredentialSet(options.credentialSet
    || (options.credential ? legacyCredentialSet(options.credential) : await reserveApifyCredentialSet({ fetchImpl: options.redisFetchImpl })));
  const fetchImpl = options.fetchImpl || fetch;
  const actorId = options.actorId || process.env.APIFY_ACTOR_ID || DEFAULT_ACTOR_ID;
  const configuredTimeout = Number(options.timeoutMs ?? process.env.APIFY_RUN_TIMEOUT_MS ?? 70_000);
  const timeoutMs = Number.isFinite(configuredTimeout)
    ? Math.min(110_000, Math.max(10_000, configuredTimeout))
    : 70_000;
  const startedAt = performance.now();

  // Cả năm run được khởi động trước khi await để latency gần với run chậm nhất.
  const runs = await Promise.all(credentialSet.credentials.map((credential) => runStarFilter({
    url, star: String(credential.star), perStarLimit, credential, fetchImpl, actorId, timeoutMs
  })));
  const successful = runs.filter((run) => run.ok);
  const usage = {
    provider: credentialSet.source,
    tracked: credentialSet.source === 'redis-vault',
    groupId: credentialSet.groupId,
    maxUsesPerKey: credentialSet.maxUsesPerKey,
    credentials: credentialSet.credentials.map(({ id, label, star, usageCount }) => ({ id, label, star, usageCount }))
  };
  if (!successful.length) {
    const quotaFailure = runs.find((run) => [402, 403, 429].includes(run.statusCode));
    const detail = runs.map((run) => `${run.star}★: ${run.error}`).join(' | ');
    const error = new Error(quotaFailure
      ? `Một hoặc nhiều key trong nhóm Apify “${credentialSet.groupLabel}” không còn quyền/hạn mức hoặc đang bị giới hạn. ${detail}`
      : `Cả 5 Apify runs đều thất bại. ${detail}`);
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

  const warnings = [...(credentialSet.warnings || [])];
  if (credentialSet.retiresAfterReservation) {
    warnings.push(`Nhóm Apify “${credentialSet.groupLabel}” vừa hoàn tất lượt ${credentialSet.maxUsesPerKey} và đã được đưa vào danh sách used; lượt kế tiếp sẽ dùng nhóm dự phòng.`);
  }
  for (const run of runs.filter((item) => !item.ok)) warnings.push(run.error);
  const wrongRatingCount = runs.reduce((sum, run) => sum + run.droppedWrongRating, 0);
  if (wrongRatingCount) warnings.push(`Đã bỏ ${wrongRatingCount} review không khớp starFilter do upstream trả sai nhóm.`);
  if (duplicateCount) warnings.push(`Đã loại ${duplicateCount} review trùng giữa các Apify runs.`);

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
    usage,
    collection: {
      strategy: 'parallel-star-filters',
      contentFilter: 'with comments',
      perStarLimit,
      targetMaximum: perStarLimit * SHOPEE_STAR_FILTERS.length,
      returned: deduplicated.length,
      duplicateCount,
      latencyMs: Math.round(performance.now() - startedAt),
      runs: runs.map(({ items: _items, error, ...run }) => ({ ...run, ...(error ? { error } : {}) }))
    }
  };
}
