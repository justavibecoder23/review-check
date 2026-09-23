import test from 'node:test';
import assert from 'node:assert/strict';
import { collectTikTokReviews } from '../src/apify-tiktok-review-scraper.mjs';

function allocation(count = 5, plannedReviews = count === 5 ? 20 : 100) {
  return {
    source: 'test',
    maxReviewsPerKey: 6200,
    credentials: Array.from({ length: count }, (_, index) => ({
      id: `key-${index + 1}`,
      label: `account-${index + 1}`,
      token: `apify_api_test_token_${index + 1}`,
      runCount: 1,
      reviewCount: 0,
      plannedReviews
    }))
  };
}

function jsonResponse(value, status = 200) {
  return {
    ok: true,
    status,
    headers: { get: () => null },
    async json() { return value; },
    async text() { return JSON.stringify(value); }
  };
}

function progressiveActorFetch(snapshots, options = {}) {
  const states = Array.isArray(snapshots) ? snapshots : [snapshots];
  let datasetPoll = 0;
  return async (url, init = {}) => {
    if (url.includes('/runs?')) {
      const input = JSON.parse(init.body);
      options.onInput?.(input);
      return jsonResponse({ data: {
        id: 'actor-run-1', status: 'RUNNING', defaultDatasetId: 'dataset-1'
      } }, 201);
    }
    if (url.includes('/datasets/')) {
      const value = states[Math.min(datasetPoll, states.length - 1)] || [];
      datasetPoll += 1;
      return jsonResponse(value);
    }
    if (url.includes('/actor-runs/')) {
      const status = datasetPoll >= states.length ? 'SUCCEEDED' : 'RUNNING';
      return jsonResponse({ data: {
        id: 'actor-run-1', status, defaultDatasetId: 'dataset-1'
      } });
    }
    throw new Error(`Unexpected Apify URL: ${url}`);
  };
}

test('TikTok chia 100 review thành 5 star filter chạy song song và không lộ token', async () => {
  const inputs = [];
  const result = await collectTikTokReviews('1729384756102938475', {
    allocation: allocation(),
    fetchImpl: async (_url, init) => {
      const input = JSON.parse(init.body);
      inputs.push(input);
      const star = Number(input.reviews_filter[0]);
      return {
        ok: true,
        async json() {
          return Array.from({ length: 20 }, (_, index) => ({
            review_id: `${star}-${index}`,
            product_id: '1729384756102938475',
            review_rating: star,
            review_text: `Trải nghiệm mức ${star} sao số ${index}`,
            review_time: '1788048000000',
            is_verified_purchase: true,
            product_name: 'Tai nghe thử nghiệm'
          }));
        }
      };
    }
  });

  assert.equal(inputs.length, 5);
  assert.deepEqual(inputs.map((input) => input.reviews_filter), ['5_star', '4_star', '3_star', '2_star', '1_star']);
  assert.ok(inputs.every((input) => input.reviews_limit === 20));
  assert.ok(inputs.every((input) => input.region === 'VN'));
  assert.equal(result.reviews.length, 100);
  assert.equal(result.collection.strategy, 'parallel-star-filters');
  assert.deepEqual(result.collection.ratingStrata, [1, 2, 3, 4, 5]);
  assert.equal(result.collection.perStarLimit, 20);
  assert.equal(result.productMeta.title, 'Tai nghe thử nghiệm');
  assert.equal(result.reviews[0].createdAt, '2026-08-30T00:00:00.000Z');
  assert.equal(JSON.stringify(result).includes('apify_api_test_token'), false);
});

test('TikTok hậu kiểm mức sao, bỏ bình luận trống và chống trùng nội dung cùng ID', async () => {
  const result = await collectTikTokReviews('1729384756102938475', {
    allocation: allocation(),
    fetchImpl: async (_url, init) => {
      const filter = JSON.parse(init.body).reviews_filter;
      return {
        ok: true,
        async json() {
          const unique = { review_id: `unique-${filter}`, review_rating: Number(filter[0]), review_text: `Nội dung riêng ${filter}` };
          return [
            { review_id: 'shared', review_rating: 5, review_text: 'Review bị trả trùng' },
            unique,
            { ...unique },
            { review_id: `empty-${filter}`, review_rating: 3, review_text: '   ' }
          ];
        }
      };
    }
  });
  assert.equal(result.reviews.length, 6);
  assert.equal(result.collection.duplicateCount, 5);
  assert.equal(result.collection.emptyCommentCount, 1);
  assert.equal(result.collection.wrongRatingCount, 8);
  assert.ok(result.collection.runs.every((run) => run.filter === 'all'
    || result.reviews.filter((review) => review.rating === Number(run.filter[0])).length > 0));
  assert.ok(result.warnings.some((warning) => warning.includes('không khớp bộ lọc sao')));
  assert.ok(result.warnings.some((warning) => warning.includes('không có bình luận viết')));
  assert.ok(result.warnings.some((warning) => warning.includes('review TikTok trùng')));
});

test('TikTok giữ trạng thái xác minh là không rõ khi actor không cung cấp', async () => {
  const result = await collectTikTokReviews('1729384756102938475', {
    allocation: allocation(1),
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return [{ review_id: 'unknown-verification', review_rating: 5, review_text: 'Sản phẩm chắc chắn và dùng ổn.' }];
      }
    })
  });
  assert.equal(result.reviews[0].verified, null);
});

test('TikTok dùng một account unfiltered khi allocation chỉ có một key', async () => {
  const inputs = [];
  const result = await collectTikTokReviews('1729384756102938475', {
    allocation: allocation(1),
    fetchImpl: async (_url, init) => {
      inputs.push(JSON.parse(init.body));
      return { ok: true, async json() { return []; } };
    }
  });
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].reviews_filter, 'all');
  assert.equal(inputs[0].reviews_limit, 100);
  assert.equal(result.collection.strategy, 'single-unfiltered');
});

test('actor tạm thời dùng URL đầy đủ, đọc schema lồng và gắn metadata phương pháp', async () => {
  const productId = '1729384756102938475';
  let actorInput;
  const result = await collectTikTokReviews(productId, {
    productUrl: `https://shop.tiktok.com/view/product/${productId}`,
    runtimeOptions: { useTemporaryActor: true, env: {} },
    allocation: allocation(1, 100),
    pollIntervalMs: 0,
    fetchImpl: progressiveActorFetch([[{ data: {
            product: {
              name: 'Sản phẩm thử nghiệm',
              image: 'https://p16-oec-sg.ibyteimg.com/tos/product-cover.webp'
            },
            reviews: [{
              id: 'nested-1', productId, rating: 4, content: 'Đóng gói tốt và giao đúng mô tả.',
              createdAt: '2026-09-08T00:00:00.000Z'
            }]
          } }]], { onInput: (input) => { actorInput = input; } })
  });
  assert.deepEqual(actorInput.startUrls, [`https://shop.tiktok.com/view/product/${productId}`]);
  assert.equal(actorInput.maxReviews, 100);
  assert.equal(actorInput.region, 'VN');
  assert.equal(result.reviews[0].text, 'Đóng gói tốt và giao đúng mô tả.');
  assert.equal(result.collection.adapter, 'vistics');
  assert.equal(result.collection.samplingStrategy, 'most-recent-100');
  assert.equal(result.collection.targetMaximum, 100);
  assert.equal(result.collection.distributionMode, 'observed-sample');
  assert.equal(result.collection.temporaryActor, true);
  assert.deepEqual(result.productMeta, {
    title: 'Sản phẩm thử nghiệm',
    image: 'https://p16-oec-sg.ibyteimg.com/tos/product-cover.webp'
  });
});

test('actor tạm thời giữ tối đa 100 review sau khử trùng', async () => {
  const productId = '1729384756102938475';
  const result = await collectTikTokReviews(productId, {
    productUrl: `https://shop.tiktok.com/view/product/${productId}`,
    runtimeOptions: { useTemporaryActor: true, env: {} },
    allocation: allocation(1, 100),
    pollIntervalMs: 0,
    fetchImpl: progressiveActorFetch([Array.from({ length: 205 }, (_, index) => ({
          id: `temporary-${index}`,
          productId,
          rating: 5,
          content: `Nội dung review TikTok tạm thời số ${index}`,
          createdAt: new Date(Date.UTC(2026, 8, 9, 0, 0, index)).toISOString()
        }))])
  });
  assert.equal(result.reviews.length, 100);
  assert.equal(result.collection.returned, 100);
  assert.equal(result.collection.targetMaximum, 100);
});

test('actor tạm thời đọc dataset tăng dần và cập nhật tiến độ 10 → 40 → 100', async () => {
  const productId = '1729384756102938475';
  const makeItems = (count) => Array.from({ length: count }, (_, index) => ({
    id: `progressive-${index}`,
    productId,
    rating: 5,
    content: `Review tích lũy số ${index}`,
    createdAt: '2026-09-09T00:00:00.000Z'
  }));
  const progress = [];
  const result = await collectTikTokReviews(productId, {
    productUrl: `https://shop.tiktok.com/view/product/${productId}`,
    runtimeOptions: { useTemporaryActor: true, env: {} },
    allocation: allocation(1, 100),
    pollIntervalMs: 0,
    onProgress: (entry) => progress.push(entry.message),
    fetchImpl: progressiveActorFetch([makeItems(10), makeItems(40), makeItems(100)])
  });

  assert.equal(result.reviews.length, 100);
  assert.equal(result.collection.cacheable, true);
  assert.equal(result.collection.completionReason, 'target-reached');
  assert.equal(result.collection.runs[0].datasetPollCount, 3);
  assert.ok(progress.some((message) => message.includes('10/100')));
  assert.ok(progress.some((message) => message.includes('40/100')));
  assert.ok(progress.some((message) => message.includes('100/100')));
});

test('actor tạm thời lỗi khi polling vẫn trả partial >=20 nhưng không cho cache', async () => {
  const productId = '1729384756102938475';
  let datasetRead = false;
  let finalized;
  const costAllocation = allocation(1, 100);
  costAllocation.source = 'redis-vault-cost-ledger-v4';
  costAllocation.credentials[0].billingAccountId = 'account-1';
  costAllocation.credentials[0].reservationId = 'reservation-1';
  const result = await collectTikTokReviews(productId, {
    productUrl: `https://shop.tiktok.com/view/product/${productId}`,
    runtimeOptions: { useTemporaryActor: true, env: {} },
    allocation: costAllocation,
    pollIntervalMs: 0,
    finalizeImpl: async (_credential, actorResult) => { finalized = actorResult; },
    fetchImpl: async (url) => {
      if (url.includes('/runs?')) return jsonResponse({ data: {
        id: 'partial-run', status: 'RUNNING', defaultDatasetId: 'partial-dataset'
      } }, 201);
      if (url.includes('/datasets/')) {
        datasetRead = true;
        return jsonResponse(Array.from({ length: 25 }, (_, index) => ({
          id: `partial-${index}`, productId, rating: 4,
          content: `Review partial hợp lệ ${index}`
        })));
      }
      if (url.includes('/actor-runs/') && datasetRead) {
        throw Object.assign(new Error('polling timeout'), { name: 'TimeoutError' });
      }
      throw new Error(`Unexpected Apify URL: ${url}`);
    }
  });

  assert.equal(result.reviews.length, 25);
  assert.equal(result.collection.cacheable, false);
  assert.equal(result.collection.completionReason, 'request-failed-partial');
  assert.equal(finalized.actorStarted, true);
  assert.equal(finalized.actorRunId, 'partial-run');
  assert.equal(finalized.reviewCount, 25);
});

test('actor tạm thời lỗi trước ngưỡng 20 review thì không trả kết quả thiếu', async () => {
  const productId = '1729384756102938475';
  await assert.rejects(() => collectTikTokReviews(productId, {
    productUrl: `https://shop.tiktok.com/view/product/${productId}`,
    runtimeOptions: { useTemporaryActor: true, env: {} },
    allocation: allocation(1, 100),
    pollIntervalMs: 0,
    fetchImpl: async (url) => {
      if (url.includes('/runs?')) return jsonResponse({ data: {
        id: 'short-run', status: 'RUNNING', defaultDatasetId: 'short-dataset'
      } }, 201);
      if (url.includes('/datasets/')) return jsonResponse(Array.from({ length: 19 }, (_, index) => ({
        id: `short-${index}`, productId, rating: 5, content: `Review ngắn ${index}`
      })));
      if (url.includes('/actor-runs/')) throw Object.assign(new Error('polling timeout'), { name: 'TimeoutError' });
      throw new Error(`Unexpected Apify URL: ${url}`);
    }
  }), /Không lấy được reviews TikTok/);
});

test('HTTP 429 chỉ tạo cooldown, không bị phân loại hết ngân sách', async () => {
  let finalized;
  const costAllocation = allocation(1);
  costAllocation.source = 'redis-vault-cost-ledger-v4';
  costAllocation.billingPeriod = '2026-09';
  costAllocation.credentials[0].billingAccountId = 'account-1';
  costAllocation.credentials[0].reservationId = 'reservation-1';
  await assert.rejects(() => collectTikTokReviews('1729384756102938475', {
    allocation: costAllocation,
    finalizeImpl: async (_credential, result) => { finalized = result; },
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      headers: { get: () => '60' },
      async text() { return 'rate limited'; }
    })
  }), /Không lấy được reviews TikTok/);
  assert.equal(finalized.failureClass, 'temporary_throttle');
  assert.equal(finalized.statusCode, 429);
});
