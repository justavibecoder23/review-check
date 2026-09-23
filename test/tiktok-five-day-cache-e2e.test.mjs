import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeProductUrl } from '../src/analyze.mjs';
import {
  getLatestDatasetPointerKey,
  getTikTokCacheKey
} from '../src/product-cache.mjs';
import { resolveTikTokProductUrl } from '../src/tiktok-url.mjs';

const PRODUCT_ID = '1729498401361201911';
const PRODUCT_URL = `https://shop.tiktok.com/vn/pdp/hasaki-beauty-nuoc-tay-trang-loreal-400ml-cho-da-dau-hon-hop/${PRODUCT_ID}`;
const NOW = new Date('2026-09-16T00:00:00.000Z');

function reviews(count = 100, marker = 'actor') {
  return Array.from({ length: count }, (_, index) => ({
    reviewId: `${marker}-${index + 1}`,
    itemId: PRODUCT_ID,
    authorId: `buyer-${index + 1}`,
    rating: (index % 5) + 1,
    text: `Đánh giá ${marker} ${index + 1}: sản phẩm làm sạch tốt và có trải nghiệm sử dụng rõ ràng.`,
    date: '16/09/2026',
    createdAt: '2026-09-15T00:00:00.000Z',
    verified: true,
    author: `Người mua ${index + 1}`
  }));
}

function rawDataset(createdAt, options = {}) {
  const items = reviews(options.count || 100, options.marker || 'cache');
  return {
    schemaVersion: '1.0.0',
    datasetKind: 'raw-reviews',
    runId: options.runId || `run-${options.marker || 'cache'}`,
    createdAt,
    product: {
      platform: 'TikTok Shop',
      productId: PRODUCT_ID,
      title: 'Nước tẩy trang L’Oreal 400ml'
    },
    source: {
      type: 'live',
      collection: {
        strategy: 'single-unfiltered',
        targetMaximum: options.count || 100,
        returned: items.length
      }
    },
    reviewCount: items.length,
    reviews: items
  };
}

function bundle(dataset) {
  return {
    schemaVersion: '2.0.0',
    datasetKind: 'review-dataset-bundle',
    runId: dataset.runId,
    createdAt: dataset.createdAt,
    product: dataset.product,
    rawDataset: dataset,
    labeledDataset: {
      ...dataset,
      datasetKind: 'labeled-reviews'
    }
  };
}

function createRedisFake(initial = {}) {
  const values = new Map(Object.entries(initial));
  const commands = [];
  function execute(command) {
    commands.push(command);
    if (command[0] === 'GET') return values.get(command[1]) ?? null;
    if (command[0] === 'SET') {
      if (command.includes('NX') && values.has(command[1])) return null;
      values.set(command[1], command[2]);
      return 'OK';
    }
    if (command[0] === 'DEL') return values.delete(command[1]) ? 1 : 0;
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
        return {
          ok: true,
          async json() { return body.map((command) => ({ result: execute(command) })); }
        };
      }
      return { ok: true, async json() { return { result: execute(body) }; } };
    }
  };
}

function createHarness(initialRedis = {}, initialBlobs = {}, options = {}) {
  const redis = createRedisFake(initialRedis);
  const blobs = new Map(Object.entries(initialBlobs));
  let actorCalls = 0;
  let blobPutCalls = 0;
  const collectTikTokReviewsImpl = async () => {
    actorCalls += 1;
    const items = reviews(100, `actor-${actorCalls}`);
    return {
      reviews: items,
      productMetaSource: {},
      productMeta: { title: 'Nước tẩy trang L’Oreal 400ml' },
      warnings: [],
      credential: { source: 'simulated', keys: [{ id: 'test-key' }] },
      usage: { provider: 'simulated', tracked: false, platform: 'tiktok' },
      collection: {
        strategy: 'single-unfiltered',
        targetMaximum: 100,
        returned: items.length,
        ...(options.cacheable === undefined ? {} : { cacheable: options.cacheable }),
        ratingStrataRequired: false
      }
    };
  };
  const blobPutImpl = async (pathname, body) => {
    blobPutCalls += 1;
    const parsed = JSON.parse(body);
    blobs.set(pathname, parsed);
    blobs.set(`https://blob.test/${pathname}`, parsed);
    return { pathname, url: `https://blob.test/${pathname}` };
  };
  const blobGetImpl = async (locator) => {
    const payload = blobs.get(locator);
    if (!payload) return { statusCode: 404, stream: null, blob: null };
    const text = JSON.stringify(payload);
    return {
      statusCode: 200,
      stream: new Response(text).body,
      blob: { size: Buffer.byteLength(text) }
    };
  };
  return {
    redis,
    blobs,
    collectTikTokReviewsImpl,
    blobPutImpl,
    blobGetImpl,
    get actorCalls() { return actorCalls; },
    get blobPutCalls() { return blobPutCalls; }
  };
}

function cacheMapping(dataset, pathname, version = 1) {
  return JSON.stringify({
    version,
    platform: 'TikTok Shop',
    productId: PRODUCT_ID,
    ...(version === 2 ? { bundlePath: pathname } : {}),
    rawPath: pathname,
    createdAt: dataset.createdAt
  });
}

async function analyze(harness, options = {}) {
  const progress = [];
  const result = await analyzeProductUrl(PRODUCT_URL, {
    now: options.now || NOW,
    env: {
      TIKTOK_REVIEW_ENABLED: 'true',
      TIKTOK_RECENT_RAW_CACHE: options.cacheEnabled === false ? 'false' : 'true'
    },
    redisFetchImpl: harness.redis.fetchImpl,
    blobGetImpl: harness.blobGetImpl,
    blobToken: 'blob-token',
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      headers: { get: () => null }
    }),
    collectTikTokReviewsImpl: harness.collectTikTokReviewsImpl,
    labelReviewsImpl: async (items) => ({
      reviews: items.map((review) => ({
        ...review,
        labels: {
          information_value: 'high',
          relevance: 'on_topic',
          defect_categories: []
        },
        labeling: { layer1: { reason_codes: [] } }
      })),
      stats: {
        duplicateContentCount: 0,
        layer2DurationMs: 1,
        layer2Status: 'complete'
      },
      warnings: []
    }),
    buildTrustAnalysisImpl: async (items) => ({
      score: 85,
      engine: 'simulated-e2e',
      method: {
        sample: {
          afterSeedingRemoval: items.length,
          rejectedFromEvidence: 0,
          excludedBySamplingDesign: 0,
          totalSeedingCount: 0
        }
      }
    }),
    datasetOptions: {
      now: options.datasetNow || options.now || NOW,
      runId: options.runId || `run-${Math.random().toString(16).slice(2)}`,
      blobPutImpl: harness.blobPutImpl
    },
    onProgress: (entry) => progress.push(entry)
  });
  assert.equal(result.product.productId, PRODUCT_ID);
  assert.equal(result.stats.scanned >= 100, true);
  assert.equal(result.trust.score, 85);
  assert.equal(progress.at(-1)?.stage, 'complete');
  return result;
}

test('mô phỏng 10 lượt từ link TikTok đến kết quả với cache năm ngày', async (context) => {
  const previous = {
    vercel: process.env.VERCEL,
    blob: process.env.BLOB_READ_WRITE_TOKEN,
    redisUrl: process.env.UPSTASH_REDIS_REST_URL,
    redisToken: process.env.UPSTASH_REDIS_REST_TOKEN
  };
  process.env.VERCEL = '1';
  process.env.BLOB_READ_WRITE_TOKEN = 'blob-token';
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
  context.after(() => {
    for (const [key, value] of Object.entries({
      VERCEL: previous.vercel,
      BLOB_READ_WRITE_TOKEN: previous.blob,
      UPSTASH_REDIS_REST_URL: previous.redisUrl,
      UPSTASH_REDIS_REST_TOKEN: previous.redisToken
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  let totalActorCalls = 0;

  await context.test('1/10 nhận đúng productId từ URL người dùng cung cấp', async () => {
    const resolved = await resolveTikTokProductUrl(PRODUCT_URL);
    assert.equal(resolved.productId, PRODUCT_ID);
    assert.equal(resolved.productUrl, PRODUCT_URL);
  });

  await context.test('2/10 Redis và Blob trống thì lấy Actor và trả kết quả', async () => {
    const harness = createHarness();
    const result = await analyze(harness, { runId: 'live-empty' });
    assert.equal(result.source.type, 'live');
    assert.equal(harness.actorCalls, 1);
    assert.equal(harness.blobPutCalls, 1);
    totalActorCalls += harness.actorCalls;
  });

  await context.test('3/10 mapping v1 quá năm ngày bị từ chối và lấy Actor mới', async () => {
    const expired = rawDataset('2026-09-10T23:59:59.000Z', { marker: 'expired-v1' });
    const path = `review-datasets/legacy/tiktok-${PRODUCT_ID}/reviews.raw.json`;
    const harness = createHarness({
      [getTikTokCacheKey(PRODUCT_ID)]: cacheMapping(expired, path, 1)
    }, { [path]: expired });
    const result = await analyze(harness, { runId: 'live-after-v1-expired' });
    assert.equal(result.source.type, 'live');
    assert.equal(harness.actorCalls, 1);
    totalActorCalls += harness.actorCalls;
  });

  await context.test('4/10 latest pointer v2 quá năm ngày bị từ chối và lấy Actor mới', async () => {
    const expired = rawDataset('2026-09-10T23:00:00.000Z', { marker: 'expired-v2' });
    const path = `review-datasets/v2/tiktok-${PRODUCT_ID}/reviews.dataset.json`;
    const harness = createHarness({
      [getLatestDatasetPointerKey('tiktok', PRODUCT_ID)]: cacheMapping(expired, path, 2)
    }, { [path]: bundle(expired) });
    const result = await analyze(harness, { runId: 'live-after-v2-expired' });
    assert.equal(result.source.type, 'live');
    assert.equal(harness.actorCalls, 1);
    totalActorCalls += harness.actorCalls;
  });

  await context.test('5/10 tắt cache bằng cấu hình thì chủ động lấy Actor', async () => {
    const current = rawDataset('2026-09-15T00:00:00.000Z', { marker: 'disabled-cache' });
    const path = `review-datasets/cache-disabled/tiktok-${PRODUCT_ID}/reviews.raw.json`;
    const harness = createHarness({
      [getTikTokCacheKey(PRODUCT_ID)]: cacheMapping(current, path, 1)
    }, { [path]: current });
    const result = await analyze(harness, { cacheEnabled: false, runId: 'live-cache-disabled' });
    assert.equal(result.source.type, 'live');
    assert.equal(harness.actorCalls, 1);
    totalActorCalls += harness.actorCalls;
  });

  await context.test('6/10 active cache v1 cũ trả kết quả và tự backfill latest pointer', async () => {
    const current = rawDataset('2026-09-12T00:00:00.000Z', { marker: 'legacy-hit' });
    const path = `review-datasets/legacy/tiktok-${PRODUCT_ID}/reviews.raw.json`;
    const harness = createHarness({
      [getTikTokCacheKey(PRODUCT_ID)]: cacheMapping(current, path, 1)
    }, { [path]: current });
    const result = await analyze(harness);
    assert.equal(result.source.type, 'cached');
    assert.equal(harness.actorCalls, 0);
    assert.ok(harness.redis.values.has(getLatestDatasetPointerKey('tiktok', PRODUCT_ID)));
  });

  await context.test('7/10 active cache bundle v2 trả kết quả không gọi Actor', async () => {
    const current = rawDataset('2026-09-12T00:00:00.000Z', { marker: 'bundle-hit' });
    const path = `review-datasets/v2/tiktok-${PRODUCT_ID}/reviews.dataset.json`;
    const harness = createHarness({
      [getTikTokCacheKey(PRODUCT_ID)]: cacheMapping(current, path, 2)
    }, { [path]: bundle(current) });
    const result = await analyze(harness);
    assert.equal(result.source.type, 'cached');
    assert.equal(result.source.cache.rawOnly, true);
    assert.equal(harness.actorCalls, 0);
  });

  await context.test('8/10 mất active key nhưng latest pointer còn hạn thì phục hồi cache', async () => {
    const current = rawDataset('2026-09-13T00:00:00.000Z', { marker: 'pointer-hit' });
    const path = `review-datasets/v2/tiktok-${PRODUCT_ID}/pointer/reviews.dataset.json`;
    const harness = createHarness({
      [getLatestDatasetPointerKey('tiktok', PRODUCT_ID)]: cacheMapping(current, path, 2)
    }, { [path]: bundle(current) });
    const result = await analyze(harness);
    assert.equal(result.source.type, 'cached');
    assert.equal(result.source.cache.recoveredFromPointer, true);
    assert.equal(harness.actorCalls, 0);
    assert.ok(harness.redis.values.has(getTikTokCacheKey(PRODUCT_ID)));
  });

  await context.test('9/10 đúng biên năm ngày vẫn dùng dataset với TTL tối thiểu', async () => {
    const boundary = rawDataset('2026-09-11T00:00:00.000Z', { marker: 'boundary-hit' });
    const path = `review-datasets/v2/tiktok-${PRODUCT_ID}/boundary/reviews.dataset.json`;
    const harness = createHarness({
      [getTikTokCacheKey(PRODUCT_ID)]: cacheMapping(boundary, path, 2)
    }, { [path]: bundle(boundary) });
    const result = await analyze(harness);
    assert.equal(result.source.type, 'cached');
    assert.equal(result.source.cache.ageMs, 5 * 24 * 60 * 60 * 1000);
    assert.equal(harness.actorCalls, 0);
  });

  await context.test('10/10 cache TikTok 200 reviews tương thích và trả tối đa 200', async () => {
    const current = rawDataset('2026-09-15T00:00:00.000Z', { count: 200, marker: 'two-hundred-hit' });
    const path = `review-datasets/v2/tiktok-${PRODUCT_ID}/two-hundred/reviews.dataset.json`;
    const harness = createHarness({
      [getTikTokCacheKey(PRODUCT_ID)]: cacheMapping(current, path, 2)
    }, { [path]: bundle(current) });
    const result = await analyze(harness);
    assert.equal(result.source.type, 'cached');
    assert.equal(result.stats.scanned, 200);
    assert.equal(harness.actorCalls, 0);
  });

  assert.equal(totalActorCalls, 4);
});

test('partial TikTok không tạo active cache 5 ngày dù dataset lịch sử vẫn được lưu', async (context) => {
  const previous = {
    vercel: process.env.VERCEL,
    blob: process.env.BLOB_READ_WRITE_TOKEN,
    redisUrl: process.env.UPSTASH_REDIS_REST_URL,
    redisToken: process.env.UPSTASH_REDIS_REST_TOKEN
  };
  process.env.VERCEL = '1';
  process.env.BLOB_READ_WRITE_TOKEN = 'blob-token';
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
  context.after(() => {
    for (const [key, value] of Object.entries({
      VERCEL: previous.vercel,
      BLOB_READ_WRITE_TOKEN: previous.blob,
      UPSTASH_REDIS_REST_URL: previous.redisUrl,
      UPSTASH_REDIS_REST_TOKEN: previous.redisToken
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const harness = createHarness({}, {}, { cacheable: false });
  const result = await analyze(harness, { runId: 'partial-not-cacheable' });
  assert.equal(result.source.type, 'live');
  assert.equal(harness.actorCalls, 1);
  assert.equal(harness.blobPutCalls, 1);
  assert.equal(harness.redis.values.has(getTikTokCacheKey(PRODUCT_ID)), false);
  assert.ok(result.warnings.some((warning) => warning.includes('không được dùng để tạo cache 5 ngày')));
});
