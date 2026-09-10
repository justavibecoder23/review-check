import { isRedisConfigured, redisCommand, redisTransaction } from './redis-rest.mjs';

export const SHOPEE_CACHE_TTL_SECONDS = 5 * 24 * 60 * 60;
export const TIKTOK_CACHE_TTL_SECONDS = 5 * 24 * 60 * 60;
export const SHOPEE_CACHE_HITS_KEY = 'realview:shopee:cache:hits';
export const SHOPEE_TOTAL_SERVED_KEY = 'realview:shopee:total_served';
const MAX_DATASET_BYTES = 5 * 1024 * 1024;
const TIKTOK_DATASET_PREFIX = 'review-datasets/';
const TIKTOK_RAW_DATASET_PATTERN = /\/tiktok-[^/]+\/[^/]+\/reviews\.raw\.json$/u;
const MIN_TIKTOK_FALLBACK_REVIEWS = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

export function isShopeeCacheEligible(platform) {
  return String(platform || '').trim().toLowerCase() === 'shopee';
}

export function getShopeeCacheKey(itemId) {
  const normalized = String(itemId || '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error('Shopee itemId không hợp lệ cho cache.');
  return `realview:cache:product:shopee:${normalized}`;
}

export function getTikTokCacheKey(productId) {
  const normalized = String(productId || '').trim();
  if (!/^\d{8,25}$/.test(normalized)) throw new Error('TikTok productId không hợp lệ cho cache.');
  return `realview:cache:product:tiktok:${normalized}`;
}

function parseDate(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizedRatingStrata(collection = {}) {
  return [...new Set((Array.isArray(collection.ratingStrata) ? collection.ratingStrata : [])
    .map(Number)
    .filter((rating) => Number.isInteger(rating)))]
    .sort((left, right) => left - right);
}

export function validateShopeeCachedDataset(dataset, options = {}) {
  if (!dataset || typeof dataset !== 'object') return { valid: false, reason: 'INVALID_DATASET' };
  const expectedItemId = String(options.itemId || '').trim();
  const datasetItemId = String(dataset.product?.itemId || '').trim();
  if (!isShopeeCacheEligible(dataset.product?.platform)) return { valid: false, reason: 'NOT_SHOPEE' };
  if (expectedItemId && datasetItemId !== expectedItemId) return { valid: false, reason: 'ITEM_ID_MISMATCH' };
  if (!Array.isArray(dataset.reviews)) return { valid: false, reason: 'REVIEWS_MISSING' };

  const collection = dataset.source?.collection || {};
  if (collection.strategy !== 'parallel-star-filters') return { valid: false, reason: 'WRONG_STRATEGY' };
  if (JSON.stringify(normalizedRatingStrata(collection)) !== JSON.stringify([1, 2, 3, 4, 5])) {
    return { valid: false, reason: 'INCOMPLETE_RATING_STRATA' };
  }
  if (Number(collection.targetMaximum) !== 100) return { valid: false, reason: 'WRONG_TARGET_MAXIMUM' };

  const createdAtMs = parseDate(dataset.createdAt);
  const nowMs = (options.now instanceof Date ? options.now : new Date(options.now || Date.now())).getTime();
  if (!Number.isFinite(nowMs) || createdAtMs === null || createdAtMs > nowMs) {
    return { valid: false, reason: 'INVALID_CREATED_AT' };
  }
  const ageMs = nowMs - createdAtMs;
  const maxAgeMs = SHOPEE_CACHE_TTL_SECONDS * 1000;
  if (ageMs > maxAgeMs) return { valid: false, reason: 'EXPIRED' };

  return {
    valid: true,
    ageMs,
    ttlSeconds: Math.max(1, Math.ceil((maxAgeMs - ageMs) / 1000))
  };
}

export function validateTikTokCachedDataset(dataset, options = {}) {
  if (!dataset || typeof dataset !== 'object') return { valid: false, reason: 'INVALID_DATASET' };
  const expectedProductId = String(options.productId || '').trim();
  const datasetProductId = String(dataset.product?.productId || '').trim();
  if (String(dataset.product?.platform || '').trim().toLowerCase() !== 'tiktok shop') {
    return { valid: false, reason: 'NOT_TIKTOK' };
  }
  if (dataset.datasetKind !== 'raw-reviews') return { valid: false, reason: 'NOT_RAW_DATASET' };
  if (expectedProductId && datasetProductId !== expectedProductId) {
    return { valid: false, reason: 'PRODUCT_ID_MISMATCH' };
  }
  if (!Array.isArray(dataset.reviews)) return { valid: false, reason: 'REVIEWS_MISSING' };
  const minimumReviews = Math.max(1, Number.parseInt(options.minimumReviews, 10) || MIN_TIKTOK_FALLBACK_REVIEWS);
  const reviewsWithText = dataset.reviews.filter((review) => String(review?.text || '').trim()).length;
  if (reviewsWithText < minimumReviews) return { valid: false, reason: 'INSUFFICIENT_REVIEWS' };

  const createdAtMs = parseDate(dataset.createdAt);
  const nowMs = (options.now instanceof Date ? options.now : new Date(options.now || Date.now())).getTime();
  if (!Number.isFinite(nowMs) || createdAtMs === null || createdAtMs > nowMs) {
    return { valid: false, reason: 'INVALID_CREATED_AT' };
  }
  const ageMs = nowMs - createdAtMs;
  const maxAgeMs = TIKTOK_CACHE_TTL_SECONDS * 1000;
  if (ageMs > maxAgeMs) return { valid: false, reason: 'EXPIRED' };
  return {
    valid: true,
    ageMs,
    reviewCount: reviewsWithText,
    ttlSeconds: Math.max(1, Math.ceil((maxAgeMs - ageMs) / 1000))
  };
}

async function blobResultText(result) {
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  if (Number(result.blob?.size) > MAX_DATASET_BYTES) return null;
  return new Response(result.stream).text();
}

export async function readPrivateBlobDataset(blobLocation, options = {}) {
  const pathname = String(blobLocation?.rawPath || blobLocation?.pathname || '').trim();
  const url = String(blobLocation?.rawUrl || blobLocation?.url || '').trim();
  const locator = pathname || url;
  if (!locator) return null;
  try {
    const getBlob = options.blobGetImpl || (await import('@vercel/blob')).get;
    const result = await getBlob(locator, {
      access: 'private',
      token: options.blobToken || process.env.BLOB_READ_WRITE_TOKEN
    });
    const text = await blobResultText(result);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function recentDatasetPrefixes(now = new Date()) {
  const prefixes = [];
  for (let offset = 0; offset <= 5; offset += 1) {
    prefixes.push(`${TIKTOK_DATASET_PREFIX}${new Date(now.getTime() - offset * DAY_MS).toISOString().slice(0, 10).replaceAll('-', '/')}/`);
  }
  return prefixes;
}

async function listAllBlobs(listBlobs, prefix, token) {
  const blobs = [];
  let cursor;
  do {
    const result = await listBlobs({ prefix, cursor, token, limit: 1000 });
    blobs.push(...(Array.isArray(result?.blobs) ? result.blobs : []));
    cursor = result?.hasMore ? result.cursor : undefined;
  } while (cursor);
  return blobs;
}

/**
 * TikTok exact-product fallback. It is intentionally independent from the
 * Shopee Redis cache and never substitutes a dataset from another product.
 */
export async function getFallbackTikTokDataset(productId, options = {}) {
  const normalizedProductId = String(productId || '').trim();
  if (!/^\d{8,25}$/.test(normalizedProductId)) return null;
  const token = options.blobToken || process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;

  try {
    const listBlobs = options.blobListImpl || (await import('@vercel/blob')).list;
    const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    const pages = await Promise.all(recentDatasetPrefixes(now).map((prefix) => listAllBlobs(listBlobs, prefix, token)));
    const blobs = [...new Map(pages.flat()
      .filter((blob) => TIKTOK_RAW_DATASET_PATTERN.test(String(blob?.pathname || '')))
      .map((blob) => [blob.pathname, blob])).values()]
      .sort((left, right) => (
        (Date.parse(String(right?.uploadedAt || '')) || 0)
        - (Date.parse(String(left?.uploadedAt || '')) || 0)
      ));
    if (!blobs.length) return null;

    const productSegment = `/tiktok-${normalizedProductId}/`;
    // Never substitute reviews from another product. A cross-product demo can
    // look like a successful analysis while silently returning false evidence.
    const candidates = blobs.filter((blob) => String(blob.pathname).includes(productSegment));
    for (const blob of candidates) {
      const dataset = await readPrivateBlobDataset({
        rawPath: blob.pathname,
        rawUrl: blob.url
      }, options);
      const validation = validateTikTokCachedDataset(dataset, {
        productId: normalizedProductId,
        minimumReviews: options.minimumReviews,
        now
      });
      if (!validation.valid) continue;
      return {
        dataset,
        validation,
        isExactMatch: true,
        blobPath: blob.pathname
      };
    }
    return null;
  } catch {
    // Fallback failure must never replace the existing live collection error.
    return null;
  }
}

export async function getCachedTikTokDataset(productId, options = {}) {
  if (!isRedisConfigured() && !options.redisFetchImpl) return null;
  const key = getTikTokCacheKey(productId);
  try {
    const value = await redisCommand(['GET', key], {
      fetchImpl: options.redisFetchImpl,
      timeoutMs: options.redisTimeoutMs || 900
    });
    const mapping = parseMapping(value);
    if (!mapping || String(mapping.productId || '') !== String(productId)) return null;
    const dataset = await readPrivateBlobDataset(mapping, options);
    const validation = validateTikTokCachedDataset(dataset, {
      productId,
      minimumReviews: options.minimumReviews,
      now: options.now
    });
    if (!validation.valid) return null;
    return { dataset, mapping, validation };
  } catch {
    return null;
  }
}

export async function setCachedTikTokDataset(productId, blobLocation, dataset, options = {}) {
  if (!isRedisConfigured() && !options.redisFetchImpl) return { saved: false, reason: 'REDIS_NOT_CONFIGURED' };
  const validation = validateTikTokCachedDataset(dataset, {
    productId,
    minimumReviews: options.minimumReviews,
    now: options.now
  });
  if (!validation.valid) return { saved: false, reason: validation.reason };
  const rawPath = String(blobLocation?.rawPath || '').trim();
  const rawUrl = String(blobLocation?.rawUrl || '').trim();
  if (!rawPath && !rawUrl) return { saved: false, reason: 'BLOB_LOCATION_MISSING' };
  const mapping = {
    version: 1,
    platform: 'TikTok Shop',
    productId: String(productId),
    rawPath: rawPath || null,
    rawUrl: rawUrl || null,
    createdAt: dataset.createdAt,
    expiresAt: new Date(Date.parse(dataset.createdAt) + TIKTOK_CACHE_TTL_SECONDS * 1000).toISOString(),
    rawOnly: true,
    ratingStrataRequired: false
  };
  await redisCommand(['SET', getTikTokCacheKey(productId), JSON.stringify(mapping), 'EX', String(validation.ttlSeconds)], {
    fetchImpl: options.redisFetchImpl,
    timeoutMs: options.redisTimeoutMs || 1200
  });
  return { saved: true, key: getTikTokCacheKey(productId), ttlSeconds: validation.ttlSeconds };
}

function parseMapping(value) {
  if (!value) return null;
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return null;
  }
}

export async function getCachedShopeeDataset(itemId, options = {}) {
  if (!isRedisConfigured() && !options.redisFetchImpl) return null;
  const key = getShopeeCacheKey(itemId);
  try {
    const value = await redisCommand(['GET', key], {
      fetchImpl: options.redisFetchImpl,
      timeoutMs: options.redisTimeoutMs || 900
    });
    const mapping = parseMapping(value);
    if (!mapping || String(mapping.itemId || '') !== String(itemId)) return null;
    const dataset = await readPrivateBlobDataset(mapping, options);
    const validation = validateShopeeCachedDataset(dataset, { itemId, now: options.now });
    if (!validation.valid) return null;
    return { dataset, mapping, validation };
  } catch {
    return null;
  }
}

export async function setCachedShopeeDataset(itemId, blobLocation, dataset, options = {}) {
  if (!isRedisConfigured() && !options.redisFetchImpl) return { saved: false, reason: 'REDIS_NOT_CONFIGURED' };
  const validation = validateShopeeCachedDataset(dataset, { itemId, now: options.now });
  if (!validation.valid) return { saved: false, reason: validation.reason };
  const rawPath = String(blobLocation?.rawPath || '').trim();
  const rawUrl = String(blobLocation?.rawUrl || '').trim();
  if (!rawPath && !rawUrl) return { saved: false, reason: 'BLOB_LOCATION_MISSING' };
  const mapping = {
    version: 1,
    platform: 'Shopee',
    itemId: String(itemId),
    rawPath: rawPath || null,
    rawUrl: rawUrl || null,
    createdAt: dataset.createdAt,
    expiresAt: new Date(Date.parse(dataset.createdAt) + SHOPEE_CACHE_TTL_SECONDS * 1000).toISOString()
  };
  await redisCommand(['SET', getShopeeCacheKey(itemId), JSON.stringify(mapping), 'EX', String(validation.ttlSeconds)], {
    fetchImpl: options.redisFetchImpl,
    timeoutMs: options.redisTimeoutMs || 1200
  });
  return { saved: true, key: getShopeeCacheKey(itemId), ttlSeconds: validation.ttlSeconds };
}

export async function recordShopeeCacheHit(options = {}) {
  if (!isRedisConfigured() && !options.redisFetchImpl) return null;
  return redisCommand(['INCR', SHOPEE_CACHE_HITS_KEY], {
    fetchImpl: options.redisFetchImpl,
    timeoutMs: options.redisTimeoutMs || 900
  });
}

export async function recordShopeeServed(options = {}) {
  if (!isRedisConfigured() && !options.redisFetchImpl) return null;
  return redisCommand(['INCR', SHOPEE_TOTAL_SERVED_KEY], {
    fetchImpl: options.redisFetchImpl,
    timeoutMs: options.redisTimeoutMs || 900
  });
}

export async function getShopeeCacheStats(options = {}) {
  if (!isRedisConfigured() && !options.redisFetchImpl) return { hits: 0, totalServed: 0, hitRate: 0 };
  const [hits, totalServed] = await redisTransaction([
    ['GET', SHOPEE_CACHE_HITS_KEY],
    ['GET', SHOPEE_TOTAL_SERVED_KEY]
  ], {
    fetchImpl: options.redisFetchImpl,
    timeoutMs: options.redisTimeoutMs || 1200
  });
  const normalizedHits = Math.max(0, Number(hits) || 0);
  const normalizedTotal = Math.max(0, Number(totalServed) || 0);
  return {
    hits: normalizedHits,
    totalServed: normalizedTotal,
    hitRate: normalizedTotal ? normalizedHits / normalizedTotal : 0
  };
}
