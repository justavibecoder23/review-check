import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertEnoughReviews,
  MINIMUM_REVIEWS_FOR_ANALYSIS
} from '../src/analysis-eligibility.mjs';

test('không phân tích sản phẩm có dưới 20 review', () => {
  const reviews = Array.from({ length: 19 }, (_, index) => ({ text: `Review ${index + 1}` }));

  assert.throws(
    () => assertEnoughReviews(reviews),
    (error) => {
      assert.equal(error.statusCode, 422);
      assert.equal(error.code, 'INSUFFICIENT_REVIEWS');
      assert.deepEqual(error.details, { reviewCount: 19, minimumReviews: 20 });
      assert.match(error.message, /quá ít đánh giá/i);
      assert.match(error.message, /tối thiểu 20/i);
      return true;
    }
  );
});

test('cho phép phân tích từ đúng ngưỡng 20 review', () => {
  const reviews = Array.from({ length: MINIMUM_REVIEWS_FOR_ANALYSIS }, () => ({ text: 'Review đủ dữ liệu' }));
  assert.equal(assertEnoughReviews(reviews), 20);
});

