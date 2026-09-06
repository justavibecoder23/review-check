import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertEnoughReviews,
  assertSamplingCoverage,
  checkSamplingCoverage,
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

test('mẫu chia tầng không bị chặn khi thiếu một số tầng sao', () => {
  const reviews = [1, 3].flatMap((rating) => Array.from({ length: 10 }, () => ({ rating, text: 'Review' })));
  const coverage = checkSamplingCoverage(reviews, { strategy: 'parallel-star-filters' });
  assert.equal(coverage.complete, false);
  assert.deepEqual(coverage.missingRatings, [2, 4, 5]);
  assert.doesNotThrow(() => assertSamplingCoverage(reviews, { strategy: 'parallel-star-filters' }));
  assert.equal(assertSamplingCoverage(reviews, { strategy: 'unfiltered' }), true);
});

test('TikTok không bị chặn cứng khi thiếu tầng sao trong 5 tầng', () => {
  const reviews = [1, 2, 3, 5].flatMap((rating) => Array.from({ length: 5 }, () => ({ rating, text: 'Review' })));
  const coverage = checkSamplingCoverage(reviews, { strategy: 'parallel-star-filters', ratingStrata: [1, 2, 3, 4, 5] });
  assert.equal(coverage.complete, false);
  assert.deepEqual(coverage.missingRatings, [4]);
  assert.doesNotThrow(() => assertSamplingCoverage(reviews, { strategy: 'parallel-star-filters', ratingStrata: [1, 2, 3, 4, 5] }));
});

test('cho phép phân tích từ đúng ngưỡng 20 review', () => {
  const reviews = Array.from({ length: MINIMUM_REVIEWS_FOR_ANALYSIS }, () => ({ text: 'Review đủ dữ liệu' }));
  assert.equal(assertEnoughReviews(reviews), 20);
});

