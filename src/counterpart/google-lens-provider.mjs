const SERPAPI_ENDPOINT = 'https://serpapi.com/search.json';

function apiKey(env = process.env) {
  return String(env.GOOGLE_LENS_SERPAPI_KEY || env.SERPAPI_API_KEY || '').trim();
}

export function isGoogleLensConfigured(env = process.env) {
  return Boolean(apiKey(env));
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function targetHostPattern(platform) {
  return platform === 'Shopee'
    ? /(^|\.)shopee\.vn$/i
    : /(^|\.)(?:tiktok\.com|tiktokshop\.com)$/i;
}

function validTargetUrl(value, platform) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && targetHostPattern(platform).test(url.hostname) ? url.href : '';
  } catch {
    return '';
  }
}

function normalizeMatch(item, platform, index, exact = false) {
  const url = validTargetUrl(item?.link || item?.product_link, platform);
  const image = String(item?.image || item?.thumbnail || '').trim();
  const title = String(item?.title || '').trim();
  if (!url || !/^https:\/\//i.test(image) || !title) return null;
  return {
    title,
    url,
    image,
    images: [image],
    price: item?.price?.value ?? item?.price?.extracted_value ?? item?.price ?? '',
    rating: Number(item?.rating) || null,
    reviewCount: item?.reviews ?? item?.review_count ?? item?.rating_count ?? 0,
    shopName: String(item?.source || '').trim(),
    searchRank: index + 1,
    lensExact: exact || Boolean(item?.exact_matches),
    discoveryMethod: exact ? 'google-lens-exact' : 'google-lens-visual'
  };
}

export function normalizeGoogleLensResponse(payload, platform) {
  const exact = array(payload?.exact_matches).map((item, index) => normalizeMatch(item, platform, index, true));
  const visual = array(payload?.visual_matches).map((item, index) => normalizeMatch(item, platform, exact.length + index, false));
  const seen = new Set();
  return [...exact, ...visual].filter((item) => {
    if (!item || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

export async function searchGoogleLens(imageUrl, targetPlatform, options = {}) {
  const env = options.env || process.env;
  const key = apiKey(env);
  if (!key) return [];
  const endpoint = new URL(SERPAPI_ENDPOINT);
  endpoint.searchParams.set('engine', 'google_lens');
  endpoint.searchParams.set('url', String(imageUrl));
  endpoint.searchParams.set('country', 'vn');
  endpoint.searchParams.set('hl', 'vi');
  endpoint.searchParams.set('type', 'all');
  endpoint.searchParams.set('api_key', key);
  const configuredTimeoutMs = Math.max(5_000, Number(env.COUNTERPART_LENS_TIMEOUT_MS) || 15_000);
  const availableMs = Number.isFinite(Number(options.deadlineAt))
    ? Number(options.deadlineAt) - Date.now() - 5_000
    : configuredTimeoutMs;
  if (availableMs < 1_000) throw Object.assign(new Error('Hết thời gian tìm kiếm Google Lens.'), { code: 'COUNTERPART_DEADLINE' });
  const response = await (options.fetchImpl || fetch)(endpoint, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(Math.min(configuredTimeoutMs, availableMs))
  });
  if (!response.ok) throw Object.assign(new Error(`Google Lens provider trả về HTTP ${response.status}.`), { statusCode: response.status });
  const payload = await response.json();
  if (payload?.error) throw new Error(String(payload.error).slice(0, 240));
  return normalizeGoogleLensResponse(payload, targetPlatform);
}
