import { isRedisConfigured, redisCommand, redisTransaction } from './redis-rest.mjs';
import { cleanProductTitle } from './product-metadata-quality.mjs';
import { blobReviewFallbackAllowed, getCloudflareReviewDataset, reviewStorageMode,
  getCloudflareShopeeMetadata, saveCloudflareShopeeMetadata,
  getCloudflareTikTokMetadata, saveCloudflareTikTokMetadata } from './cloudflare-review-store.mjs';
import { normalizeD1TikTokMetadata } from './tiktok-metadata-policy.mjs';

export const SHOPEE_CACHE_TTL_SECONDS = 5 * 24 * 60 * 60;
export const TIKTOK_CACHE_TTL_SECONDS = 5 * 24 * 60 * 60;
export const SHOPEE_CACHE_HITS_KEY = 'realview:shopee:cache:hits';
export const SHOPEE_TOTAL_SERVED_KEY = 'realview:shopee:total_served';
// Schema v2 contains raw + labeled data in one object; keep the same effective
// ceiling as the two former 5 MB files without accepting unbounded payloads.
const MAX_DATASET_BYTES = 10 * 1024 * 1024;
const MIN_TIKTOK_FALLBACK_REVIEWS = 20;
const LATEST_POINTER_PREFIX = 'realview:cache:product:latest:v2:';
const TIKTOK_PRODUCT_META_PREFIX = 'realview:product-meta:v1:tiktok:';
const TIKTOK_PRODUCT_META_TTL_SECONDS = 30 * 24 * 60 * 60;
const SHOPEE_PRODUCT_META_PREFIX = 'realview:product-meta:v1:shopee:';
const SHOPEE_PRODUCT_META_TTL_SECONDS = SHOPEE_CACHE_TTL_SECONDS;

export function getShopeeProductMetaKey(shopId, itemId) {
  if (!/^\d+$/.test(String(shopId || '')) || !/^\d+$/.test(String(itemId || ''))) {
    throw new Error('Shopee shopId:itemId không hợp lệ cho metadata cache.');
  }
  return `${SHOPEE_PRODUCT_META_PREFIX}${shopId}:${itemId}`;
}

export function normalizeShopeeProductMetadata(shopId, itemId, metadata = {}, options = {}) {
  if (!/^\d+$/.test(String(shopId || '')) || !/^\d+$/.test(String(itemId || ''))) return null;
  const title = cleanProductTitle(metadata.title);
  const imageCandidate = safeProductImage(metadata.image);
  const image = isMirroredProductImage(imageCandidate) ? '' : imageCandidate;
  if (!title && !image) return null;
  return {
    shopId: String(shopId), itemId: String(itemId),
    ...(title ? { title } : {}), ...(image ? { image } : {}),
    source: String(options.source || metadata.source || 'unknown').slice(0, 40),
    updatedAt: new Date(options.now || Date.now()).toISOString()
  };
}

export async function getShopeeProductMetadata(shopId, itemId, options = {}) {
  getShopeeProductMetaKey(shopId, itemId);
  if (reviewStorageMode(options) !== 'blob') {
    const data = await getCloudflareShopeeMetadata(shopId, itemId, options).catch(() => null);
    return data ? normalizeShopeeProductMetadata(shopId, itemId, data, { source: data.source, now: data.updatedAt }) : null;
  }
  if (!isRedisConfigured() && !options.redisFetchImpl) return null;
  const raw = await redisCommand(['GET', getShopeeProductMetaKey(shopId, itemId)], {
    fetchImpl: options.redisFetchImpl, timeoutMs: options.redisTimeoutMs || 900
  }).catch(() => null);
  if (!raw) return null;
  try {
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (String(data.shopId) !== String(shopId) || String(data.itemId) !== String(itemId)) return null;
    return normalizeShopeeProductMetadata(shopId, itemId, data, { source: data.source, now: data.updatedAt });
  } catch { return null; }
}

export async function setShopeeProductMetadata(shopId, itemId, metadata, options = {}) {
  const normalized = normalizeShopeeProductMetadata(shopId, itemId, metadata, options);
  if (!normalized?.title && !normalized?.image) return { saved: false, reason: 'METADATA_EMPTY' };
  if (reviewStorageMode(options) !== 'blob') return saveCloudflareShopeeMetadata(normalized, options);
  if (!isRedisConfigured() && !options.redisFetchImpl) return { saved: false, reason: 'REDIS_NOT_CONFIGURED' };
  await redisCommand(['SET', getShopeeProductMetaKey(shopId, itemId), JSON.stringify(normalized),
    'EX', String(SHOPEE_PRODUCT_META_TTL_SECONDS)], {
    fetchImpl: options.redisFetchImpl, timeoutMs: options.redisTimeoutMs || 1_200
  });
  return { saved: true, metadata: normalized };
}

export function isMirroredProductImage(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' && /\.public\.blob\.vercel-storage\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

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

export function getTikTokProductMetaKey(productId) {
  const normalized = String(productId || '').trim();
  if (typeof productId !== 'string' || !/^\d{8,25}$/.test(normalized)) throw new Error('TikTok productId không hợp lệ cho metadata cache.');
  return `${TIKTOK_PRODUCT_META_PREFIX}${normalized}`;
}

function safeProductImage(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

export function normalizeTikTokProductMetadata(productId, metadata = {}, options = {}) {
  const normalizedId = String(productId || '').trim();
  if (!/^\d{8,25}$/.test(normalizedId)) return null;
  const title = cleanProductTitle(metadata.title || metadata.productName);
  // Old public Blob overlays may no longer be readable. Keep only the source
  // image URL; never let a suspended mirror replace a fresh Actor image.
  const imageCandidate = safeProductImage(metadata.image || metadata.productImage || metadata.imageUrl || metadata.thumbnail);
  const image = isMirroredProductImage(imageCandidate) ? '' : imageCandidate;
  if (!title && !image) return null;
  const price = String(metadata.price || metadata.productPrice || '').trim().slice(0, 80);
  const rating = Number(metadata.rating || metadata.productRating);
  return {
    productId: normalizedId,
    ...(title ? { title } : {}),
    ...(image ? { image } : {}),
    ...(price ? { price } : {}),
    ...(Number.isFinite(rating) && rating > 0 ? { rating } : {}),
    source: String(options.source || metadata.metadataSource || 'unknown').trim().slice(0, 40),
    updatedAt: new Date(options.now || Date.now()).toISOString()
  };
}

export async function getTikTokProductMetadata(productId, options = {}) {
  getTikTokProductMetaKey(productId);
  if (tiktokMetadataBackend(options) === 'd1') {
    return getCloudflareTikTokMetadata(productId, options).catch((error) => {
      console.error(JSON.stringify({ event: 'tiktok_metadata_d1_read_failed', code: error.message }));
      return null;
    });
  }
  if (!isRedisConfigured() && !options.redisFetchImpl) return null;
  const raw = await redisCommand(['GET', getTikTokProductMetaKey(productId)], {
    fetchImpl: options.redisFetchImpl,
    timeoutMs: options.redisTimeoutMs || 900
  }).catch(() => null);
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return normalizeTikTokProductMetadata(productId, parsed, {
      source: parsed?.source || 'redis-overlay',
      now: parsed?.updatedAt || Date.now()
    });
  } catch {
    return null;
  }
}

export async function setTikTokProductMetadata(productId, metadata, options = {}) {
  getTikTokProductMetaKey(productId);
  if (tiktokMetadataBackend(options) === 'd1') {
    const now = new Date(options.now ?? Date.now()).getTime();
    const normalized = normalizeD1TikTokMetadata(productId, { ...metadata,
      source: options.source || metadata.source || 'unknown',
      observedAt: options.observedAt || metadata.observedAt || new Date(now).toISOString() }, now);
    if (!normalized) return { saved: false, reason: 'METADATA_INVALID_OR_EXPIRED' };
    return saveCloudflareTikTokMetadata(normalized, options);
  }
  if (!isRedisConfigured() && !options.redisFetchImpl) return { saved: false, reason: 'REDIS_NOT_CONFIGURED' };
  const normalized = normalizeTikTokProductMetadata(productId, metadata, options);
  if (!normalized) return { saved: false, reason: 'METADATA_EMPTY' };
  await redisCommand([
    'SET', getTikTokProductMetaKey(productId), JSON.stringify(normalized),
    'EX', String(TIKTOK_PRODUCT_META_TTL_SECONDS)
  ], {
    fetchImpl: options.redisFetchImpl,
    timeoutMs: options.redisTimeoutMs || 1_200
  });
  return { saved: true, metadata: normalized };
}

export function tiktokMetadataBackend(options = {}) {
  const override = options.tiktokMetadataBackend || process.env.TIKTOK_METADATA_BACKEND;
  if (override && !['d1', 'redis'].includes(override)) throw new Error('TIKTOK_METADATA_BACKEND không hợp lệ.');
  return override || (reviewStorageMode(options) === 'blob' ? 'redis' : 'd1');
}

export function getLatestDatasetPointerKey(platform, productId) {
  const normalizedPlatform = String(platform || '').trim().toLowerCase();
  const normalizedId = String(productId || '').trim();
  if (normalizedPlatform === 'shopee' && /^\d+$/.test(normalizedId)) {
    return `${LATEST_POINTER_PREFIX}shopee:${normalizedId}`;
  }
  if (['tiktok', 'tiktok shop'].includes(normalizedPlatform) && /^\d{8,25}$/.test(normalizedId)) {
    return `${LATEST_POINTER_PREFIX}tiktok:${normalizedId}`;
  }
  throw new Error('Platform hoặc productId không hợp lệ cho latest dataset pointer.');
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

export function extractRawDataset(storedPayload) {
  if (!storedPayload || typeof storedPayload !== 'object') return null;
  if (storedPayload.datasetKind === 'review-dataset-bundle') {
    return storedPayload.rawDataset && typeof storedPayload.rawDataset === 'object'
      ? storedPayload.rawDataset
      : null;
  }
  return storedPayload;
}

export async function readPrivateBlobDataset(blobLocation, options = {}) {
  const pathname = String(blobLocation?.bundlePath || blobLocation?.rawPath || blobLocation?.pathname || '').trim();
  const url = String(blobLocation?.bundleUrl || blobLocation?.rawUrl || blobLocation?.url || '').trim();
  const locator = pathname || url;
  if (!locator) return null;
  try {
    const getBlob = options.blobGetImpl || (await import('@vercel/blob')).get;
    const result = await getBlob(locator, {
      access: 'private',
      token: options.blobToken || process.env.BLOB_READ_WRITE_TOKEN
    });
    const text = await blobResultText(result);
    return text ? extractRawDataset(JSON.parse(text)) : null;
  } catch {
    return null;
  }
}

/**
 * TikTok exact-product fallback now resolves a direct Redis pointer. It never
 * scans Blob on a user request, so cache recovery costs zero Advanced Ops.
 */
export async function getFallbackTikTokDataset(productId, options = {}) {
  const normalizedProductId = String(productId || '').trim();
  if (!/^\d{8,25}$/.test(normalizedProductId)) return null;
  const cached = await getCachedTikTokDataset(normalizedProductId, options);
  if (!cached) return null;
  return {
    dataset: cached.dataset,
    validation: cached.validation,
    isExactMatch: true,
    blobPath: cached.mapping?.bundlePath || cached.mapping?.rawPath || null,
    recoveredFromPointer: Boolean(cached.recoveredFromPointer)
  };
}

async function readCacheMapping(activeKey, latestKey, options = {}) {
  const active = parseMapping(await redisCommand(['GET', activeKey], {
    fetchImpl: options.redisFetchImpl,
    timeoutMs: options.redisTimeoutMs || 900
  }));
  if (active) return { mapping: active, recoveredFromPointer: false };
  const latest = parseMapping(await redisCommand(['GET', latestKey], {
    fetchImpl: options.redisFetchImpl,
    timeoutMs: options.redisTimeoutMs || 900
  }));
  return latest ? { mapping: latest, recoveredFromPointer: true } : null;
}

async function warmActiveCache(activeKey, mapping, ttlSeconds, options = {}) {
  await redisCommand(['SET', activeKey, JSON.stringify(mapping), 'EX', String(ttlSeconds)], {
    fetchImpl: options.redisFetchImpl,
    timeoutMs: options.redisTimeoutMs || 1_200
  });
}

async function backfillLatestPointer(latestKey, mapping, options = {}) {
  // Legacy v1 active mappings predate the persistent pointer. Backfill only
  // when no pointer exists so an older active entry can never replace a newer
  // dataset selected by another request.
  await redisCommand(['SET', latestKey, JSON.stringify(mapping), 'NX'], {
    fetchImpl: options.redisFetchImpl,
    timeoutMs: options.redisTimeoutMs || 1_200
  });
}

async function writeCacheAndLatestPointer(activeKey, latestKey, mapping, ttlSeconds, options = {}) {
  await redisTransaction([
    ['SET', activeKey, JSON.stringify(mapping), 'EX', String(ttlSeconds)],
    ['SET', latestKey, JSON.stringify(mapping)]
  ], {
    fetchImpl: options.redisFetchImpl,
    timeoutMs: options.redisTimeoutMs || 1_200
  });
}

export async function getCachedTikTokDataset(productId, options = {}) {
  if (reviewStorageMode(options) === 'd1') {
    try {
      const cached = await getCloudflareReviewDataset({ platform: 'TikTok Shop', productId }, options);
      if (cached) {
        const validation = validateTikTokCachedDataset(cached.dataset, { ...options, productId });
        if (validation.valid) return { ...cached, validation, recoveredFromPointer: false };
      }
    } catch (error) {
      console.error(JSON.stringify({ event: 'review_cache_d1_read_failed', platform: 'tiktok', code: error.message }));
    }
    if (!blobReviewFallbackAllowed(options)) return null;
  }
  if (!isRedisConfigured() && !options.redisFetchImpl) return null;
  const key = getTikTokCacheKey(productId);
  try {
    const resolved = await readCacheMapping(
      key,
      getLatestDatasetPointerKey('tiktok', productId),
      options
    );
    const mapping = resolved?.mapping;
    if (!mapping || String(mapping.productId || '') !== String(productId)) return null;
    const dataset = await readPrivateBlobDataset(mapping, options);
    const validation = validateTikTokCachedDataset(dataset, {
      productId,
      minimumReviews: options.minimumReviews,
      now: options.now
    });
    if (!validation.valid) return null;
    if (resolved.recoveredFromPointer) {
      // Warming is opportunistic. A transient Redis write error must not turn
      // a valid Blob dataset into an Actor request.
      await warmActiveCache(key, mapping, validation.ttlSeconds, options).catch(() => null);
    } else if (Number(mapping.version || 1) < 2) {
      await backfillLatestPointer(getLatestDatasetPointerKey('tiktok', productId), mapping, options).catch(() => null);
    }
    return { dataset, mapping, validation, recoveredFromPointer: resolved.recoveredFromPointer };
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
  const bundlePath = String(blobLocation?.bundlePath || '').trim();
  const bundleUrl = String(blobLocation?.bundleUrl || '').trim();
  if (!rawPath && !rawUrl && !bundlePath && !bundleUrl) return { saved: false, reason: 'BLOB_LOCATION_MISSING' };
  const mapping = {
    version: bundlePath || bundleUrl ? 2 : 1,
    platform: 'TikTok Shop',
    productId: String(productId),
    bundlePath: bundlePath || null,
    bundleUrl: bundleUrl || null,
    rawPath: rawPath || bundlePath || null,
    rawUrl: rawUrl || bundleUrl || null,
    createdAt: dataset.createdAt,
    expiresAt: new Date(Date.parse(dataset.createdAt) + TIKTOK_CACHE_TTL_SECONDS * 1000).toISOString(),
    rawOnly: true,
    ratingStrataRequired: false
  };
  await writeCacheAndLatestPointer(
    getTikTokCacheKey(productId),
    getLatestDatasetPointerKey('tiktok', productId),
    mapping,
    validation.ttlSeconds,
    options
  );
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
  if (reviewStorageMode(options) === 'd1') {
    try {
      const cached = await getCloudflareReviewDataset({ platform: 'Shopee', itemId, shopId: options.shopId }, options);
      if (cached) {
        const validation = validateShopeeCachedDataset(cached.dataset, { ...options, itemId });
        if (validation.valid) return { ...cached, validation, recoveredFromPointer: false };
      }
    } catch (error) {
      console.error(JSON.stringify({ event: 'review_cache_d1_read_failed', platform: 'shopee', code: error.message }));
    }
    if (!blobReviewFallbackAllowed(options)) return null;
  }
  if (!isRedisConfigured() && !options.redisFetchImpl) return null;
  const key = getShopeeCacheKey(itemId);
  try {
    const resolved = await readCacheMapping(
      key,
      getLatestDatasetPointerKey('shopee', itemId),
      options
    );
    const mapping = resolved?.mapping;
    if (!mapping || String(mapping.itemId || '') !== String(itemId)) return null;
    const dataset = await readPrivateBlobDataset(mapping, options);
    const validation = validateShopeeCachedDataset(dataset, { itemId, now: options.now });
    if (!validation.valid) return null;
    if (resolved.recoveredFromPointer) {
      await warmActiveCache(key, mapping, validation.ttlSeconds, options).catch(() => null);
    } else if (Number(mapping.version || 1) < 2) {
      await backfillLatestPointer(getLatestDatasetPointerKey('shopee', itemId), mapping, options).catch(() => null);
    }
    return { dataset, mapping, validation, recoveredFromPointer: resolved.recoveredFromPointer };
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
  const bundlePath = String(blobLocation?.bundlePath || '').trim();
  const bundleUrl = String(blobLocation?.bundleUrl || '').trim();
  if (!rawPath && !rawUrl && !bundlePath && !bundleUrl) return { saved: false, reason: 'BLOB_LOCATION_MISSING' };
  const mapping = {
    version: bundlePath || bundleUrl ? 2 : 1,
    platform: 'Shopee',
    itemId: String(itemId),
    bundlePath: bundlePath || null,
    bundleUrl: bundleUrl || null,
    rawPath: rawPath || bundlePath || null,
    rawUrl: rawUrl || bundleUrl || null,
    createdAt: dataset.createdAt,
    expiresAt: new Date(Date.parse(dataset.createdAt) + SHOPEE_CACHE_TTL_SECONDS * 1000).toISOString()
  };
  await writeCacheAndLatestPointer(
    getShopeeCacheKey(itemId),
    getLatestDatasetPointerKey('shopee', itemId),
    mapping,
    validation.ttlSeconds,
    options
  );
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
