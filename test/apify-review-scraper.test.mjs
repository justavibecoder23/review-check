import test from 'node:test';
import assert from 'node:assert/strict';
import { collectShopeeReviews } from '../src/apify-review-scraper.mjs';

function credential() {
  return { token: 'apify_api_test_token_123456', id: 'test-id', label: 'test-active', source: 'test', warnings: [] };
}

function allocation() {
  return {
    groupId: 'group-1', groupLabel: 'primary-5-accounts', source: 'test', maxUsesPerKey: 10,
    retiresAfterReservation: false,
    credential: { id: 'key-active', label: 'account-active', token: 'apify_api_token_active', usageCount: 1 }
  };
}

function productionCredentialSet() {
  return {
    groupId: 'group-production', groupLabel: 'production', source: 'test', maxUsesPerKey: 10,
    retiresAfterReservation: false,
    credentials: [5, 4, 3, 2, 1].map((star) => ({
      id: `key-${star}`, label: `account-${star}`, token: `token-${star}`, star, usageCount: 1
    }))
  };
}

function apifyActorFetch(itemsForInput, { onInput, log = '', startStatus = 201 } = {}) {
  const datasets = new Map();
  let sequence = 0;
  return async (url, init = {}) => {
    if (url.includes('/runs?')) {
      const input = JSON.parse(init.body);
      onInput?.(input, init);
      const runId = `run-${++sequence}`;
      const datasetId = `dataset-${sequence}`;
      datasets.set(datasetId, await itemsForInput(input));
      return {
        ok: true,
        status: startStatus,
        async json() {
          return { data: { id: runId, status: 'SUCCEEDED', defaultDatasetId: datasetId, usageTotalUsd: 0.00801 } };
        }
      };
    }
    if (url.includes('/datasets/')) {
      const datasetId = decodeURIComponent(url.match(/\/datasets\/([^/]+)/)?.[1] || '');
      return { ok: true, status: 200, async json() { return datasets.get(datasetId) || []; } };
    }
    if (url.includes('/logs/')) return { ok: true, status: 200, async text() { return log; } };
    throw new Error(`Unexpected Apify URL: ${url}`);
  };
}

test('chỉ chạy một account, giữ written comments và không gửi starFilter', async () => {
  const inputs = [];
  const result = await collectShopeeReviews('https://shopee.vn/product-i.1.2', {
    mode: 'demo',
    allocation: allocation(),
    reviewLimit: 20,
    fetchImpl: apifyActorFetch(async () => (
      Array.from({ length: 20 }, (_, index) => ({
            reviewId: `review-${index}`,
            itemId: '2', authorId: `author-${index}`,
            ratingStar: (index % 5) + 1, comment: `Review có nội dung ${index}`,
            createdAt: '2026-08-28T00:00:00.000Z', author: 'Khách đã mua'
          }))
    ), { onInput: (input, init) => inputs.push({ ...input, authorization: init.headers.authorization }) })
  });

  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].starFilter, undefined);
  assert.equal(inputs[0].contentFilter, 'with comments');
  assert.equal(inputs[0].maxReviewsPerProduct, 20);
  assert.equal(inputs[0].authorization, 'Bearer apify_api_token_active');
  assert.equal(result.reviews.length, 20);
  assert.equal(result.collection.strategy, 'single-unfiltered');
  assert.equal(result.collection.targetMaximum, 20);
  assert.equal(result.credential.keys.length, 1);
  assert.equal(result.reviews[0].verified, null);
  assert.equal(JSON.stringify(result).includes('apify_api_token_active'), false);
});

test('Shopee chỉ ghi đã xác minh khi actor cung cấp tín hiệu rõ ràng', async () => {
  const result = await collectShopeeReviews('https://shopee.vn/product-i.1.2', {
    mode: 'demo',
    credential: credential(),
    fetchImpl: apifyActorFetch(async () => ([
          { reviewId: 'yes', ratingStar: 5, comment: 'Dùng tốt', isVerifiedPurchase: true },
          { reviewId: 'no', ratingStar: 2, comment: 'Không dùng được', isVerifiedPurchase: false },
          { reviewId: 'unknown', ratingStar: 3, comment: 'Dùng tạm ổn' }
        ]))
  });
  assert.deepEqual(result.reviews.map((review) => review.verified), [true, false, null]);
});

test('nhận mọi mức sao, bỏ review trống và review trùng', async () => {
  const result = await collectShopeeReviews('https://shopee.vn/product-i.1.2', {
    mode: 'demo',
    credential: credential(),
    fetchImpl: apifyActorFetch(async () => ([
          { reviewId: 'shared', ratingStar: 5, comment: 'Review năm sao' },
          { reviewId: 'shared', ratingStar: 5, comment: 'Review năm sao' },
          { reviewId: 'one-star', ratingStar: 1, comment: 'Review một sao' },
          { reviewId: 'empty', ratingStar: 3, comment: '' }
        ]))
  });

  assert.equal(result.reviews.length, 2);
  assert.deepEqual(result.reviews.map((review) => review.rating).sort(), [1, 5]);
  assert.equal(result.collection.duplicateCount, 1);
  assert.ok(result.warnings.some((warning) => warning.includes('review trùng')));
});

test('không tự đổi credential giữa một lượt khi account bị từ chối hạn mức', async () => {
  await assert.rejects(
    collectShopeeReviews('https://shopee.vn/product-i.1.2', {
      mode: 'demo',
      credential: credential(),
      fetchImpl: async () => ({ ok: false, status: 402, async text() { return 'quota exceeded'; } })
    }),
    /không còn quyền\/hạn mức/
  );
});

test('mặc định production lấy tối đa 100 review bằng 5 filter sao song song và khử trùng', async () => {
  const inputs = [];
  const credentialSet = productionCredentialSet();
  const result = await collectShopeeReviews('https://shopee.vn/product-i.1.2', {
    credentialSet,
    fetchImpl: apifyActorFetch(async (input) => (
      Array.from({ length: 20 }, (_, index) => ({
            reviewId: `${input.starFilter}-${index}`,
            ratingStar: Number(input.starFilter),
            comment: `Review ${input.starFilter} sao số ${index}`
          }))
    ), { onInput: (input) => inputs.push(input) })
  });
  assert.equal(inputs.length, 5);
  assert.deepEqual(inputs.map((input) => input.starFilter), ['5', '4', '3', '2', '1']);
  assert.ok(inputs.every((input) => input.contentFilter === 'with comments'));
  assert.ok(inputs.every((input) => input.maxReviewsPerProduct === 20));
  assert.equal(result.reviews.length, 100);
  assert.equal(result.collection.strategy, 'parallel-star-filters');
  assert.deepEqual(result.collection.ratingStrata, [1, 2, 3, 4, 5]);
  assert.equal(result.collection.targetMaximum, 100);
  assert.equal(JSON.stringify(result).includes('token-'), false);
});

test('Shopee production chốt riêng năm reservation vào sổ cái v4', async () => {
  const finalized = [];
  const credentialSet = productionCredentialSet();
  credentialSet.source = 'redis-vault-cost-ledger-v4';
  credentialSet.credentials = credentialSet.credentials.map((credential) => ({
    ...credential,
    billingAccountId: `account-${credential.star}`,
    accountCycleId: `account-${credential.star}:2026-09-14T00:00:00.000Z`,
    billingCycleStartAt: '2026-09-14T00:00:00.000Z',
    billingCycleEndAt: '2026-10-13T23:59:59.999Z',
    reservationId: `reservation-${credential.star}`
  }));
  const result = await collectShopeeReviews('https://shopee.vn/product-i.1.2', {
    credentialSet,
    finalizeImpl: async (credential, run) => finalized.push({ credential, run }),
    fetchImpl: apifyActorFetch(async (input) => {
      const star = Number(input.starFilter);
      return [{ reviewId: `review-${star}`, ratingStar: star, comment: `Review ${star} sao có nội dung.` }];
    })
  });
  assert.equal(finalized.length, 5);
  assert.ok(finalized.every(({ run }) => run.statusCode === 201 && run.reviewCount === 1 && run.actorStarted));
  assert.ok(finalized.every(({ run }) => run.actualCostMicroUsd === 8_010));
  assert.equal(result.usage.tracked, true);
  assert.equal(result.usage.billingCycles.length, 5);
});

test('dataset rỗng không được coi là hết free tier nếu log không có tín hiệu', async () => {
  const finalized = [];
  const credentialSet = productionCredentialSet();
  credentialSet.source = 'redis-vault-cost-ledger-v4';
  credentialSet.credentials = credentialSet.credentials.map((item) => ({
    ...item,
    billingAccountId: `account-${item.star}`,
    accountCycleId: `account-${item.star}:cycle`,
    reservationId: `reservation-${item.star}`
  }));
  await collectShopeeReviews('https://shopee.vn/product-i.1.2', {
    credentialSet,
    finalizeImpl: async (item, run) => finalized.push({ item, run }),
    fetchImpl: apifyActorFetch(async (input) => Number(input.starFilter) === 5
      ? [{ reviewId: 'one', ratingStar: 5, comment: 'Có nội dung' }]
      : [])
  });
  assert.equal(finalized.filter(({ run }) => run.reviewCount === 0).length, 4);
  assert.ok(finalized.filter(({ run }) => run.reviewCount === 0).every(({ run }) => run.actorStarted && !run.freeTierExhausted));
});

test('dataset rỗng có log free tier được phân loại để khóa đúng actor', async () => {
  const credentialSet = productionCredentialSet();
  await assert.rejects(collectShopeeReviews('https://shopee.vn/product-i.1.2', {
    credentialSet,
    fetchImpl: apifyActorFetch(async () => [], { log: 'Free tier limit reached' })
  }), /Không lấy được reviews Shopee/);
});
