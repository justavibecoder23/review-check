export const MINIMUM_REVIEWS_FOR_ANALYSIS = 20;
export const TRUST_SCORE_ANCHOR_RATINGS = Object.freeze([1, 2, 3, 4, 5]);

export function isWrittenReview(review) {
  return Boolean(review && typeof review === 'object' && typeof review.text === 'string' && review.text.trim());
}

function requiredRatingStrata(collection = {}) {
  const configured = Array.isArray(collection?.ratingStrata)
    ? [...new Set(collection.ratingStrata.map(Number)
      .filter((rating) => Number.isInteger(rating) && rating >= 1 && rating <= 5))].sort((a, b) => a - b)
    : [];
  return configured.length ? configured : [...TRUST_SCORE_ANCHOR_RATINGS];
}

export function assertEnoughReviews(reviews, minimum = MINIMUM_REVIEWS_FOR_ANALYSIS) {
  const count = Array.isArray(reviews)
    ? reviews.filter(isWrittenReview).length
    : 0;
  const required = Number.isFinite(Number(minimum))
    ? Math.max(1, Math.floor(Number(minimum)))
    : MINIMUM_REVIEWS_FOR_ANALYSIS;

  if (count >= required) return count;

  const error = new Error(
    `Sản phẩm này có quá ít đánh giá để phân tích khách quan. RealView chỉ thu thập được ${count} đánh giá có nội dung, trong khi cần tối thiểu ${required}. Vui lòng thử một sản phẩm khác có nhiều đánh giá hơn.`
  );
  error.statusCode = 422;
  error.code = 'INSUFFICIENT_REVIEWS';
  error.details = { reviewCount: count, minimumReviews: required };
  throw error;
}

export function checkSamplingCoverage(reviews, collection = {}) {
  if (collection?.ratingStrataRequired === false || collection?.strategy !== 'parallel-star-filters') {
    return { complete: true, missingRatings: [], requiredRatings: [] };
  }
  const ratings = new Set((Array.isArray(reviews) ? reviews : [])
    .filter(isWrittenReview)
    .map((review) => Number(review?.rating))
    .filter((rating) => Number.isInteger(rating)));
  const requiredRatings = requiredRatingStrata(collection);
  const missingRatings = requiredRatings.filter((rating) => !ratings.has(rating));
  return {
    complete: missingRatings.length === 0,
    missingRatings,
    requiredRatings
  };
}

export function assertSamplingCoverage(reviews, collection = {}) {
  // Không chặn cứng (không throw error) khi thiếu tầng sao.
  // Mẫu review vẫn được lấy và phân tích bình thường nếu đạt tối thiểu review.
  const coverage = checkSamplingCoverage(reviews, collection);
  return coverage.complete;
}

