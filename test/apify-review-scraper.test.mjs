import test from 'node:test';
import assert from 'node:assert/strict';
import { collectShopeeReviewsParallel, SHOPEE_STAR_FILTERS } from '../src/apify-review-scraper.mjs';

function credential() {
  return { token: 'apify_api_test_token_123456', id: 'test-id', label: 'test-active', source: 'test', warnings: [] };
}

function credentialSet() {
  return {
    groupId: 'group-1', groupLabel: 'primary-5-accounts', source: 'test', maxUsesPerKey: 10,
    retiresAfterReservation: false,
    credentials: [5, 4, 3, 2, 1].map((star) => ({
      star, id: `key-${star}`, label: `account-${star}-star`, token: `apify_api_token_for_${star}_star`, usageCount: 1
    }))
  };
}

test('khởi động đồng thời 5 run với đúng starFilter và written comments', async () => {
  const inputs = [];
  let active = 0;
  let maxActive = 0;
  const result = await collectShopeeReviewsParallel('https://shopee.vn/product-i.1.2', {
    credentialSet: credentialSet(),
    perStarLimit: 20,
    fetchImpl: async (_url, init) => {
      const input = JSON.parse(init.body);
      inputs.push({ ...input, authorization: init.headers.authorization });
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return {
        ok: true,
        async json() {
          return Array.from({ length: 20 }, (_, index) => ({
            reviewId: `review-${input.starFilter}-${index}`,
            itemId: '2', authorId: `author-${input.starFilter}-${index}`,
            ratingStar: Number(input.starFilter), comment: `Review ${input.starFilter} sao có nội dung ${index}`,
            createdAt: '2026-08-28T00:00:00.000Z', author: 'Khách đã mua'
          }));
        }
      };
    }
  });

  assert.equal(maxActive, 5);
  assert.equal(inputs.length, 5);
  assert.deepEqual(inputs.map((input) => input.starFilter).sort(), [...SHOPEE_STAR_FILTERS].sort());
  assert.ok(inputs.every((input) => input.contentFilter === 'with comments'));
  assert.ok(inputs.every((input) => input.maxReviewsPerProduct === 20));
  assert.ok(inputs.every((input) => input.authorization === `Bearer apify_api_token_for_${input.starFilter}_star`));
  assert.equal(result.reviews.length, 100);
  assert.equal(result.collection.targetMaximum, 100);
  assert.equal(result.credential.keys.length, 5);
  assert.equal(JSON.stringify(result).includes('apify_api_token_for_'), false);
});

test('lọc sai mức sao, bỏ review trùng và vẫn trả kết quả khi một run lỗi', async () => {
  const result = await collectShopeeReviewsParallel('https://shopee.vn/product-i.1.2', {
    credential: credential(),
    fetchImpl: async (_url, init) => {
      const { starFilter } = JSON.parse(init.body);
      if (starFilter === '1') return { ok: false, status: 503, async text() { return 'temporary'; } };
      return {
        ok: true,
        async json() {
          return [
            { reviewId: 'shared', ratingStar: Number(starFilter), comment: `Review ${starFilter} sao` },
            { reviewId: `wrong-${starFilter}`, ratingStar: 1, comment: 'Sai nhóm sao' },
            { reviewId: `empty-${starFilter}`, ratingStar: Number(starFilter), comment: '' }
          ];
        }
      };
    }
  });

  assert.equal(result.reviews.length, 1);
  assert.equal(result.collection.duplicateCount, 3);
  assert.ok(result.warnings.some((warning) => warning.includes('503')));
  assert.ok(result.warnings.some((warning) => warning.includes('không khớp starFilter')));
});

test('không tự đổi credential khi cả 5 run bị từ chối hạn mức', async () => {
  await assert.rejects(
    collectShopeeReviewsParallel('https://shopee.vn/product-i.1.2', {
      credential: credential(),
      fetchImpl: async () => ({ ok: false, status: 402, async text() { return 'quota exceeded'; } })
    }),
    /không còn quyền\/hạn mức/
  );
});
