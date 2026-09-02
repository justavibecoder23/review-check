import { extractMarketplaceUrl, isShopeeUrl, resolveShopeeProductUrl } from './shopee-url.mjs';
import { collectShopeeReviews } from './apify-review-scraper.mjs';
import { collectTikTokReviews } from './apify-tiktok-review-scraper.mjs';
import { isTikTokUrl, resolveTikTokProductUrl } from './tiktok-url.mjs';
import { createProgressReporter } from './sse.mjs';

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
  if (isShopeeUrl(url)) return 'Shopee';
  if (isTikTokUrl(url)) return 'TikTok Shop';
  throw Object.assign(new Error('Link chưa thuộc Shopee hoặc TikTok Shop.'), { statusCode: 400 });
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
  const image = firstValue(source, ['image', 'imageUrl', 'productImage', 'product_image', 'product_image_url', 'productCover', 'product_cover_url', 'cover', 'cover_url', 'thumbnail', 'variations.0.image', 'product.image', 'item.image']);
  const price = firstValue(source, ['price', 'productPrice', 'currentPrice', 'product.price', 'item.price']);
  const rating = firstValue(source, ['productRating', 'ratingAverage', 'averageRating', 'product.rating', 'item.rating']);
  return {
    ...(title ? { title: String(title) } : {}),
    ...(image ? { image: String(image) } : {}),
    ...(price ? { price: String(price) } : {}),
    ...(rating ? { rating: Number(rating) || String(rating) } : {})
  };
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .trim();
}

function attributesFromTag(tag) {
  const attributes = {};
  const pattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))/g;
  for (const match of String(tag).matchAll(pattern)) {
    attributes[match[1].toLowerCase()] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

function safeMetadataUrl(value, baseUrl) {
  try {
    const url = new URL(decodeHtmlEntities(value), baseUrl);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function jsonLdProductMeta(html, baseUrl) {
  const candidates = [];
  const scripts = String(html).matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of scripts) {
    try {
      let root;
      try {
        root = JSON.parse(String(match[1]).trim());
      } catch {
        root = JSON.parse(decodeHtmlEntities(match[1]));
      }
      const queue = Array.isArray(root) ? [...root] : [root];
      let visited = 0;
      while (queue.length && visited < 1000) {
        const node = queue.shift();
        visited += 1;
        if (!node || typeof node !== 'object') continue;
        candidates.push(node);
        for (const value of Object.values(node)) {
          if (value && typeof value === 'object') queue.push(...(Array.isArray(value) ? value : [value]));
        }
      }
    } catch {
      // Một block JSON-LD lỗi không được làm mất metadata hợp lệ ở block khác.
    }
  }
  const product = candidates.find((node) => {
    const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
    return types.some((type) => String(type).toLowerCase() === 'product');
  });
  if (!product) return {};
  const rawImage = Array.isArray(product.image) ? product.image[0] : product.image;
  const imageValue = rawImage && typeof rawImage === 'object'
    ? rawImage.url || rawImage.contentUrl
    : rawImage;
  const image = safeMetadataUrl(imageValue, baseUrl);
  return {
    ...(product.name ? { title: decodeHtmlEntities(product.name) } : {}),
    ...(image ? { image } : {})
  };
}

export function extractProductPageMeta(html, baseUrl) {
  const metadata = {};
  for (const tag of String(html || '').match(/<meta\b[^>]*>/gi) || []) {
    const attributes = attributesFromTag(tag);
    const key = String(attributes.property || attributes.name || '').toLowerCase();
    if (key && attributes.content && metadata[key] === undefined) metadata[key] = attributes.content;
  }

  const structured = jsonLdProductMeta(html, baseUrl);
  const pageTitle = decodeHtmlEntities(String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const title = decodeHtmlEntities(metadata['og:title'] || metadata['twitter:title'] || structured.title || pageTitle);
  const image = safeMetadataUrl(
    metadata['og:image:secure_url'] || metadata['og:image'] || metadata['twitter:image'] || structured.image,
    baseUrl
  );
  return {
    ...(title ? { title } : {}),
    ...(image ? { image } : {})
  };
}

async function readLimitedHtml(response, maximumBytes = 512_000) {
  if (!response.body?.getReader) return String(await response.text()).slice(0, maximumBytes);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let html = '';
  while (total < maximumBytes) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = value || new Uint8Array();
    total += chunk.byteLength;
    html += decoder.decode(chunk, { stream: true });
    if (total >= maximumBytes) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  html += decoder.decode();
  return html.slice(0, maximumBytes);
}

function isSafeMarketplacePageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && (!url.port || url.port === '443')
      && (isShopeeUrl(url.href) || isTikTokUrl(url.href));
  } catch {
    return false;
  }
}

export async function fetchProductPageMeta(productUrl, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs) || 6500);
  let currentUrl = productUrl;
  try {
    for (let redirectCount = 0; redirectCount <= 4; redirectCount += 1) {
      if (!isSafeMarketplacePageUrl(currentUrl)) return {};
      const response = await fetchImpl(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'user-agent': 'Mozilla/5.0 (compatible; RealView/1.0; +https://www.realview.com.vn/)'
        }
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) return {};
        currentUrl = new URL(location, currentUrl).href;
        continue;
      }
      if (!response.ok) return {};
      const contentType = response.headers.get('content-type') || '';
      if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) return {};
      return extractProductPageMeta(await readLimitedHtml(response), currentUrl);
    }
    return {};
  } finally {
    clearTimeout(timeout);
  }
}

export async function getReviews(url, options = {}) {
  const progress = createProgressReporter(options.onProgress);
  let parsed;
  try { parsed = new URL(extractMarketplaceUrl(url)); } catch (error) {
    throw Object.assign(new Error(error?.message || 'Link không hợp lệ.'), { statusCode: error?.statusCode || 400 });
  }
  const platform = platformFrom(parsed.href);
  progress('resolving', 8, 'Đang kiểm tra liên kết...');
  const warnings = [];
  const shopeeProduct = platform === 'Shopee'
    ? await resolveShopeeProductUrl(parsed.href)
    : null;
  const tiktokProduct = platform === 'TikTok Shop'
    ? await resolveTikTokProductUrl(parsed.href)
    : null;
  const productUrl = shopeeProduct?.canonicalUrl || tiktokProduct?.productUrl || parsed.href;
  const perStarLimit = platform === 'Shopee' ? getShopeeReviewsPerStar() : null;
  const reviewLimit = platform === 'Shopee' ? perStarLimit : 100;

  if (shopeeProduct?.wasShortened) {
    warnings.push('Đã mở link chia sẻ Shopee và chuẩn hóa về đúng sản phẩm trước khi thu thập review.');
  }
  if (tiktokProduct?.wasShortened) {
    warnings.push('Đã mở link chia sẻ TikTok và khôi phục đúng mã sản phẩm trước khi thu thập review.');
  }

  const productMetaPromise = fetchProductPageMeta(productUrl).catch(() => ({}));
  try {
    progress('collecting', 14, 'Đang khởi tạo hệ thống lấy reviews...');
    const collected = platform === 'Shopee'
      ? await collectShopeeReviews(productUrl, { reviewLimit: perStarLimit, onProgress: options.onProgress })
      : await collectTikTokReviews(tiktokProduct.productId, { onProgress: options.onProgress });
    const reviews = collected.reviews;
    const pageMeta = await productMetaPromise;
    const collectedMeta = collected.productMeta || normaliseProductMeta(collected.productMetaSource);
    if (Array.isArray(collected.warnings)) warnings.push(...collected.warnings);
    return {
      reviews,
      source: {
        type: 'live',
        label: platform === 'Shopee' ? 'Apify · Shopee Product Reviews Scraper' : 'Apify · TikTok Product Reviews Scraper',
        reviewLimit,
        collection: collected.collection,
        credential: collected.credential,
        usage: collected.usage
      },
      product: {
        platform,
        url: productUrl,
        originalUrl: parsed.href,
        ...pageMeta,
        ...collectedMeta,
        ...(shopeeProduct ? {
          shopId: shopeeProduct.shopId,
          itemId: shopeeProduct.itemId,
          resolvedFromShortLink: shopeeProduct.wasShortened
        } : {}),
        ...(tiktokProduct ? {
          productId: tiktokProduct.productId,
          resolvedFromShortLink: tiktokProduct.wasShortened
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
    const pageMeta = await productMetaPromise;
    return {
      reviews: DEMO_REVIEWS,
      source: { type: 'demo', label: 'Dữ liệu mô phỏng', reviewLimit },
      product: {
        platform,
        url: productUrl,
        originalUrl: parsed.href,
        title: platform === 'Shopee' ? 'Sản phẩm đang phân tích trên Shopee' : 'Sản phẩm đang phân tích trên TikTok Shop',
        ...pageMeta,
        ...(shopeeProduct ? {
          shopId: shopeeProduct.shopId,
          itemId: shopeeProduct.itemId,
          resolvedFromShortLink: shopeeProduct.wasShortened
        } : {}),
        ...(tiktokProduct ? {
          productId: tiktokProduct.productId,
          resolvedFromShortLink: tiktokProduct.wasShortened
        } : {})
      },
      warnings
    };
  }
}
