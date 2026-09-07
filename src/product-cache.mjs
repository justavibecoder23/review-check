import { isRedisConfigured, redisCommand, redisTransaction } from './redis-rest.mjs';

export const SHOPEE_CACHE_TTL_SECONDS = 5 * 24 * 60 * 60;
export const SHOPEE_CACHE_HITS_KEY = 'realview:shopee:cache:hits';
export const SHOPEE_TOTAL_SERVED_KEY = 'realview:shopee:total_served';
const MAX_DATASET_BYTES = 5 * 1024 * 1024;

export function isShopeeCacheEligible(platform) {
  return String(platform || '').trim().toLowerCase() === 'shopee';
}

export function getShopeeCacheKey(itemId) {
  const normalized = String(itemId || '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error('Shopee itemId không hợp lệ cho cache.');
  return `realview:cache:product:shopee:${normalized}`;
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
