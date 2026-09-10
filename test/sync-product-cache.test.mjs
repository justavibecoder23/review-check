import test from 'node:test';
import assert from 'node:assert/strict';
import { getShopeeCacheKey, getTikTokCacheKey } from '../src/product-cache.mjs';
import { syncRecentProductDatasets } from '../tools/sync-blob-to-redis.mjs';

function redisFake() {
  const values = new Map();
  return {
    values,
    async fetchImpl(_url, init) {
      const command = JSON.parse(init.body);
      if (command[0] === 'SET') {
        values.set(command[1], command[2]);
        return { ok: true, async json() { return { result: 'OK' }; } };
      }
      throw new Error(`Redis test không hỗ trợ ${command[0]}`);
    }
  };
}

function blobResponse(dataset) {
  const body = JSON.stringify(dataset);
  return {
    statusCode: 200,
    stream: new Response(body).body,
    blob: { size: Buffer.byteLength(body) }
  };
}

test('đồng bộ raw cache năm ngày cho cả Shopee và TikTok', async (context) => {
  const previousUrl = process.env.UPSTASH_REDIS_REST_URL;
  const previousToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  context.after(() => {
    if (previousUrl) process.env.UPSTASH_REDIS_REST_URL = previousUrl;
    else delete process.env.UPSTASH_REDIS_REST_URL;
    if (previousToken) process.env.UPSTASH_REDIS_REST_TOKEN = previousToken;
    else delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });
  const redis = redisFake();
  const tiktokProductId = '1729736382033660305';
  const shopeePath = 'review-datasets/2026/09/09/shopee-123/run-s/reviews.raw.json';
  const tiktokPath = `review-datasets/2026/09/09/tiktok-${tiktokProductId}/run-t/reviews.raw.json`;
  const datasets = new Map([
    [shopeePath, {
      datasetKind: 'raw-reviews',
      createdAt: '2026-09-09T00:00:00.000Z',
      product: { platform: 'Shopee', itemId: '123' },
      source: { collection: { strategy: 'parallel-star-filters', ratingStrata: [1, 2, 3, 4, 5], targetMaximum: 100 } },
      reviews: [1, 2, 3, 4, 5].map((rating) => ({ rating, text: `Shopee ${rating}` }))
    }],
    [tiktokPath, {
      datasetKind: 'raw-reviews',
      createdAt: '2026-09-09T00:00:00.000Z',
      product: { platform: 'TikTok Shop', productId: tiktokProductId },
      source: { collection: { strategy: 'single-unfiltered', targetMaximum: 100 } },
      reviews: Array.from({ length: 20 }, (_, index) => ({ rating: 5, text: `TikTok ${index}` }))
    }]
  ]);
  const blobs = [...datasets.keys()].map((pathname) => ({ pathname, url: `https://blob.test/${pathname}` }));
  const result = await syncRecentProductDatasets({
    now: new Date('2026-09-10T00:00:00.000Z'),
    blobToken: 'blob-token',
    blobListImpl: async () => ({ blobs, hasMore: false }),
    blobGetImpl: async (pathname) => blobResponse(datasets.get(pathname)),
    redisFetchImpl: redis.fetchImpl
  });
  assert.equal(result.platforms.shopee.mapped, 1, JSON.stringify(result));
  assert.equal(result.platforms.tiktok.mapped, 1);
  assert.equal(result.mapped, 2);
  assert.ok(redis.values.has(getShopeeCacheKey('123')));
  assert.ok(redis.values.has(getTikTokCacheKey(tiktokProductId)));
});
