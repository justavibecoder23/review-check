import { extractMarketplaceUrl, getShopeeProductIds, isShopeeUrl, resolveShopeeProductUrl } from './shopee-url.mjs';
import { collectShopeeReviews } from './apify-review-scraper.mjs';
import { collectTikTokReviews } from './apify-tiktok-review-scraper.mjs';
import { getTikTokProductId, isTikTokUrl, resolveTikTokProductUrl } from './tiktok-url.mjs';
import { createProgressReporter } from './sse.mjs';
import { combineAbortSignals, throwIfAborted } from './abort.mjs';

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
  const title = firstValue(source, ['title', 'name', 'productName', 'product_name', 'productTitle', 'itemName', 'product.name', 'item.name']);
  // Chỉ nhận các trường được đặt tên rõ là ảnh sản phẩm. Các trường `image`,
  // `images` và `thumbnail` ở dataset review thường là ảnh do người mua tải lên.
  const image = firstValue(source, ['productImage', 'product_image', 'product_image_url', 'productCover', 'product_cover_url', 'product_images.0', 'product.image', 'product.images.0', 'item.image']);
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

function shopeeImageUrl(value) {
  const rawImage = String(value || '').trim();
  if (!rawImage) return '';
  return /^[\w-]{16,}$/.test(rawImage)
    ? `https://down-vn.img.susercontent.com/file/${rawImage}`
    : safeMetadataUrl(rawImage, 'https://shopee.vn/');
}

function normaliseSearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function firstSrcsetUrl(value) {
  return String(value || '').split(',').map((part) => part.trim().split(/\s+/)[0]).find(Boolean) || '';
}

function isGenericImageUrl(value) {
  return /(?:^|[\/_-])(logo|favicon|avatar|icon|placeholder|profile)(?:[\/_-]|\.|$)/i.test(String(value || ''));
}

function isLikelyProductImageUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    const marketplaceCdn = /(?:ibyteimg|byteimg|tiktokcdn|susercontent|shopeeusercontent)\.com$/i.test(url.hostname);
    const imageExtension = /\.(?:avif|gif|jpe?g|png|webp)(?:$|[?#])/i.test(url.pathname + url.search);
    return marketplaceCdn || imageExtension;
  } catch {
    return false;
  }
}

function preloadedProductImage(html, baseUrl) {
  for (const tag of String(html || '').match(/<link\b[^>]*>/gi) || []) {
    const attributes = attributesFromTag(tag);
    const rel = String(attributes.rel || '').toLowerCase().split(/\s+/);
    const isImageLink = (rel.includes('preload') && String(attributes.as || '').toLowerCase() === 'image')
      || rel.includes('image_src');
    if (!isImageLink) continue;
    const image = safeMetadataUrl(attributes.href || attributes.imagesrcset, baseUrl);
    if (image && isLikelyProductImageUrl(image) && !isGenericImageUrl(image)) return image;
  }
  return '';
}

function imageFromHtml(html, baseUrl, productTitle = '') {
  const normalizedTitle = normaliseSearchText(productTitle);
  const titleTokens = normalizedTitle.split(' ').filter((token) => token.length >= 4).slice(0, 8);
  const candidates = [];
  let index = 0;

  for (const tag of String(html || '').match(/<img\b[^>]*>/gi) || []) {
    const attributes = attributesFromTag(tag);
    const rawValues = [
      attributes.src,
      attributes['data-src'],
      attributes['data-original'],
      attributes['data-lazy-src'],
      firstSrcsetUrl(attributes.srcset || attributes['data-srcset'])
    ].filter(Boolean);

    for (const rawValue of rawValues) {
      const image = safeMetadataUrl(rawValue, baseUrl);
      if (!image || !isLikelyProductImageUrl(image)) continue;
      const alt = normaliseSearchText(attributes.alt);
      const width = Number.parseInt(attributes.width, 10) || 0;
      const height = Number.parseInt(attributes.height, 10) || 0;
      const productCdn = /(?:ibyteimg|byteimg|tiktokcdn|susercontent|shopeeusercontent)\.com/i.test(image);
      const titleMatches = titleTokens.filter((token) => alt.includes(token)).length;
      let score = productCdn ? 45 : 0;
      score += titleMatches * 12;
      if (attributes.fetchpriority === 'high') score += 15;
      if (width >= 200 || height >= 200) score += 10;
      if (isGenericImageUrl(image) || /avatar|logo|cửa hàng|shop profile/i.test(attributes.alt || '')) score -= 100;
      score -= Math.min(index, 20) * 0.25;
      candidates.push({ image, score });
      index += 1;
    }
  }

  const best = candidates.sort((left, right) => right.score - left.score)[0];
  return best?.score >= 30 ? best.image : '';
}

function embeddedMarketplaceImage(html, baseUrl) {
  const decoded = String(html || '')
    .replace(/\\u002f/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&');
  const urls = decoded.match(/https:\/\/[^\s"'<>\\]+/gi) || [];
  for (const candidate of urls) {
    const image = safeMetadataUrl(candidate.replace(/[),;]+$/, ''), baseUrl);
    if (!image || isGenericImageUrl(image)) continue;
    if (/(?:ibyteimg|byteimg|tiktokcdn|susercontent|shopeeusercontent)\.com/i.test(image)) return image;
  }
  return '';
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

function shopeeEmbeddedProductMeta(html, baseUrl, options = {}) {
  const parsedIds = getShopeeProductIds(baseUrl);
  const shopId = String(options.expectedShopId || parsedIds?.shopId || '');
  const itemId = String(options.expectedItemId || parsedIds?.itemId || '');
  if (!/^\d+$/.test(shopId) || !/^\d+$/.test(itemId)) return {};

  for (const match of String(html || '').matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/gi)) {
    const attributes = attributesFromTag(match[1]);
    if (String(attributes.type || '').toLowerCase() !== 'text/mfe-initial-data') continue;
    try {
      const initialState = JSON.parse(String(match[2] || '').trim())?.initialState;
      const cachedItem = initialState?.DOMAIN_PDP?.data?.PDP_BFF_DATA?.cachedMap?.[`${shopId}/${itemId}`]?.item;
      const item = initialState?.item?.items?.[itemId] || cachedItem;
      if (!item || typeof item !== 'object') continue;
      const embeddedShopId = String(item.shop_id ?? item.shopid ?? '');
      const embeddedItemId = String(item.item_id ?? item.itemid ?? '');
      if (embeddedShopId !== shopId || embeddedItemId !== itemId) continue;
      const title = firstValue(item, ['title', 'name']);
      const image = shopeeImageUrl(firstValue(item, ['image', 'images.0']));
      if (title || image) {
        return {
          ...(title ? { title: String(title) } : {}),
          ...(image ? { image } : {})
        };
      }
    } catch {
      // Một block hydration lỗi không được làm mất metadata hợp lệ ở block khác.
    }
  }
  return {};
}

export function extractProductPageMeta(html, baseUrl, options = {}) {
  const metadata = {};
  for (const tag of String(html || '').match(/<meta\b[^>]*>/gi) || []) {
    const attributes = attributesFromTag(tag);
    const key = String(attributes.property || attributes.name || '').toLowerCase();
    if (key && attributes.content && metadata[key] === undefined) metadata[key] = attributes.content;
  }

  const structured = jsonLdProductMeta(html, baseUrl);
  const embeddedProduct = isShopeeUrl(baseUrl)
    ? shopeeEmbeddedProductMeta(html, baseUrl, options)
    : {};
  const pageTitle = decodeHtmlEntities(String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const title = decodeHtmlEntities(metadata['og:title'] || metadata['twitter:title'] || embeddedProduct.title || structured.title || pageTitle);
  const socialImageCandidate = safeMetadataUrl(
    metadata['og:image:secure_url'] || metadata['og:image'] || metadata['twitter:image'] || structured.image,
    baseUrl
  );
  const socialImage = isLikelyProductImageUrl(socialImageCandidate) ? socialImageCandidate : '';
  const preloadImage = preloadedProductImage(html, baseUrl);
  const galleryImage = imageFromHtml(html, baseUrl, title);
  const image = embeddedProduct.image
    || (!isGenericImageUrl(socialImage) && socialImage)
    || preloadImage
    || galleryImage
    || (isTikTokUrl(baseUrl) ? embeddedMarketplaceImage(html, baseUrl) : '');
  return {
    ...(title ? { title } : {}),
    ...(image ? { image } : {})
  };
}

async function readLimitedHtml(response, maximumBytes = 1_200_000) {
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
  const expectedProductId = String(options.expectedProductId || (isTikTokUrl(productUrl) ? getTikTokProductId(productUrl) : '') || '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs) || 8000);
  let currentUrl = productUrl;
  try {
    for (let redirectCount = 0; redirectCount <= 4; redirectCount += 1) {
      if (!isSafeMarketplacePageUrl(currentUrl)) return {};
      const response = await fetchImpl(currentUrl, {
        redirect: 'manual',
        signal: combineAbortSignals(options.signal, controller.signal),
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'vi-VN,vi;q=0.9,en;q=0.7',
          'user-agent': 'Twitterbot/1.0'
        }
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) return {};
        currentUrl = new URL(location, currentUrl).href;
        continue;
      }
      if (!response.ok) return {};
      if (expectedProductId && isTikTokUrl(currentUrl)) {
        const resolvedProductId = getTikTokProductId(currentUrl);
        if (resolvedProductId && resolvedProductId !== expectedProductId) return {};
      }
      const contentType = response.headers.get('content-type') || '';
      if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) return {};
      return extractProductPageMeta(await readLimitedHtml(response), currentUrl, options);
    }
    return {};
  } finally {
    clearTimeout(timeout);
  }
}

export function productMetadataUrls(productUrl, product = {}) {
  const urls = [productUrl];
  if (product.platform === 'Shopee'
    && /^\d+$/.test(String(product.shopId || ''))
    && /^\d+$/.test(String(product.itemId || ''))) {
    urls.unshift(`https://shopee.vn/product/${product.shopId}/${product.itemId}`);
  }
  if (product.platform === 'TikTok Shop' && /^\d{8,25}$/.test(String(product.productId || ''))) {
    // URL không có slug của TikTok có thể chuyển sang một sản phẩm gợi ý khác.
    // Chỉ dùng URL người dùng/actor đã xác nhận; productId sẽ được kiểm tra sau redirect.
    const parsedId = getTikTokProductId(productUrl);
    if (parsedId !== String(product.productId)) return [];
  }
  return [...new Set(urls.filter(isSafeMarketplacePageUrl))];
}

export async function fetchProductPageMetaCandidates(urls, options = {}) {
  const settled = await Promise.allSettled(
    [...new Set(urls)].map((url) => fetchProductPageMeta(url, options))
  );
  return settled
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value)
    .reduce((combined, metadata) => ({
      ...combined,
      ...(!combined.title && metadata.title ? { title: metadata.title } : {}),
      ...(!combined.image && metadata.image ? { image: metadata.image } : {})
    }), {});
}

export function mergeProductMetadata(pageMeta = {}, collectedMeta = {}, platform = '') {
  const title = collectedMeta.title || pageMeta.title;
  const image = pageMeta.image || (platform === 'TikTok Shop' ? collectedMeta.image : '');
  const merged = {
    ...collectedMeta,
    ...pageMeta,
    ...(title ? { title } : {})
  };
  if (image) merged.image = image;
  else delete merged.image;
  return merged;
}

export function extractShopeeProductApiMeta(payload = {}) {
  const item = payload?.data?.item || payload?.item || payload?.data || {};
  const title = firstValue(item, ['name', 'title']);
  const rawImage = firstValue(item, ['image', 'images.0', 'image_info_list.0.image']);
  const image = shopeeImageUrl(rawImage);
  return {
    ...(title ? { title: String(title) } : {}),
    ...(image ? { image } : {})
  };
}

export async function fetchShopeeProductApiMeta(shopId, itemId, options = {}) {
  if (!/^\d+$/.test(String(shopId || '')) || !/^\d+$/.test(String(itemId || ''))) return {};
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs) || 5000);
  try {
    const apiUrl = new URL('https://shopee.vn/api/v4/item/get');
    apiUrl.searchParams.set('shopid', String(shopId));
    apiUrl.searchParams.set('itemid', String(itemId));
    const response = await fetchImpl(apiUrl, {
      signal: combineAbortSignals(options.signal, controller.signal),
      headers: {
        accept: 'application/json',
        'accept-language': 'vi-VN,vi;q=0.9,en;q=0.7',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
      }
    });
    if (!response.ok) return {};
    return extractShopeeProductApiMeta(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

export async function getReviews(url, options = {}) {
  throwIfAborted(options.signal);
  const progress = createProgressReporter(options.onProgress);
  let parsed;
  try { parsed = new URL(extractMarketplaceUrl(url)); } catch (error) {
    throw Object.assign(new Error(error?.message || 'Link không hợp lệ.'), { statusCode: error?.statusCode || 400 });
  }
  const platform = platformFrom(parsed.href);
  progress('resolving', 8, 'Đang kiểm tra liên kết...');
  const warnings = [];
  const shopeeProduct = platform === 'Shopee'
    ? await resolveShopeeProductUrl(parsed.href, { signal: options.signal })
    : null;
  const tiktokProduct = platform === 'TikTok Shop'
    ? await resolveTikTokProductUrl(parsed.href, { signal: options.signal })
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

  const metadataUrls = productMetadataUrls(productUrl, {
    platform,
    productId: tiktokProduct?.productId,
    shopId: shopeeProduct?.shopId,
    itemId: shopeeProduct?.itemId
  });
  const productMetaPromise = Promise.all([
    fetchProductPageMetaCandidates(metadataUrls, {
      expectedProductId: tiktokProduct?.productId,
      expectedShopId: shopeeProduct?.shopId,
      expectedItemId: shopeeProduct?.itemId,
      signal: options.signal
    }),
    shopeeProduct
      ? fetchShopeeProductApiMeta(shopeeProduct.shopId, shopeeProduct.itemId, { signal: options.signal })
      : Promise.resolve({})
  ])
    .then(([pageMeta, platformMeta]) => ({ ...pageMeta, ...platformMeta }))
    .catch(() => ({}));
  try {
    progress('collecting', 14, 'Đang khởi tạo hệ thống lấy reviews...');
    const collected = platform === 'Shopee'
      ? await collectShopeeReviews(productUrl, { reviewLimit: perStarLimit, onProgress: options.onProgress, signal: options.signal })
      : await collectTikTokReviews(tiktokProduct.productId, { productUrl, onProgress: options.onProgress, signal: options.signal });
    const reviews = collected.reviews;
    const pageMeta = await productMetaPromise;
    const collectedMeta = normaliseProductMeta({
      ...(collected.productMetaSource || {}),
      ...(collected.productMeta || {})
    });
    const productMeta = mergeProductMetadata(pageMeta, collectedMeta, platform);
    if (Array.isArray(collected.warnings)) warnings.push(...collected.warnings);
    return {
      reviews,
      source: {
        type: 'live',
        label: platform === 'Shopee' ? 'Apify · Shopee Product Reviews Scraper' : 'Apify · TikTok Product Reviews Scraper',
        reviewLimit: collected.collection?.targetMaximum || reviewLimit,
        collection: collected.collection,
        credential: collected.credential,
        usage: collected.usage
      },
      product: {
        platform,
        url: productUrl,
        originalUrl: parsed.href,
        ...productMeta,
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



