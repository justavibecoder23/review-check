import { extractMarketplaceUrl, isShopeeUrl, resolveShopeeProductUrl } from './shopee-url.mjs';
import { collectShopeeReviewsParallel, SHOPEE_STAR_FILTERS } from './apify-review-scraper.mjs';

const DEMO_REVIEWS = [
  { rating: 5, text: 'Nhận xu nên đánh giá cho shop 5 sao nha mọi người.', date: '12/08/2026', verified: false },
  { rating: 5, text: 'Hàng đẹp, giao nhanh, đóng gói kỹ.', date: '11/08/2026', verified: false },
  { rating: 2, text: 'Vải mỏng hơn nhiều so với ảnh, mặc lên nhìn form khá chật dù đã chọn đúng size thường mặc.', date: '10/08/2026', verified: true },
  { rating: 3, text: 'Màu thực tế tối hơn hình. Form nhỏ, ai thích mặc rộng nên tăng một size.', date: '09/08/2026', verified: true },
  { rating: 2, text: 'Đợi hàng lâu hơn dự kiến. Sản phẩm không lỗi nhưng chất vải mỏng, không hợp giá này.', date: '08/08/2026', verified: true },
  { rating: 4, text: 'Kiểu dáng ổn, nhưng đường may hơi thô và vải khá bí khi mặc trời nóng.', date: '07/08/2026', verified: true },
  { rating: 5, text: 'Chưa dùng nhưng thấy đóng gói đẹp.', date: '06/08/2026', verified: false },
  { rating: 3, text: 'Giao chậm 4 ngày, hộp bị móp nhẹ. Dùng tạm ổn nhưng màu nhận được khác hình.', date: '05/08/2026', verified: true },
  { rating: 4, text: 'Sản phẩm đúng nhu cầu, tuy nhiên form nhỏ hơn bảng size khoảng một cỡ.', date: '04/08/2026', verified: true },
  { rating: 1, text: 'Nhận về có lỗi ở đường may, vải mỏng và bị xù nhẹ sau hai lần giặt.', date: '03/08/2026', verified: true },
  { rating: 5, text: 'Tốt', date: '02/08/2026', verified: false },
  { rating: 3, text: 'Không giống màu trên ảnh, giao hàng hơi lâu nhưng shop có phản hồi.', date: '01/08/2026', verified: true }
];

const DEFAULT_SHOPEE_REVIEW_LIMIT = 10;
const MAX_SHOPEE_REVIEW_LIMIT = 100;
const DEFAULT_SHOPEE_REVIEWS_PER_STAR = 20;
const MAX_SHOPEE_REVIEWS_PER_STAR = 20;

export function getShopeeReviewLimit(value = process.env.SHOPEE_REVIEW_LIMIT) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_SHOPEE_REVIEW_LIMIT;
  return Math.min(Math.max(parsed, 1), MAX_SHOPEE_REVIEW_LIMIT);
}

export function getShopeeReviewsPerStar(value = process.env.SHOPEE_REVIEWS_PER_STAR) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_SHOPEE_REVIEWS_PER_STAR;
  return Math.min(Math.max(parsed, 1), MAX_SHOPEE_REVIEWS_PER_STAR);
}

function platformFrom(url) {
  const host = new URL(url).hostname.toLowerCase();
  if (isShopeeUrl(url)) return 'Shopee';
  if (host === 'vm.tiktok.com' || host === 'vt.tiktok.com' || host.includes('tiktok.com')) return 'TikTok Shop';
  throw Object.assign(new Error('Link chưa thuộc Shopee hoặc TikTok Shop.'), { statusCode: 400 });
}

async function loadFromConfiguredBot(url, platform) {
  const endpoint = process.env.REVIEWS_BOT_URL;
  if (!endpoint) throw new Error('Chưa cấu hình bot thu thập đánh giá.');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: process.env.REVIEWS_BOT_TOKEN ? `Bearer ${process.env.REVIEWS_BOT_TOKEN}` : '' },
    body: JSON.stringify({ url, platform, limit: 50 })
  });
  if (!response.ok) throw new Error(`Bot trả về HTTP ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body.reviews)) throw new Error('Bot không trả về danh sách reviews hợp lệ.');
  return {
    reviews: body.reviews.map((review) => ({
      rating: Number(review.rating) || 0,
      text: String(review.text || ''),
      date: review.date || 'Không rõ ngày',
      verified: Boolean(review.verified),
      author: review.author || 'Khách đã mua'
    })).filter((review) => review.text),
    productMeta: normaliseProductMeta(body.product)
  };
}

function firstValue(source, paths) {
  for (const path of paths) {
    const value = path.split('.').reduce((current, key) => current?.[key], source);
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  return undefined;
}

function normaliseProductMeta(source = {}) {
  if (!source || typeof source !== 'object') return {};
  const title = firstValue(source, ['title', 'name', 'productName', 'productTitle', 'itemName', 'product.name', 'item.name']);
  const image = firstValue(source, ['image', 'imageUrl', 'productImage', 'thumbnail', 'product.image', 'item.image']);
  const price = firstValue(source, ['price', 'productPrice', 'currentPrice', 'product.price', 'item.price']);
  const rating = firstValue(source, ['productRating', 'ratingAverage', 'averageRating', 'product.rating', 'item.rating']);
  return {
    ...(title ? { title: String(title) } : {}),
    ...(image ? { image: String(image) } : {}),
    ...(price ? { price: String(price) } : {}),
    ...(rating ? { rating: Number(rating) || String(rating) } : {})
  };
}

export async function getReviews(url) {
  let parsed;
  try { parsed = new URL(extractMarketplaceUrl(url)); } catch (error) {
    throw Object.assign(new Error(error?.message || 'Link không hợp lệ.'), { statusCode: error?.statusCode || 400 });
  }
  const platform = platformFrom(parsed.href);
  const warnings = [];
  const shopeeProduct = platform === 'Shopee'
    ? await resolveShopeeProductUrl(parsed.href)
    : null;
  const productUrl = shopeeProduct?.canonicalUrl || parsed.href;
  const perStarLimit = platform === 'Shopee' ? getShopeeReviewsPerStar() : null;
  const reviewLimit = platform === 'Shopee' ? perStarLimit * SHOPEE_STAR_FILTERS.length : 50;

  if (shopeeProduct?.wasShortened) {
    warnings.push('Đã mở link chia sẻ Shopee và chuẩn hóa về đúng sản phẩm trước khi thu thập review.');
  }

  try {
    const collected = platform === 'Shopee'
      ? await collectShopeeReviewsParallel(productUrl, { perStarLimit })
      : await loadFromConfiguredBot(productUrl, platform);
    const reviews = collected.reviews;
    if (Array.isArray(collected.warnings)) warnings.push(...collected.warnings);
    return {
      reviews,
      source: {
        type: 'live',
        label: platform === 'Shopee' ? 'Apify · Shopee Product Reviews Scraper' : 'Bot thu thập đã cấu hình',
        reviewLimit,
        ...(platform === 'Shopee' ? {
          perStarLimit,
          starFilters: SHOPEE_STAR_FILTERS,
          collection: collected.collection,
          credential: collected.credential,
          usage: collected.usage
        } : {})
      },
      product: {
        platform,
        url: productUrl,
        originalUrl: parsed.href,
        ...(collected.productMeta || normaliseProductMeta(collected.productMetaSource)),
        ...(shopeeProduct ? {
          shopId: shopeeProduct.shopId,
          itemId: shopeeProduct.itemId,
          resolvedFromShortLink: shopeeProduct.wasShortened
        } : {})
      },
      warnings
    };
  } catch (error) {
    if (process.env.ALLOW_DEMO_REVIEWS !== 'true') {
      throw Object.assign(new Error(`Không lấy được review thật từ ${platform}: ${error.message}`), { statusCode: 502 });
    }
    warnings.push(`Không thể lấy dữ liệu trực tiếp: ${error.message}`);
    warnings.push('Đang hiển thị dữ liệu mô phỏng để kiểm tra luồng. Không dùng kết quả này để quyết định mua hàng.');
    return {
      reviews: DEMO_REVIEWS,
      source: { type: 'demo', label: 'Dữ liệu mô phỏng', reviewLimit },
      product: {
        platform,
        url: productUrl,
        originalUrl: parsed.href,
        title: platform === 'Shopee' ? 'Sản phẩm đang phân tích trên Shopee' : 'Sản phẩm đang phân tích trên TikTok Shop',
        ...(shopeeProduct ? {
          shopId: shopeeProduct.shopId,
          itemId: shopeeProduct.itemId,
          resolvedFromShortLink: shopeeProduct.wasShortened
        } : {})
      },
      warnings
    };
  }
}
