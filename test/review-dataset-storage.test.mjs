import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveReviewDatasets } from '../src/review-dataset-storage.mjs';

function createRedisFake() {
  const values = new Map();
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
    throw new Error(`Unsupported Redis command: ${command[0]}`);
  }
  return {
    values,
    commands,
    async fetchImpl(url, init) {
      const body = JSON.parse(init.body);
      return { ok: true, async json() { return { result: execute(body) }; } };
    }
  };
}

test('mỗi lượt local lưu một bundle chứa raw và labeled có chung runId', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'realview-dataset-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const review = { rating: 2, text: 'Pin yếu và sạc không vào.', verified: true, labels: { has_defect: true }, labeling: { pipelineVersion: '2.0.0' } };
  const saved = await saveReviewDatasets({
    rawReviews: [review],
    labeledReviews: [{ ...review, labelId: 'r0001', included: false, exclusionReason: 'Dữ liệu kiểm thử' }],
    product: { platform: 'Shopee', itemId: '123', title: 'Sạc dự phòng', image: 'https://example.com/product.jpg' },
    source: { type: 'test' },
    labeling: { engine: 'layer1-only' }
  }, { localRoot: root, runId: 'test-run', now: new Date('2026-08-27T10:00:00.000Z') });

  assert.equal(saved.saved, true);
  assert.equal(saved.rawPath, saved.labeledPath);
  const bundle = JSON.parse(await readFile(saved.bundlePath, 'utf8'));
  const raw = bundle.rawDataset;
  const labeled = bundle.labeledDataset;
  assert.equal(bundle.schemaVersion, '2.0.0');
  assert.equal(bundle.datasetKind, 'review-dataset-bundle');
  assert.equal(raw.runId, 'test-run');
  assert.equal(saved.rawDataset.createdAt, '2026-08-27T10:00:00.000Z');
  assert.equal(saved.rawDataset.product.image, 'https://example.com/product.jpg');
  assert.equal(labeled.runId, 'test-run');
  assert.equal(raw.reviews[0].labels, undefined);
  assert.equal(labeled.reviews[0].labels.has_defect, true);
  assert.equal(labeled.reviews[0].included, false);
  assert.equal(labeled.reviews[0].exclusionReason, 'Dữ liệu kiểm thử');
});

test('Vercel không có Blob token phải báo không lưu thay vì ghi vào filesystem tạm', async () => {
  const previousVercel = process.env.VERCEL;
  const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
  process.env.VERCEL = '1';
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    const result = await saveReviewDatasets({ rawReviews: [], labeledReviews: [] }, { runId: 'no-token' });
    assert.equal(result.saved, false);
    assert.equal(result.provider, 'none');
    assert.match(result.warning, /BLOB_READ_WRITE_TOKEN/);
  } finally {
    if (previousVercel) process.env.VERCEL = previousVercel;
    else delete process.env.VERCEL;
    if (previousToken) process.env.BLOB_READ_WRITE_TOKEN = previousToken;
    else delete process.env.BLOB_READ_WRITE_TOKEN;
  }
});

test('dataset TikTok dùng productId ổn định và không mang tiền tố Shopee', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'realview-tiktok-dataset-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const saved = await saveReviewDatasets({
    rawReviews: [],
    labeledReviews: [],
    product: { platform: 'TikTok Shop', productId: '1732811145572746350', title: 'Sản phẩm' }
  }, { localRoot: root, runId: 'tiktok-run', now: new Date('2026-08-27T10:00:00.000Z') });
  assert.match(saved.rawPath, /tiktok-1732811145572746350/);
  assert.doesNotMatch(saved.rawPath, /shopee-/);
});

test('Vercel ghi đúng một bundle và không tạo dataset trùng cho cùng raw reviews', async (context) => {
  const previous = {
    vercel: process.env.VERCEL,
    token: process.env.BLOB_READ_WRITE_TOKEN,
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
      BLOB_READ_WRITE_TOKEN: previous.token,
      UPSTASH_REDIS_REST_URL: previous.redisUrl,
      UPSTASH_REDIS_REST_TOKEN: previous.redisToken
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const redis = createRedisFake();
  let putCalls = 0;
  let storedPayload;
  const blobPutImpl = async (pathname, body) => {
    putCalls += 1;
    storedPayload = JSON.parse(body);
    return { pathname, url: `https://blob.test/${pathname}` };
  };
  const input = {
    rawReviews: [
      { reviewId: 'r1', rating: 5, text: 'Dùng ổn và pin tốt.' },
      { reviewId: 'r0', rating: 4, text: 'Đóng gói tốt.' }
    ],
    labeledReviews: [
      { reviewId: 'r1', rating: 5, text: 'Dùng ổn và pin tốt.', included: true },
      { reviewId: 'r0', rating: 4, text: 'Đóng gói tốt.', included: false }
    ],
    product: { platform: 'Shopee', itemId: '123', title: 'Sản phẩm' },
    source: { type: 'live', collection: { strategy: 'parallel-star-filters' } }
  };
  const first = await saveReviewDatasets(input, {
    runId: 'run-one',
    now: new Date('2026-09-16T00:00:00.000Z'),
    redisFetchImpl: redis.fetchImpl,
    blobPutImpl
  });
  const second = await saveReviewDatasets({
    ...input,
    rawReviews: [...input.rawReviews].reverse(),
    labeledReviews: [...input.labeledReviews].reverse()
  }, {
    runId: 'run-two',
    now: new Date('2026-09-16T00:00:01.000Z'),
    redisFetchImpl: redis.fetchImpl,
    blobPutImpl
  });

  assert.equal(first.saved, true);
  assert.equal(first.blobOperations, 1);
  assert.equal(second.saved, true);
  assert.equal(second.reused, true);
  assert.equal(second.blobOperations, 0);
  assert.equal(second.runId, 'run-one');
  assert.equal(second.rawDataset.createdAt, '2026-09-16T00:00:00.000Z');
  assert.equal(putCalls, 1);
  assert.equal(storedPayload.datasetKind, 'review-dataset-bundle');
  assert.equal(storedPayload.rawDataset.reviews.length, 2);
  assert.equal(storedPayload.labeledDataset.reviews.length, 2);

  putCalls = 0;
  const concurrentInput = {
    ...input,
    rawReviews: [{ reviewId: 'r2', rating: 4, text: 'Hai request đồng thời.' }],
    labeledReviews: [{ reviewId: 'r2', rating: 4, text: 'Hai request đồng thời.', included: true }],
    product: { ...input.product, itemId: '456' }
  };
  const delayedPut = async (pathname, body) => {
    putCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { pathname, url: `https://blob.test/${pathname}`, body };
  };
  const concurrent = await Promise.all([
    saveReviewDatasets(concurrentInput, {
      runId: 'concurrent-one', now: new Date('2026-09-16T00:01:00.000Z'),
      redisFetchImpl: redis.fetchImpl, blobPutImpl: delayedPut
    }),
    saveReviewDatasets(concurrentInput, {
      runId: 'concurrent-two', now: new Date('2026-09-16T00:01:01.000Z'),
      redisFetchImpl: redis.fetchImpl, blobPutImpl: delayedPut
    })
  ]);
  assert.equal(putCalls, 1);
  assert.equal(concurrent.filter((result) => result.blobOperations === 1).length, 1);
  assert.equal(concurrent.filter((result) => result.reused && result.blobOperations === 0).length, 1);
});

test('Blob PUT lỗi phải nhả khóa ngay để lần lưu kế tiếp không chờ 120 giây', async (context) => {
  const previous = {
    vercel: process.env.VERCEL,
    token: process.env.BLOB_READ_WRITE_TOKEN,
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
      BLOB_READ_WRITE_TOKEN: previous.token,
      UPSTASH_REDIS_REST_URL: previous.redisUrl,
      UPSTASH_REDIS_REST_TOKEN: previous.redisToken
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const redis = createRedisFake();
  const input = {
    rawReviews: [{ reviewId: 'retry-1', rating: 5, text: 'Dữ liệu thử lại sau lỗi Blob.' }],
    labeledReviews: [{ reviewId: 'retry-1', rating: 5, text: 'Dữ liệu thử lại sau lỗi Blob.', included: true }],
    product: { platform: 'TikTok Shop', productId: '1729498401361201911', title: 'Nước tẩy trang' },
    source: { type: 'live', collection: { strategy: 'single-unfiltered' } }
  };
  const failed = await saveReviewDatasets(input, {
    runId: 'failed-put',
    now: new Date('2026-09-16T00:00:00.000Z'),
    redisFetchImpl: redis.fetchImpl,
    blobPutImpl: async () => { throw new Error('Blob unavailable'); }
  });
  assert.equal(failed.saved, false);
  assert.equal([...redis.values.keys()].some((key) => key.endsWith(':lock')), false);

  let putCalls = 0;
  const retried = await saveReviewDatasets(input, {
    runId: 'successful-retry',
    now: new Date('2026-09-16T00:00:01.000Z'),
    redisFetchImpl: redis.fetchImpl,
    blobPutImpl: async (pathname) => {
      putCalls += 1;
      return { pathname, url: `https://blob.test/${pathname}` };
    }
  });
  assert.equal(retried.saved, true);
  assert.equal(retried.blobOperations, 1);
  assert.equal(putCalls, 1);
});
