import { cleanProductTitle } from './product-metadata-quality.mjs';

export const TIKTOK_METADATA_TTL_MS = 5 * 24 * 60 * 60 * 1000;

export function tiktokMetadataImage(value) {
  if (!value) return '';
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && url.href.length <= 3000
      && /(?:^|\.)(?:ibyteimg\.com|byteimg\.com|tiktokcdn\.com|tiktokcdn-us\.com|tiktokcdn-eu\.com|ibytedtos\.com)$/.test(url.hostname)
      ? url.href : '';
  } catch { return ''; }
}

export function tiktokMetadataTime(value, now = Date.now()) {
  const observedAt = Date.parse(String(value || ''));
  return Number.isFinite(observedAt) && observedAt <= now && observedAt + TIKTOK_METADATA_TTL_MS > now
    ? observedAt : null;
}

export function normalizeD1TikTokMetadata(productId, input = {}, now = Date.now()) {
  if (typeof productId !== 'string' || !/^\d{8,25}$/.test(productId)
    || (input.productId && (typeof input.productId !== 'string' || input.productId !== productId))) return null;
  const title = cleanProductTitle(input.title || input.productName);
  const image = tiktokMetadataImage(input.image || input.productImage || input.imageUrl || input.thumbnail);
  if (!title && !image) return null;
  const price = String(input.price || input.productPrice || '').trim().slice(0, 80);
  const rating = Number(input.rating || input.productRating);
  const observedAt = tiktokMetadataTime(input.observedAt, now);
  if (observedAt == null) return null;
  return { productId: String(productId), ...(title ? { title } : {}), ...(image ? { image } : {}),
    ...(price ? { price } : {}), ...(Number.isFinite(rating) && rating > 0 && rating <= 5 ? { rating } : {}),
    source: String(input.source || 'unknown').slice(0, 40), observedAt: new Date(observedAt).toISOString() };
}
