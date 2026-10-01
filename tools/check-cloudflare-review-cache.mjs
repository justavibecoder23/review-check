import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { saveCloudflareReviewBundle, verifyCloudflareReviewBundle } from '../src/cloudflare-review-store.mjs';
import { getCachedShopeeDataset, getCachedTikTokDataset } from '../src/product-cache.mjs';

const base = process.env.CLOUDFLARE_REVIEW_CACHE_URL;
if (!/^https:\/\/realview-review-cache-preview\./.test(base || '')) {
  throw new Error('This write test must target the isolated preview Worker.');
}
const timings = { write: [], read: [] };
const options = { reviewStorageMode: 'd1', blobReviewFallback: false, cloudflareTimeoutMs: 10_000 };
for (const [platform, count] of [['Shopee', 100], ['TikTok Shop', 200]]) {
  const product = platform === 'Shopee' ? { platform, shopId: '99900000001', itemId: '99900000002' }
    : { platform, productId: '9990000000000000003' };
  const now = new Date().toISOString();
  const rawDataset = { schemaVersion: '1.0.0', datasetKind: 'raw-reviews', runId: `remote-check-${platform}-${Date.now()}`,
    createdAt: now, product, source: { type: 'live', collection: {
      strategy: 'parallel-star-filters', ratingStrata: [1, 2, 3, 4, 5], targetMaximum: 100
    } }, reviewCount: count,
    reviews: Array.from({ length: count }, (_, index) => ({ reviewId: String(index), rating: index % 5 + 1,
      text: `Dữ liệu kiểm thử riêng trên preview. Giữ nguyên nội dung tiếng Việt và thứ tự review ${index}.` })) };
  const bundle = { schemaVersion: '2.0.0', datasetKind: 'review-dataset-bundle', runId: rawDataset.runId,
    createdAt: now, product, rawDataset, labeledDataset: { ...rawDataset, datasetKind: 'labeled-reviews',
      reviews: rawDataset.reviews.map(review => ({ ...review, included: true, labels: { checked: true } })) } };
  const fingerprint = createHash('sha256').update(JSON.stringify(bundle)).digest('hex').slice(0, 32);
  const writeStart = performance.now();
  const stored = await saveCloudflareReviewBundle(bundle, fingerprint, options);
  timings.write.push(Math.round(performance.now() - writeStart));
  assert.equal((await verifyCloudflareReviewBundle(stored.datasetId, bundle, options)).matches, true);
  const reads = [];
  for (let index = 0; index < 5; index += 1) {
    const started = performance.now();
    const cached = platform === 'Shopee' ? await getCachedShopeeDataset(product.itemId, { ...options, shopId: product.shopId })
      : await getCachedTikTokDataset(product.productId, options);
    reads.push(Math.round(performance.now() - started));
    assert.deepEqual(cached.dataset, bundle.rawDataset);
  }
  timings.read.push(...reads);
  console.log(JSON.stringify({ event: 'remote_review_cache_check', platform, count, bytes: Buffer.byteLength(JSON.stringify(bundle)),
    writeMs: timings.write.at(-1), readMs: reads, rowsWritten: stored.rowsWritten, verified: true }));
}
const unauthorized = await fetch(`${base}/v1/cache?key=shopee:99900000002`);
assert.equal(unauthorized.status, 401);
console.log(JSON.stringify({ event: 'remote_review_cache_check_complete', unauthorized: unauthorized.status, timings }));
