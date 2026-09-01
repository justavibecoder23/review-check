const DIRECT_TIKTOK_HOSTS = new Set([
  'tiktok.com',
  'www.tiktok.com',
  'shop.tiktok.com'
]);

const SHORT_TIKTOK_HOSTS = new Set([
  'vt.tiktok.com',
  'vm.tiktok.com'
]);

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

function httpError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function cleanHostname(hostname) {
  return String(hostname || '').toLowerCase().replace(/\.$/, '');
}

function isAllowedHost(hostname) {
  const host = cleanHostname(hostname);
  return DIRECT_TIKTOK_HOSTS.has(host) || SHORT_TIKTOK_HOSTS.has(host) || host.endsWith('.tiktok.com');
}

function assertSafeTikTokUrl(url) {
  if (url.protocol !== 'https:') throw httpError('Link TikTok Shop phải sử dụng HTTPS an toàn.');
  if (url.username || url.password || (url.port && url.port !== '443')) {
    throw httpError('Link TikTok Shop chứa thông tin kết nối không được hỗ trợ.');
  }
  if (!isAllowedHost(url.hostname)) {
    throw httpError('Link chuyển hướng ra ngoài miền TikTok nên đã bị chặn để bảo vệ máy chủ.');
  }
  return cleanHostname(url.hostname);
}

function isTikTokRedirector(url) {
  return SHORT_TIKTOK_HOSTS.has(cleanHostname(url.hostname)) || /^\/t\//i.test(url.pathname);
}

export function isTikTokUrl(value) {
  try {
    return isAllowedHost(new URL(value).hostname);
  } catch {
    return false;
  }
}

export function getTikTokProductId(value) {
  const url = value instanceof URL ? value : new URL(value);
  const queryKeys = ['product_id', 'productId', 'product-id', 'id'];
  for (const key of queryKeys) {
    const candidate = url.searchParams.get(key);
    if (/^\d{8,25}$/.test(candidate || '')) return candidate;
  }

  const matches = [
    url.pathname.match(/\/shop\/pdp\/(?:[^/]+\/)?(\d{8,25})(?:\/|$)/i),
    url.pathname.match(/\/(?:view\/)?product\/(\d{8,25})(?:\/|$)/i),
    url.pathname.match(/\/products?\/(\d{8,25})(?:\/|$)/i)
  ];
  return matches.find(Boolean)?.[1] || null;
}

function productResult(originalUrl, resolvedUrl, redirectCount) {
  const productId = getTikTokProductId(resolvedUrl);
  if (!productId) return null;
  return {
    originalUrl: originalUrl.href,
    resolvedUrl: resolvedUrl.href,
    productUrl: resolvedUrl.href,
    productId,
    wasShortened: SHORT_TIKTOK_HOSTS.has(cleanHostname(originalUrl.hostname)),
    redirectCount
  };
}

function timeoutError() {
  return httpError('Link chia sẻ TikTok phản hồi quá chậm. Hãy thử lại hoặc dán link sản phẩm đầy đủ.', 504);
}

export async function resolveTikTokProductUrl(rawInput, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Number(options.timeoutMs || 8_000);
  const maxRedirects = Number(options.maxRedirects || 5);
  const originalUrl = new URL(rawInput);
  assertSafeTikTokUrl(originalUrl);
  const direct = productResult(originalUrl, originalUrl, 0);
  if (direct && !isTikTokRedirector(originalUrl)) return direct;

  let currentUrl = originalUrl;
  let redirectCount = 0;
  const visited = new Set();
  const startedAt = Date.now();

  while (redirectCount <= maxRedirects) {
    assertSafeTikTokUrl(currentUrl);
    if (visited.has(currentUrl.href)) throw httpError('Link chia sẻ TikTok tạo vòng lặp chuyển hướng.', 422);
    visited.add(currentUrl.href);

    const product = productResult(originalUrl, currentUrl, redirectCount);
    if (product && !isTikTokRedirector(currentUrl)) return product;
    if (!isTikTokRedirector(currentUrl)) {
      throw httpError('Link TikTok này không dẫn đến một sản phẩm có mã sản phẩm.', 422);
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
        signal: controller.signal
      });
    } catch (error) {
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw timeoutError();
      throw httpError(`Không mở được link chia sẻ TikTok: ${error?.message || 'lỗi kết nối'}.`, 502);
    } finally {
      clearTimeout(timer);
    }

    if (!REDIRECT_STATUS_CODES.has(response.status)) {
      throw httpError(`Không mở được link chia sẻ TikTok: HTTP ${response.status}.`, 502);
    }
    const location = response.headers.get('location');
    if (!location) throw httpError('TikTok trả về chuyển hướng nhưng không có địa chỉ đích.', 502);
    if (redirectCount >= maxRedirects) throw httpError('Link chia sẻ TikTok chuyển hướng quá nhiều lần.', 422);
    currentUrl = new URL(location, currentUrl);
    assertSafeTikTokUrl(currentUrl);
    redirectCount += 1;
  }

  throw httpError('Link chia sẻ TikTok chuyển hướng quá nhiều lần.', 422);
}
