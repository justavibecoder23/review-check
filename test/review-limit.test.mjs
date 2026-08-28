import test from 'node:test';
import assert from 'node:assert/strict';

import { getShopeeReviewLimit, getShopeeReviewsPerStar } from '../src/sources.mjs';

test('uses 10 reviews by default', () => {
  assert.equal(getShopeeReviewLimit(), 10);
});

test('accepts a configured integer', () => {
  assert.equal(getShopeeReviewLimit('25'), 25);
});

test('keeps the review limit between 1 and 100', () => {
  assert.equal(getShopeeReviewLimit('0'), 1);
  assert.equal(getShopeeReviewLimit('500'), 100);
});

test('falls back to 10 for an invalid value', () => {
  assert.equal(getShopeeReviewLimit('khong-hop-le'), 10);
});

test('mỗi star filter mặc định lấy 20 và không vượt quá 20', () => {
  assert.equal(getShopeeReviewsPerStar(), 20);
  assert.equal(getShopeeReviewsPerStar('7'), 7);
  assert.equal(getShopeeReviewsPerStar('200'), 20);
  assert.equal(getShopeeReviewsPerStar('0'), 1);
});
