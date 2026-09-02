export const MINIMUM_REVIEWS_FOR_ANALYSIS = 20;

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

