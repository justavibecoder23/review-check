export const MINIMUM_REVIEWS_FOR_ANALYSIS = 20;
export const TRUST_SCORE_ANCHOR_RATINGS = Object.freeze([1, 3, 5]);

function requiredRatingStrata(collection = {}) {
  const configured = Array.isArray(collection?.ratingStrata)
    ? [...new Set(collection.ratingStrata.map(Number)
      .filter((rating) => Number.isInteger(rating) && rating >= 1 && rating <= 5))].sort((a, b) => a - b)
    : [];
  return configured.length ? configured : [...TRUST_SCORE_ANCHOR_RATINGS];
}

export function assertEnoughReviews(reviews, minimum = MINIMUM_REVIEWS_FOR_ANALYSIS) {
  const count = Array.isArray(reviews) ? reviews.length : 0;
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

export function assertSamplingCoverage(reviews, collection = {}) {
  if (collection?.strategy !== 'parallel-star-filters') return true;
  const ratings = new Set((Array.isArray(reviews) ? reviews : [])
    .map((review) => Number(review?.rating))
    .filter((rating) => Number.isInteger(rating)));
  const requiredRatings = requiredRatingStrata(collection);
  const missingRatings = requiredRatings.filter((rating) => !ratings.has(rating));
  if (!missingRatings.length) return true;

  const error = new Error(`Mẫu review chưa đủ các tầng sao theo thiết kế ${requiredRatings.map((rating) => `${rating}★`).join(', ')}; đang thiếu ${missingRatings.map((rating) => `${rating}★`).join(', ')}. Hãy thử lại để tránh phân tích một mẫu bị lệch.`);
  error.statusCode = 422;
  error.code = 'INCOMPLETE_RATING_STRATA';
  error.details = { missingRatings, requiredRatings };
  throw error;
}

