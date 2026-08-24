import { extractMarketplaceUrl, isShopeeUrl, resolveShopeeProductUrl } from './shopee-url.mjs';

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

export function getShopeeReviewLimit(value = process.env.SHOPEE_REVIEW_LIMIT) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_SHOPEE_REVIEW_LIMIT;
  return Math.min(Math.max(parsed, 1), MAX_SHOPEE_REVIEW_LIMIT);
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
  return body.reviews.map((review) => ({
    rating: Number(review.rating) || 0,
    text: String(review.text || ''),
    date: review.date || 'Không rõ ngày',
    verified: Boolean(review.verified),
    author: review.author || 'Khách đã mua'
  })).filter((review) => review.text);
}

async function loadFromApify(url, reviewLimit) {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error('Chưa cấu hình APIFY_TOKEN trên máy chủ.');

  const endpoint = 'https://api.apify.com/v2/acts/zen-studio~shopee-product-reviews-scraper/run-sync-get-dataset-items';
  const upstream = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      startUrls: [{ url }],
      contentFilter: 'with comments',
      maxReviewsPerProduct: reviewLimit
    }),
    // Chừa thời gian cho bước mở link rút gọn và cho Vercel đóng gói phản hồi.
    signal: AbortSignal.timeout(48_000)
  });

  if (!upstream.ok) {
    const detail = (await upstream.text()).slice(0, 240);
    throw new Error(`Apify trả về HTTP ${upstream.status}${detail ? `: ${detail}` : ''}`);
  }
  const items = await upstream.json();
  if (!Array.isArray(items)) throw new Error('Apify không trả về danh sách review hợp lệ.');

  return items.map((review) => ({
    rating: Number(review.ratingStar) || 0,
    text: String(review.comment || '').trim(),
    date: review.createdAt ? new Date(review.createdAt).toLocaleDateString('vi-VN') : 'Không rõ ngày',
    verified: true,
    author: review.author || 'Khách đã mua'
  })).filter((review) => review.text);
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
  const reviewLimit = platform === 'Shopee' ? getShopeeReviewLimit() : 50;

  if (shopeeProduct?.wasShortened) {
    warnings.push('Đã mở link chia sẻ Shopee và chuẩn hóa về đúng sản phẩm trước khi thu thập review.');
  }

  try {
    const reviews = platform === 'Shopee'
      ? await loadFromApify(productUrl, reviewLimit)
      : await loadFromConfiguredBot(productUrl, platform);
    return {
      reviews,
      source: {
        type: 'live',
        label: platform === 'Shopee' ? 'Apify · Shopee Product Reviews Scraper' : 'Bot thu thập đã cấu hình',
        reviewLimit
      },
      product: {
        platform,
        url: productUrl,
        originalUrl: parsed.href,
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
