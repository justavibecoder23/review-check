function firstValue(object, paths) {
  for (const path of paths) {
    let value = object;
    for (const part of path.split('.')) value = value?.[part];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

export function extractReviewsFromDatasetItems(items) {
  if (!Array.isArray(items)) return [];
  return items.flatMap((entry) => {
    if (Array.isArray(entry?.reviews)) return entry.reviews;
    if (Array.isArray(entry?.data?.reviews)) return entry.data.reviews;
    return entry && typeof entry === 'object' ? [entry] : [];
  });
}

export function canonicalTikTokReview(review, productId) {
  const source = review && typeof review === 'object' ? review : {};
  return {
    review_id: firstValue(source, ['review_id', 'reviewId', 'id']),
    product_id: firstValue(source, ['product_id', 'productId', 'itemId']) || productId,
    reviewer_id: firstValue(source, ['reviewer_id', 'reviewerId', 'author.id', 'user.id']),
    reviewer_name: firstValue(source, ['reviewer_name', 'reviewerName', 'user_name', 'author.name', 'user.nickname']),
    review_rating: firstValue(source, ['review_rating', 'rating', 'stars', 'star']),
    review_text: firstValue(source, ['review_text', 'text', 'content', 'comment']) || '',
    review_time: firstValue(source, ['review_time', 'createdAt', 'create_time', 'created_at', 'timestamp']),
    is_verified_purchase: firstValue(source, ['is_verified_purchase', 'isVerifiedPurchase', 'verified']),
    product_name: firstValue(source, ['product_name', 'productName', 'product.title', 'product.name']),
    _source: source
  };
}

const adapters = {
  'web-wanderer': {
    buildInput({ productId, reviewLimit, reviewFilter, runtime }) {
      return {
        region: runtime.region,
        product_ids: [String(productId)],
        reviews_limit: reviewLimit,
        reviews_filter: reviewFilter,
        reviews_sort: 'most_recent',
        include_personal_information: false
      };
    }
  },
  vistics: {
    buildInput({ productUrl, reviewLimit, runtime }) {
      if (!productUrl) throw new Error('Actor TikTok tạm thời cần URL sản phẩm đầy đủ.');
      return {
        startUrls: [String(productUrl)],
        maxReviews: reviewLimit,
        region: runtime.region
      };
    }
  }
};

export function tikTokActorAdapter(runtime) {
  const adapter = adapters[runtime?.adapter];
  if (!adapter) throw new Error(`Không hỗ trợ adapter TikTok ${runtime?.adapter || 'không xác định'}.`);
  return {
    ...adapter,
    extractItems(items, productId) {
      return extractReviewsFromDatasetItems(items).map((review) => canonicalTikTokReview(review, productId));
    }
  };
}
