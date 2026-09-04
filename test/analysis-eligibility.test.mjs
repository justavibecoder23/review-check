import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertEnoughReviews,
  assertSamplingCoverage,
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

test('mẫu chia tầng phải có đủ các mốc 1★, 3★ và 5★', () => {
  const reviews = [1, 3].flatMap((rating) => Array.from({ length: 10 }, () => ({ rating, text: 'Review' })));
  assert.throws(
    () => assertSamplingCoverage(reviews, { strategy: 'parallel-star-filters' }),
    (error) => error.code === 'INCOMPLETE_RATING_STRATA'
      && error.statusCode === 422
      && error.details.missingRatings.length === 1
      && error.details.missingRatings[0] === 5
  );
  assert.equal(assertSamplingCoverage(reviews, { strategy: 'unfiltered' }), true);
});

test('TikTok bắt buộc đủ cả năm tầng sao đã khai báo', () => {
  const reviews = [1, 2, 3, 5].flatMap((rating) => Array.from({ length: 5 }, () => ({ rating, text: 'Review' })));
  assert.throws(
    () => assertSamplingCoverage(reviews, { strategy: 'parallel-star-filters', ratingStrata: [1, 2, 3, 4, 5] }),
    (error) => error.code === 'INCOMPLETE_RATING_STRATA'
      && error.details.missingRatings.length === 1
      && error.details.missingRatings[0] === 4
  );
});

test('cho phép phân tích từ đúng ngưỡng 20 review', () => {
  const reviews = Array.from({ length: MINIMUM_REVIEWS_FOR_ANALYSIS }, () => ({ text: 'Review đủ dữ liệu' }));
  assert.equal(assertEnoughReviews(reviews), 20);
});

