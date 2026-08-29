import { createHash } from 'node:crypto';
import { reserveApifyCredential } from './apify-credential-store.mjs';
import { createProgressReporter } from './sse.mjs';

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

async function runUnfiltered({ url, reviewLimit, credential, fetchImpl, actorId, timeoutMs }) {
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
        contentFilter: 'with comments',
        maxReviewsPerProduct: reviewLimit
      }),
      signal: AbortSignal.timeout(timeoutMs)
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

export async function collectShopeeReviews(url, options = {}) {
  const progress = createProgressReporter(options.onProgress);
  const reviewLimit = Math.min(20, Math.max(1, Number.parseInt(String(options.reviewLimit ?? process.env.SHOPEE_REVIEW_LIMIT ?? 20), 10) || 20));
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

  const run = await runUnfiltered({ url, reviewLimit, credential, fetchImpl, actorId, timeoutMs });
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
