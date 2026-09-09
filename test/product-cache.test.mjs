import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SHOPEE_CACHE_HITS_KEY,
  SHOPEE_TOTAL_SERVED_KEY,
  getCachedShopeeDataset,
  getFallbackTikTokDataset,
  getShopeeCacheKey,
  isShopeeCacheEligible,
  recordShopeeCacheHit,
  recordShopeeServed,
  setCachedShopeeDataset,
  validateShopeeCachedDataset
} from '../src/product-cache.mjs';
import { APIFY_POOL_COUNTERS_KEY } from '../src/apify-credential-store.mjs';
import { getReviews } from '../src/sources.mjs';

function shopeeDataset(overrides = {}) {
  return {
    schemaVersion: '1.0.0',
    datasetKind: 'raw-reviews',
    runId: 'run-cache-test',
    createdAt: '2026-09-05T00:00:00.000Z',
    product: { platform: 'Shopee', shopId: '1', itemId: '123', title: 'Sản phẩm Shopee' },
    source: {
      type: 'live',
      collection: {
        strategy: 'parallel-star-filters',
        ratingStrata: [1, 2, 3, 4, 5],
        targetMaximum: 100,
        returned: 5
      }
    },
    reviewCount: 5,
    reviews: [1, 2, 3, 4, 5].map((rating) => ({ rating, text: `Review ${rating} sao có nội dung` })),
    ...overrides
  };
}

function createRedisFake(initial = {}) {
  const values = new Map(Object.entries(initial));
  const commands = [];
  function execute(command) {
    commands.push(command);
    if (command[0] === 'GET') return values.get(command[1]) ?? null;
    if (command[0] === 'SET') {
      values.set(command[1], command[2]);
      return 'OK';
    }
    if (command[0] === 'INCR') {
      const next = Number(values.get(command[1]) || 0) + 1;
      values.set(command[1], String(next));
      return next;
    }
    throw new Error(`Unsupported Redis command: ${command[0]}`);
  }
  return {
    values,
    commands,
    async fetchImpl(url, init) {
      const body = JSON.parse(init.body);
      if (url.endsWith('/multi-exec')) {
        return { ok: true, async json() { return body.map((command) => ({ result: execute(command) })); } };
      }
      return { ok: true, async json() { return { result: execute(body) }; } };
    }
  };
}

function enableRedisEnv(context) {
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
}

function blobGetFor(dataset) {
  return async () => ({
    statusCode: 200,
    stream: new Response(JSON.stringify(dataset)).body,
    blob: { size: Buffer.byteLength(JSON.stringify(dataset)) }
  });
}

function tiktokDataset(productId, count = 20) {
  return {
    schemaVersion: '1.0.0',
    datasetKind: 'raw-reviews',
    runId: `run-${productId}`,
    createdAt: '2026-09-07T00:00:00.000Z',
    product: { platform: 'TikTok Shop', productId, title: `TikTok ${productId}` },
    source: { type: 'live', collection: { strategy: 'parallel-star-filters', targetMaximum: 100 } },
    reviewCount: count,
    reviews: Array.from({ length: count }, (_, index) => ({
      rating: (index % 5) + 1,
      text: `Trải nghiệm TikTok ${index + 1}`
    }))
  };
}

test('cache dataset chỉ áp dụng cho Shopee', () => {
  assert.equal(isShopeeCacheEligible('Shopee'), true);
  assert.equal(isShopeeCacheEligible('TikTok Shop'), false);
  assert.equal(isShopeeCacheEligible(''), false);
});

test('chỉ chấp nhận dataset Shopee đủ đúng năm tầng, target 100 và còn hạn', () => {
  const now = new Date('2026-09-07T00:00:00.000Z');
  assert.equal(validateShopeeCachedDataset(shopeeDataset(), { itemId: '123', now }).valid, true);
  assert.equal(validateShopeeCachedDataset(shopeeDataset({
    source: { collection: { strategy: 'single-unfiltered', ratingStrata: [1, 2, 3, 4, 5], targetMaximum: 100 } }
  }), { itemId: '123', now }).reason, 'WRONG_STRATEGY');
  assert.equal(validateShopeeCachedDataset(shopeeDataset({
    source: { collection: { strategy: 'parallel-star-filters', ratingStrata: [1, 3, 5], targetMaximum: 100 } }
  }), { itemId: '123', now }).reason, 'INCOMPLETE_RATING_STRATA');
  assert.equal(validateShopeeCachedDataset(shopeeDataset({
    source: { collection: { strategy: 'parallel-star-filters', ratingStrata: [1, 2, 3, 4, 5], targetMaximum: 60 } }
  }), { itemId: '123', now }).reason, 'WRONG_TARGET_MAXIMUM');
  assert.equal(validateShopeeCachedDataset(shopeeDataset({ createdAt: '2026-09-01T23:59:59.000Z' }), {
    itemId: '123', now
  }).reason, 'EXPIRED');
  assert.equal(validateShopeeCachedDataset(shopeeDataset({ createdAt: '2026-09-07T00:00:01.000Z' }), {
    itemId: '123', now
  }).reason, 'INVALID_CREATED_AT');
});

test('ghi và đọc mapping cache với TTL còn lại của mốc năm ngày', async (context) => {
  enableRedisEnv(context);
  const redis = createRedisFake();
  const dataset = shopeeDataset();
  const now = new Date('2026-09-07T00:00:00.000Z');
  const saved = await setCachedShopeeDataset('123', {
    rawPath: 'review-datasets/2026/09/05/shopee-123/run/reviews.raw.json',
    rawUrl: 'https://private.blob/reviews.raw.json'
  }, dataset, { redisFetchImpl: redis.fetchImpl, now });
  assert.equal(saved.saved, true);
  assert.equal(saved.ttlSeconds, 3 * 24 * 60 * 60);

  const cached = await getCachedShopeeDataset('123', {
    redisFetchImpl: redis.fetchImpl,
    blobGetImpl: blobGetFor(dataset),
    now
  });
  assert.equal(cached.dataset.runId, 'run-cache-test');
  assert.equal(cached.dataset.reviews.length, 5);
});

test('cache hit có bộ đếm riêng và không thay đổi bộ đếm Apify Shopee', async (context) => {
  enableRedisEnv(context);
  const redis = createRedisFake({ [APIFY_POOL_COUNTERS_KEY]: 'unchanged' });
  await recordShopeeCacheHit({ redisFetchImpl: redis.fetchImpl });
  await recordShopeeServed({ redisFetchImpl: redis.fetchImpl });
  assert.equal(redis.values.get(SHOPEE_CACHE_HITS_KEY), '1');
  assert.equal(redis.values.get(SHOPEE_TOTAL_SERVED_KEY), '1');
  assert.equal(redis.values.get(APIFY_POOL_COUNTERS_KEY), 'unchanged');
  assert.equal(redis.commands.some((command) => command.includes(APIFY_POOL_COUNTERS_KEY)), false);
});

test('getReviews dùng Blob cache Shopee và bỏ qua hoàn toàn Apify', async (context) => {
  enableRedisEnv(context);
  const dataset = shopeeDataset();
  const mapping = JSON.stringify({
    version: 1,
    platform: 'Shopee',
    itemId: '123',
    rawPath: 'review-datasets/2026/09/05/shopee-123/run/reviews.raw.json',
    createdAt: dataset.createdAt
  });
  const redis = createRedisFake({ [getShopeeCacheKey('123')]: mapping });
  const result = await getReviews('https://shopee.vn/san-pham-i.1.123', {
    redisFetchImpl: redis.fetchImpl,
    blobGetImpl: blobGetFor(dataset),
    now: new Date('2026-09-07T00:00:00.000Z')
  });
  assert.equal(result.source.type, 'cached');
  assert.equal(result.reviews.length, 5);
  assert.equal(result.product.itemId, '123');
  assert.equal(redis.values.get(SHOPEE_CACHE_HITS_KEY), '1');
  assert.equal(redis.values.get(SHOPEE_TOTAL_SERVED_KEY), '1');
  assert.equal(redis.commands.some((command) => command[0] === 'HINCRBY'), false);
});

test('TikTok fallback ưu tiên dataset đúng productId và không cần Redis', async () => {
  const target = tiktokDataset('1729736382033660305');
  const other = tiktokDataset('1111111111111111111');
  const datasets = new Map([
    ['review-datasets/2026/09/07/tiktok-1729736382033660305/run-target/reviews.raw.json', target],
    ['review-datasets/2026/09/08/tiktok-1111111111111111111/run-newer/reviews.raw.json', other]
  ]);
  const fallback = await getFallbackTikTokDataset('1729736382033660305', {
    blobToken: 'blob-token',
    blobListImpl: async () => ({
      blobs: [...datasets.keys()].map((pathname, index) => ({
        pathname,
        url: `https://blob.test/${index}`,
        uploadedAt: index ? '2026-09-08T00:00:00.000Z' : '2026-09-07T00:00:00.000Z'
      }))
    }),
    blobGetImpl: async (pathname) => blobGetFor(datasets.get(pathname))()
  });
  assert.equal(fallback.isExactMatch, true);
  assert.equal(fallback.dataset.product.productId, '1729736382033660305');
});

test('TikTok fallback không bao giờ dùng dataset của sản phẩm khác', async () => {
  const older = tiktokDataset('1111111111111111111');
  const newest = tiktokDataset('2222222222222222222');
  const datasets = new Map([
    ['review-datasets/2026/09/07/tiktok-1111111111111111111/run-old/reviews.raw.json', older],
    ['review-datasets/2026/09/08/tiktok-2222222222222222222/run-new/reviews.raw.json', newest]
  ]);
  const fallback = await getFallbackTikTokDataset('1729736382033660305', {
    blobToken: 'blob-token',
    blobListImpl: async () => ({
      blobs: [...datasets.keys()].map((pathname, index) => ({
        pathname,
        url: `https://blob.test/${index}`,
        uploadedAt: index ? '2026-09-08T00:00:00.000Z' : '2026-09-07T00:00:00.000Z'
      }))
    }),
    blobGetImpl: async (pathname) => blobGetFor(datasets.get(pathname))()
  });
  assert.equal(fallback, null);
});

test('getReviews dùng TikTok Blob fallback khi bật cờ và bỏ qua Actor', async (context) => {
  const previous = process.env.TIKTOK_DATASET_FALLBACK;
  process.env.TIKTOK_DATASET_FALLBACK = 'true';
  context.after(() => {
    if (previous === undefined) delete process.env.TIKTOK_DATASET_FALLBACK;
    else process.env.TIKTOK_DATASET_FALLBACK = previous;
  });
  const productId = '1729736382033660305';
  const dataset = tiktokDataset(productId);
  const pathname = `review-datasets/2026/09/08/tiktok-${productId}/run/reviews.raw.json`;
  const result = await getReviews(`https://shop.tiktok.com/vn/pdp/product/${productId}`, {
    blobToken: 'blob-token',
    blobListImpl: async () => ({
      blobs: [{ pathname, url: 'https://blob.test/raw', uploadedAt: '2026-09-08T00:00:00.000Z' }]
    }),
    blobGetImpl: blobGetFor(dataset)
  });
  assert.equal(result.source.type, 'cached');
  assert.equal(result.source.cache.fallback, true);
  assert.equal(result.source.cache.exactMatch, true);
  assert.equal(result.reviews.length, 20);
  assert.match(result.warnings.at(-1), /đúng sản phẩm/);
});
