import { cleanProductTitle } from './product-metadata-quality.mjs';

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

function imageValue(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = imageValue(item);
      if (candidate) return candidate;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const key of ['url', 'url_list', 'urlList', 'uri', 'image_url', 'imageUrl', 'src', 'original', 'large']) {
      const candidate = imageValue(value[key]);
      if (candidate) return candidate;
    }
    return null;
  }
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Preserve product-level metadata before the adapter flattens `data.reviews`.
 * Temporary actors commonly put this data on the dataset wrapper rather than
 * repeating it on every review.
 */
export function extractTikTokProductMeta(items) {
  if (!Array.isArray(items)) return {};
  for (const entry of items) {
    if (!entry || typeof entry !== 'object') continue;
    const wrapperTitle = (Array.isArray(entry.reviews) || Array.isArray(entry.data?.reviews))
      ? firstValue(entry, ['title', 'name'])
      : null;
    const title = cleanProductTitle(firstValue(entry, [
      'product_title', 'productTitle', 'product_name', 'productName',
      'product.title', 'product.name', 'product.product_name',
      'productInfo.title', 'productInfo.name', 'productInfo.product_name',
      'product_info.title', 'product_info.name', 'product_info.product_name',
      'data.product.title', 'data.product.name', 'data.product.product_name',
      'data.productInfo.title', 'data.productInfo.name', 'data.productInfo.product_name',
      'data.product_info.title', 'data.product_info.name', 'data.product_info.product_name',
      'data.item.title', 'data.item.name'
    ]) || wrapperTitle);
    const rawImage = firstValue(entry, [
      'product_main_image', 'productMainImage', 'product_main_image_url', 'productMainImageUrl',
      'product_image', 'productImage', 'product_image_url', 'productCover', 'product_cover_url', 'main_image', 'mainImage',
      'product.main_image', 'product.mainImage', 'product.image', 'product.cover', 'product.cover_url', 'product.images', 'product.main_images',
      'productInfo.main_image', 'productInfo.mainImage', 'productInfo.image', 'productInfo.cover', 'productInfo.images',
      'product_info.main_image', 'product_info.image', 'product_info.cover', 'product_info.images',
      'data.product.main_image', 'data.product.mainImage', 'data.product.image', 'data.product.cover', 'data.product.cover_url', 'data.product.images', 'data.product.main_images',
      'data.productInfo.main_image', 'data.productInfo.mainImage', 'data.productInfo.image', 'data.productInfo.cover', 'data.productInfo.images',
      'data.product_info.main_image', 'data.product_info.image', 'data.product_info.cover', 'data.product_info.images',
      'data.item.image', 'data.item.cover', 'data.item.images'
    ]);
    const productImage = imageValue(rawImage);
    const price = firstValue(entry, [
      'product_price', 'productPrice', 'product.price', 'product.sale_price',
      'productInfo.price', 'product_info.price', 'data.product.price', 'data.item.price'
    ]);
    const rating = firstValue(entry, [
      'product_rating', 'productRating', 'product.rating', 'product.rating_average',
      'productInfo.rating', 'product_info.rating', 'data.product.rating', 'data.item.rating'
    ]);
    if (title || productImage || price || rating) {
      return {
        ...(title ? { title: String(title) } : {}),
        ...(productImage ? { image: String(productImage) } : {}),
        ...(price ? { price: String(price) } : {}),
        ...(rating ? { rating: Number(rating) || String(rating) } : {})
      };
    }
  }

  const firstReview = extractReviewsFromDatasetItems(items)[0];
  if (!firstReview || typeof firstReview !== 'object') return {};
  const title = cleanProductTitle(firstValue(firstReview, ['product_title', 'productTitle', 'product_name', 'productName', 'product.title', 'product.name']));
  const productImage = imageValue(firstValue(firstReview, [
    'product_main_image', 'productMainImage', 'product_main_image_url', 'productMainImageUrl',
    'product_image', 'productImage', 'product_image_url',
    'product.main_image', 'product.mainImage', 'product.image', 'product.cover', 'product.images'
  ]));
  return {
    ...(title ? { title: String(title) } : {}),
    ...(productImage ? { image: String(productImage) } : {})
  };
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
        reviews_sort: 'recommended',
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
    extractProductMeta: extractTikTokProductMeta,
    extractItems(items, productId) {
      return extractReviewsFromDatasetItems(items).map((review) => canonicalTikTokReview(review, productId));
    }
  };
}
