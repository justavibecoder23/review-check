import { combineAbortSignals } from './abort.mjs';

const DIRECT_SHOPEE_HOSTS = new Set([
  'shopee.vn',
  'www.shopee.vn'
]);

const SHORT_SHOPEE_HOSTS = new Set([
  's.shopee.vn',
  'shope.ee',
  'www.shope.ee',
  'vn.shp.ee'
]);

const ALLOWED_SHOPEE_HOSTS = new Set([
  ...DIRECT_SHOPEE_HOSTS,
  ...SHORT_SHOPEE_HOSTS
]);

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const NESTED_URL_KEYS = [
  'origin_link',
  'url',
  'target',
  'redirect',
  'redirect_url',
  'deep_link',
  'deep_link_url',
  'universal_link'
];

function httpError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function cleanHostname(hostname) {
  return hostname.toLowerCase().replace(/\.$/, '');
}

function stripTrailingPunctuation(value) {
  return value.replace(/[\]\[}{),.;]+$/g, '');
}

export function extractMarketplaceUrl(rawInput) {
  if (typeof rawInput !== 'string' || !rawInput.trim()) {
    throw httpError('Hãy dán link sản phẩm Shopee hoặc TikTok Shop.');
  }

  const input = rawInput.trim();
  if (input.length > 8_000) throw httpError('Link hoặc nội dung được dán quá dài.');

  try {
    const direct = new URL(input);
    if (direct.protocol === 'https:' || direct.protocol === 'http:') return direct.href;
  } catch {
    // Nội dung được sao chép từ ứng dụng có thể kèm tên và giá sản phẩm.
  }

  const markdownUrl = input.match(/\]\((https?:\/\/[^\s)]+)\)/i)?.[1];
  const plainUrl = input.match(/https?:\/\/[^\s<>"']+/i)?.[0];
  const bareMarketplaceUrl = input.match(/(?:^|\s)((?:(?:www\.)?shopee\.vn|s\.shopee\.vn|(?:www\.)?shope\.ee|vn\.shp\.ee|(?:www\.|shop\.|vt\.|vm\.)?tiktok\.com)\/[^\s<>"']+)/i)?.[1];
  const candidate = stripTrailingPunctuation(markdownUrl || plainUrl || bareMarketplaceUrl || '');

  if (!candidate) throw httpError('Không tìm thấy đường dẫn trong nội dung đã dán.');
  try {
    return new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`).href;
  } catch {
    throw httpError('Link không hợp lệ.');
  }
}

export function isShopeeUrl(value) {
  try {
    const host = cleanHostname(new URL(value).hostname);
    return ALLOWED_SHOPEE_HOSTS.has(host);
  } catch {
    return false;
  }
}

function assertSafeShopeeUrl(url) {
  const host = cleanHostname(url.hostname);
  if (url.protocol !== 'https:') {
    throw httpError('Link Shopee phải sử dụng kết nối HTTPS an toàn.');
  }
  if (url.username || url.password || (url.port && url.port !== '443')) {
    throw httpError('Link Shopee chứa thông tin kết nối không được hỗ trợ.');
  }
  if (!ALLOWED_SHOPEE_HOSTS.has(host)) {
    throw httpError('Link chuyển hướng ra ngoài miền Shopee nên đã bị chặn để bảo vệ máy chủ.');
  }
  return host;
}

export function getShopeeProductIds(value) {
  const url = value instanceof URL ? value : new URL(value);
  const pathname = url.pathname;

  const matches = [
    pathname.match(/(?:-i\.|\/product-i\.)(\d+)\.(\d+)(?:\/|$)/i),
    pathname.match(/\/product\/(\d+)\/(\d+)(?:\/|$)/i),
    pathname.match(/^\/[^/]+\/(\d+)\/(\d+)\/?$/i)
  ];

  const match = matches.find(Boolean);
  if (match) return { shopId: match[1], itemId: match[2] };

  const shopId = url.searchParams.get('shopid') || url.searchParams.get('shop_id');
  const itemId = url.searchParams.get('itemid') || url.searchParams.get('item_id');
  if (/^\d+$/.test(shopId || '') && /^\d+$/.test(itemId || '')) return { shopId, itemId };

  return null;
}

export function canonicalShopeeProductUrl(shopId, itemId) {
  return `https://shopee.vn/product-i.${shopId}.${itemId}`;
}

function decodeNestedUrl(value) {
  let candidate = String(value || '').trim().replace(/&amp;/gi, '&').replace(/\\\//g, '/');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url;
      return null;
    } catch {
      try {
        const decoded = decodeURIComponent(candidate);
        if (decoded === candidate) return null;
        candidate = decoded;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function nestedTargetFrom(url) {
  for (const key of NESTED_URL_KEYS) {
    const nested = decodeNestedUrl(url.searchParams.get(key));
    if (nested) return nested;
  }
  return null;
}

function candidateFromHtml(html, baseUrl) {
  const patterns = [
    /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*?url=([^"'>\s]+)/i,
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i,
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i,
    /(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)/i,
    /location\.replace\(\s*["']([^"']+)/i
  ];

  for (const pattern of patterns) {
    const raw = html.match(pattern)?.[1];
    if (!raw) continue;
    const cleaned = raw.replace(/&amp;/gi, '&').replace(/\\\//g, '/');
    try {
      return new URL(cleaned, baseUrl);
    } catch {
      // Thử mẫu tiếp theo.
    }
  }
  return null;
}

async function readLimitedText(response, maxBytes = 256_000) {
  if (!response.body?.getReader) return (await response.text()).slice(0, maxBytes);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let output = '';

  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    output += decoder.decode(value, { stream: true });
  }
  output += decoder.decode();
  if (total >= maxBytes) await reader.cancel().catch(() => {});
  return output.slice(0, maxBytes);
}

function resolvedProduct(originalUrl, resolvedUrl, redirectCount) {
  const ids = getShopeeProductIds(resolvedUrl);
  if (!ids) return null;
  return {
    originalUrl: originalUrl.href,
    resolvedUrl: resolvedUrl.href,
    canonicalUrl: canonicalShopeeProductUrl(ids.shopId, ids.itemId),
    shopId: ids.shopId,
    itemId: ids.itemId,
    wasShortened: SHORT_SHOPEE_HOSTS.has(cleanHostname(originalUrl.hostname)),
    redirectCount
  };
}

function timeoutError() {
  return httpError('Link chia sẻ Shopee phản hồi quá chậm. Hãy thử lại hoặc dán link từ thanh địa chỉ sản phẩm.', 504);
}

export async function resolveShopeeProductUrl(rawInput, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Number(options.timeoutMs || 8_000);
  const maxRedirects = Number(options.maxRedirects || 5);
  const originalUrl = new URL(extractMarketplaceUrl(rawInput));
  const originalHost = assertSafeShopeeUrl(originalUrl);

  const direct = resolvedProduct(originalUrl, originalUrl, 0);
  if (direct && DIRECT_SHOPEE_HOSTS.has(originalHost)) return direct;

  let currentUrl = originalUrl;
  let redirectCount = 0;
  const visited = new Set();
  const startedAt = Date.now();

  while (redirectCount <= maxRedirects) {
    const currentHost = assertSafeShopeeUrl(currentUrl);
    if (visited.has(currentUrl.href)) throw httpError('Link chia sẻ Shopee tạo vòng lặp chuyển hướng.', 422);
    visited.add(currentUrl.href);

    const product = resolvedProduct(originalUrl, currentUrl, redirectCount);
    if (product && DIRECT_SHOPEE_HOSTS.has(currentHost)) return product;

    const nestedTarget = nestedTargetFrom(currentUrl);
    if (nestedTarget) {
      if (redirectCount >= maxRedirects) {
        throw httpError('Link chia sẻ Shopee chuyển hướng quá nhiều lần.', 422);
      }
      assertSafeShopeeUrl(nestedTarget);
      currentUrl = nestedTarget;
      redirectCount += 1;
      continue;
    }

    if (DIRECT_SHOPEE_HOSTS.has(currentHost)) {
      throw httpError('Link Shopee này không dẫn đến một sản phẩm có mã shop và mã sản phẩm.', 422);
    }
    if (!SHORT_SHOPEE_HOSTS.has(currentHost)) {
      throw httpError('Định dạng link chia sẻ Shopee này chưa được hỗ trợ.', 422);
    }

    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) throw timeoutError();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingMs);
    let response;
    try {
      response = await fetchImpl(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'user-agent': 'Mozilla/5.0 (compatible; RealView/1.0; +https://review-check-beige.vercel.app)'
        },
        cache: 'no-store',
        signal: combineAbortSignals(options.signal, controller.signal)
      });
    } catch (error) {
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw timeoutError();
      throw httpError(`Không mở được link chia sẻ Shopee: ${error?.message || 'lỗi kết nối'}.`, 502);
    } finally {
      clearTimeout(timer);
    }

    if (REDIRECT_STATUS_CODES.has(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw httpError('Shopee trả về chuyển hướng nhưng không có địa chỉ đích.', 502);
      if (redirectCount >= maxRedirects) {
        throw httpError('Link chia sẻ Shopee chuyển hướng quá nhiều lần.', 422);
      }
      currentUrl = new URL(location, currentUrl);
      redirectCount += 1;
      continue;
    }

    if (!response.ok) {
      throw httpError(`Không mở được link chia sẻ Shopee: HTTP ${response.status}.`, 502);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      throw httpError('Link chia sẻ Shopee không trả về trang sản phẩm hợp lệ.', 422);
    }

    const htmlTarget = candidateFromHtml(await readLimitedText(response), currentUrl);
    if (!htmlTarget) throw httpError('Không tìm thấy trang sản phẩm phía sau link chia sẻ Shopee.', 422);
    if (redirectCount >= maxRedirects) {
      throw httpError('Link chia sẻ Shopee chuyển hướng quá nhiều lần.', 422);
    }
    currentUrl = htmlTarget;
    redirectCount += 1;
  }

  throw httpError('Link chia sẻ Shopee chuyển hướng quá nhiều lần.', 422);
}
