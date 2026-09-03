import test from 'node:test';
import assert from 'node:assert/strict';
import { collectTikTokReviews } from '../src/apify-tiktok-review-scraper.mjs';

function allocation(count = 5) {
  return {
    source: 'test',
    maxReviewsPerKey: 6200,
    credentials: Array.from({ length: count }, (_, index) => ({
      id: `key-${index + 1}`,
      label: `account-${index + 1}`,
      token: `apify_api_test_token_${index + 1}`,
      runCount: 1,
      reviewCount: 0,
      plannedReviews: count === 5 ? 20 : 100
    }))
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
