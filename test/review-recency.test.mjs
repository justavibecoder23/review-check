import test from 'node:test';
import assert from 'node:assert/strict';
import { collectShopeeReviews } from '../src/apify-review-scraper.mjs';
import { collectTikTokReviews } from '../src/apify-tiktok-review-scraper.mjs';

function jsonResponse(value) {
  return {
    ok: true,
    status: 200,
    json: async () => value,
    text: async () => JSON.stringify(value)
  };
}

test('Shopee trả review mới nhất trước trong mẫu đã thu thập', async () => {
  const items = [
    { reviewId: 'old', ratingStar: 4, comment: 'Review cũ có nội dung', createdAt: '2024-01-01T00:00:00.000Z' },
    { reviewId: 'new', ratingStar: 4, comment: 'Review mới có nội dung', createdAt: '2026-08-01T00:00:00.000Z' }
  ];
  const result = await collectShopeeReviews('https://shopee.vn/product-i.1.2', {
    mode: 'demo',
    credential: { id: 'test', label: 'test', token: 'test-token' },
    fetchImpl: async (url) => {
      if (url.includes('/runs?')) return jsonResponse({ data: {
        id: 'shopee-recency-run', status: 'SUCCEEDED', defaultDatasetId: 'shopee-recency-dataset', usageTotalUsd: 0.00802
      } });
      if (url.includes('/datasets/')) return jsonResponse(items);
      throw new Error(`Unexpected Apify URL: ${url}`);
    }
  });
  assert.deepEqual(result.reviews.map((review) => review.reviewId), ['new', 'old']);
});

test('TikTok yêu cầu most_recent và trả review mới nhất trước', async () => {
  let actorInput;
  const result = await collectTikTokReviews('1735143598757348483', {
    allocation: {
      source: 'test',
      credentials: [{ id: 'test', label: 'test', token: 'test-token', plannedReviews: 100 }]
    },
    fetchImpl: async (_url, options) => {
      actorInput = JSON.parse(options.body);
      return jsonResponse([
        { review_id: 'old', product_id: '1735143598757348483', review_rating: 4, review_text: 'Review cũ có nội dung', review_time: '1704067200000' },
        { review_id: 'new', product_id: '1735143598757348483', review_rating: 4, review_text: 'Review mới có nội dung', review_time: '1785542400000' }
      ]);
    }
  });
  assert.equal(actorInput.reviews_sort, 'most_recent');
  assert.deepEqual(result.reviews.map((review) => review.reviewId), ['new', 'old']);
});
