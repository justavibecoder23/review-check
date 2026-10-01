export const REVIEW_CACHE_TTL_SECONDS = 5 * 24 * 60 * 60;

export function productCacheIdentity(product = {}) {
  const platform = String(product.platform || '').trim().toLowerCase();
  if (platform === 'shopee' && /^\d+$/.test(String(product.itemId || ''))) {
    return `shopee:${product.itemId}`;
  }
  if (['tiktok', 'tiktok shop'].includes(platform) && /^\d{8,25}$/.test(String(product.productId || ''))) {
    return `tiktok:${product.productId}`;
  }
  return null;
}

export function validateReviewCache(dataset, options = {}) {
  if (!dataset || typeof dataset !== 'object') return { valid: false, reason: 'INVALID_DATASET' };
  const platform = String(dataset.product?.platform || '').trim().toLowerCase();
  const expectedPlatform = options.platform || platform;
  if (expectedPlatform === 'shopee') {
    if (platform !== 'shopee') return { valid: false, reason: 'NOT_SHOPEE' };
    if (options.itemId && String(dataset.product?.itemId) !== String(options.itemId)) {
      return { valid: false, reason: 'ITEM_ID_MISMATCH' };
    }
  } else {
    if (platform !== 'tiktok shop') return { valid: false, reason: 'NOT_TIKTOK' };
    if (dataset.datasetKind !== 'raw-reviews') return { valid: false, reason: 'NOT_RAW_DATASET' };
    if (options.productId && String(dataset.product?.productId) !== String(options.productId)) {
      return { valid: false, reason: 'PRODUCT_ID_MISMATCH' };
    }
  }
  if (!Array.isArray(dataset.reviews)) return { valid: false, reason: 'REVIEWS_MISSING' };
  if (expectedPlatform === 'shopee') {
    const collection = dataset.source?.collection || {};
    if (collection.strategy !== 'parallel-star-filters') return { valid: false, reason: 'WRONG_STRATEGY' };
    const strata = [...new Set((Array.isArray(collection.ratingStrata) ? collection.ratingStrata : [])
      .map(Number).filter(Number.isInteger))].sort((a, b) => a - b);
    if (JSON.stringify(strata) !== '[1,2,3,4,5]') return { valid: false, reason: 'INCOMPLETE_RATING_STRATA' };
    if (Number(collection.targetMaximum) !== 100) return { valid: false, reason: 'WRONG_TARGET_MAXIMUM' };
  } else {
    const minimum = Math.max(1, Number.parseInt(options.minimumReviews, 10) || 20);
    if (dataset.reviews.filter((review) => String(review?.text || '').trim()).length < minimum) {
      return { valid: false, reason: 'INSUFFICIENT_REVIEWS' };
    }
  }
  const createdAt = Date.parse(String(dataset.createdAt || ''));
  const now = new Date(options.now ?? Date.now()).getTime();
  if (!Number.isFinite(now) || !Number.isFinite(createdAt) || createdAt > now) {
    return { valid: false, reason: 'INVALID_CREATED_AT' };
  }
  const ageMs = now - createdAt;
  if (ageMs > REVIEW_CACHE_TTL_SECONDS * 1000) return { valid: false, reason: 'EXPIRED' };
  return {
    valid: true, ageMs,
    ttlSeconds: Math.max(1, Math.ceil((REVIEW_CACHE_TTL_SECONDS * 1000 - ageMs) / 1000)),
    ...(expectedPlatform === 'shopee' ? {} : {
      reviewCount: dataset.reviews.filter((review) => String(review?.text || '').trim()).length
    })
  };
}
