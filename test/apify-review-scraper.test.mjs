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

test('chỉ chạy một account, giữ written comments và không gửi starFilter', async () => {
  const inputs = [];
  const result = await collectShopeeReviews('https://shopee.vn/product-i.1.2', {
    allocation: allocation(),
    reviewLimit: 20,
    fetchImpl: async (_url, init) => {
      const input = JSON.parse(init.body);
      inputs.push({ ...input, authorization: init.headers.authorization });
      return {
        ok: true,
        async json() {
          return Array.from({ length: 20 }, (_, index) => ({
            reviewId: `review-${index}`,
            itemId: '2', authorId: `author-${index}`,
            ratingStar: (index % 5) + 1, comment: `Review có nội dung ${index}`,
            createdAt: '2026-08-28T00:00:00.000Z', author: 'Khách đã mua'
          }));
        }
      };
    }
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
    credential: credential(),
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return [
          { reviewId: 'yes', ratingStar: 5, comment: 'Dùng tốt', isVerifiedPurchase: true },
          { reviewId: 'no', ratingStar: 2, comment: 'Không dùng được', isVerifiedPurchase: false },
          { reviewId: 'unknown', ratingStar: 3, comment: 'Dùng tạm ổn' }
        ];
      }
    })
  });
  assert.deepEqual(result.reviews.map((review) => review.verified), [true, false, null]);
});

test('nhận mọi mức sao, bỏ review trống và review trùng', async () => {
  const result = await collectShopeeReviews('https://shopee.vn/product-i.1.2', {
    credential: credential(),
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return [
          { reviewId: 'shared', ratingStar: 5, comment: 'Review năm sao' },
          { reviewId: 'shared', ratingStar: 5, comment: 'Review năm sao' },
          { reviewId: 'one-star', ratingStar: 1, comment: 'Review một sao' },
          { reviewId: 'empty', ratingStar: 3, comment: '' }
        ];
      }
    })
  });

  assert.equal(result.reviews.length, 2);
  assert.deepEqual(result.reviews.map((review) => review.rating).sort(), [1, 5]);
  assert.equal(result.collection.duplicateCount, 1);
  assert.ok(result.warnings.some((warning) => warning.includes('review trùng')));
});

test('không tự đổi credential giữa một lượt khi account bị từ chối hạn mức', async () => {
  await assert.rejects(
    collectShopeeReviews('https://shopee.vn/product-i.1.2', {
      credential: credential(),
      fetchImpl: async () => ({ ok: false, status: 402, async text() { return 'quota exceeded'; } })
    }),
    /không còn quyền\/hạn mức/
  );
});

test('chế độ production lấy tối đa 60 review bằng 3 filter sao song song và khử trùng', async () => {
  const inputs = [];
  const credentialSet = {
    groupId: 'group-production', groupLabel: 'production', source: 'test', maxUsesPerKey: 10,
    retiresAfterReservation: false,
    credentials: [5, 3, 1].map((star) => ({
      id: `key-${star}`, label: `account-${star}`, token: `token-${star}`, star, usageCount: 1
    }))
  };
  const result = await collectShopeeReviews('https://shopee.vn/product-i.1.2', {
    mode: 'production-60',
    credentialSet,
    fetchImpl: async (_url, init) => {
      const input = JSON.parse(init.body);
      inputs.push(input);
      return {
        ok: true,
        async json() {
          return Array.from({ length: 20 }, (_, index) => ({
            reviewId: `${input.starFilter}-${index}`,
            ratingStar: Number(input.starFilter),
            comment: `Review ${input.starFilter} sao số ${index}`
          }));
        }
      };
    }
  });
  assert.equal(inputs.length, 3);
  assert.deepEqual(inputs.map((input) => input.starFilter), ['5', '3', '1']);
  assert.ok(inputs.every((input) => input.contentFilter === 'with comments'));
  assert.ok(inputs.every((input) => input.maxReviewsPerProduct === 20));
  assert.equal(result.reviews.length, 60);
  assert.equal(result.collection.strategy, 'parallel-star-filters');
  assert.equal(result.collection.targetMaximum, 60);
  assert.equal(JSON.stringify(result).includes('token-'), false);
});
