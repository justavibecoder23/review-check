import { createHash } from 'node:crypto';
import { productCacheIdentity } from './review-cache-policy.mjs';
import { normalizeD1TikTokMetadata, TIKTOK_METADATA_TTL_MS } from './tiktok-metadata-policy.mjs';

const MAX_BYTES = 10 * 1024 * 1024;

export function reviewStorageMode(options = {}) {
  const mode = String(options.reviewStorageMode || process.env.REVIEW_DATASET_BACKEND || 'blob').toLowerCase();
  if (!['blob', 'dual', 'd1'].includes(mode)) throw new Error('REVIEW_DATASET_BACKEND không hợp lệ.');
  return mode;
}

export function cloudflareReviewConfigured(options = {}) {
  return Boolean((options.cloudflareReviewUrl || process.env.CLOUDFLARE_REVIEW_CACHE_URL)
    && (options.cloudflareReviewSecret || process.env.CLOUDFLARE_REVIEW_CACHE_SECRET));
}

export function blobReviewFallbackAllowed(options = {}) {
  return options.blobReviewFallback ?? process.env.REVIEW_DATASET_BLOB_FALLBACK !== 'false';
}

async function cloudflareRequest(path, options = {}, body) {
  const base = String(options.cloudflareReviewUrl || process.env.CLOUDFLARE_REVIEW_CACHE_URL || '').replace(/\/$/, '');
  const secret = options.cloudflareReviewSecret || process.env.CLOUDFLARE_REVIEW_CACHE_SECRET;
  if (!base || !secret) throw new Error('CLOUDFLARE_REVIEW_NOT_CONFIGURED');
  const url = new URL(base);
  if (url.protocol !== 'https:' && !(options.allowLocalCloudflare && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('CLOUDFLARE_REVIEW_URL_INVALID');
  }
  const response = await (options.cloudflareFetchImpl || fetch)(`${base}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${secret}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(options.cloudflareTimeoutMs || 2_500)
  });
  if (!response.ok) throw new Error(`CLOUDFLARE_REVIEW_HTTP_${response.status}`);
  if (Number(response.headers.get('content-length')) > MAX_BYTES + 100_000) throw new Error('CLOUDFLARE_REVIEW_TOO_LARGE');
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_BYTES + 100_000) throw new Error('CLOUDFLARE_REVIEW_TOO_LARGE');
  return JSON.parse(text);
}

export async function saveCloudflareReviewBundle(bundle, fingerprint, options = {}) {
  const receipt = await cloudflareRequest('/v1/datasets', options, {
    bundle, fingerprint, cacheable: options.cacheable !== false,
    ...(options.importedFrom ? { importedFrom: options.importedFrom } : {})
  });
  if (!receipt.saved || !/^[a-f0-9]{64}$/.test(receipt.datasetId || '') || !receipt.runId
    || !Number.isFinite(Date.parse(receipt.createdAt))) throw new Error('CLOUDFLARE_WRITE_NOT_CONFIRMED');
  return {
    saved: true, provider: 'cloudflare-d1', schemaVersion: bundle.schemaVersion,
    datasetId: receipt.datasetId, fingerprint, runId: receipt.runId, createdAt: receipt.createdAt,
    reused: Boolean(receipt.reused), cacheable: Boolean(receipt.cacheable), blobOperations: 0,
    rawDataset: { ...bundle.rawDataset, runId: receipt.runId, createdAt: receipt.createdAt },
    rowsRead: receipt.rowsRead, rowsWritten: receipt.rowsWritten
  };
}

export async function getCloudflareReviewDataset(product, options = {}) {
  const key = productCacheIdentity(product);
  if (!key) return null;
  const result = await cloudflareRequest(`/v1/cache?key=${encodeURIComponent(key)}`, options);
  if (!result.hit) return null;
  if (productCacheIdentity(result.bundle?.rawDataset?.product) !== key) throw new Error('CLOUDFLARE_PRODUCT_MISMATCH');
  if (product.shopId && String(result.bundle.rawDataset.product.shopId) !== String(product.shopId)) {
    throw new Error('CLOUDFLARE_SHOP_MISMATCH');
  }
  return { dataset: result.bundle.rawDataset, mapping: {
    provider: 'cloudflare-d1', datasetId: result.datasetId,
    createdAt: result.bundle.createdAt
  } };
}

export async function verifyCloudflareReviewBundle(datasetId, expectedBundle, options = {}) {
  const result = await cloudflareRequest(`/v1/datasets/${datasetId}`, options);
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return { matches: hash(result.bundle) === hash(expectedBundle), contentHash: hash(result.bundle) };
}

export async function getCloudflareShopeeMetadata(shopId, itemId, options = {}) {
  const result = await cloudflareRequest(`/v1/product-metadata?shopId=${encodeURIComponent(shopId)}&itemId=${encodeURIComponent(itemId)}`, options);
  if (!result.hit) return null;
  if (String(result.metadata?.shopId) !== String(shopId) || String(result.metadata?.itemId) !== String(itemId)
    || !Number.isFinite(Date.parse(result.metadata?.expiresAt))
    || Date.parse(result.metadata.expiresAt) <= Date.now()) throw new Error('CLOUDFLARE_METADATA_INVALID');
  return result.metadata;
}

export async function saveCloudflareShopeeMetadata(metadata, options = {}) {
  const result = await cloudflareRequest('/v1/product-metadata', options, metadata);
  if (!result.saved || String(result.metadata?.shopId) !== String(metadata.shopId)
    || String(result.metadata?.itemId) !== String(metadata.itemId)) throw new Error('CLOUDFLARE_METADATA_WRITE_NOT_CONFIRMED');
  return result;
}

function verifiedTikTokMetadata(productId, input, options) {
  const now = new Date(options.now ?? Date.now()).getTime();
  const data = normalizeD1TikTokMetadata(productId, input, now);
  const expiresAt = Date.parse(input?.expiresAt);
  const updatedAt = Date.parse(input?.updatedAt);
  if (!data || String(input?.productId) !== String(productId) || !Number.isFinite(expiresAt)
    || !Number.isFinite(updatedAt) || expiresAt <= now
    || expiresAt > Date.parse(data.observedAt) + TIKTOK_METADATA_TTL_MS) {
    throw new Error('CLOUDFLARE_TIKTOK_METADATA_INVALID');
  }
  return { ...data, updatedAt: input.updatedAt, expiresAt: input.expiresAt };
}

export async function getCloudflareTikTokMetadata(productId, options = {}) {
  const result = await cloudflareRequest(`/v1/tiktok-product-metadata?productId=${encodeURIComponent(productId)}`, options);
  return result.hit ? verifiedTikTokMetadata(productId, result.metadata, options) : null;
}

export async function saveCloudflareTikTokMetadata(metadata, options = {}) {
  const result = await cloudflareRequest('/v1/tiktok-product-metadata', options, metadata);
  if (!result.saved) throw new Error('CLOUDFLARE_TIKTOK_METADATA_WRITE_NOT_CONFIRMED');
  return { ...result, metadata: verifiedTikTokMetadata(metadata.productId, result.metadata, options) };
}
