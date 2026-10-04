import { combineAbortSignals } from './abort.mjs';
import { cleanProductTitle } from './product-metadata-quality.mjs';
import { getShopeeProductIds } from './shopee-url.mjs';

const SOURCE_HOST = 'bangiare.com';
const MAX_BYTES = 512 * 1024;
const OFF = /^(false|0|off|no)$/i;

function idsFor(productUrl, options) {
  try {
    const url = new URL(productUrl);
    const ids = getShopeeProductIds(url);
    if (url.protocol !== 'https:' || !/(^|\.)shopee\.vn$/i.test(url.hostname)
      || url.username || url.password || url.port || !ids
      || !/^\d{1,25}$/.test(ids.shopId) || !/^\d{1,25}$/.test(ids.itemId)
      || (options.shopId && String(options.shopId) !== ids.shopId)
      || (options.itemId && String(options.itemId) !== ids.itemId)) return null;
    return ids;
  } catch { return null; }
}

function sourceMatches(value, shopId, itemId) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === SOURCE_HOST
      && !url.username && !url.password && !url.port
      && url.pathname.endsWith(`-zk1.${itemId}.${shopId}.html`);
  } catch { return false; }
}

function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)]
    .map((match) => [match[1].toLowerCase(), match[2].replaceAll('&amp;', '&').replaceAll('&quot;', '"')]));
}

function productImage(value) {
  const candidate = Array.isArray(value) ? value[0] : value;
  try {
    const url = new URL(typeof candidate === 'object' ? candidate?.url || candidate?.contentUrl : candidate);
    return url.protocol === 'https:' && /(^|\.)susercontent\.com$/i.test(url.hostname)
      && !url.username && !url.password && !url.port
      && /^\/file\/[\w-]{16,}$/.test(url.pathname) ? url.href : '';
  } catch { return ''; }
}

// Only root Product nodes/@graph members describing this page qualify. Never
// recursively mine recommendations, buyer reviews or category ItemLists.
export function extractShopeePublicMetadata(html, shopId, itemId) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > MAX_BYTES
    || !/^\d{1,25}$/.test(String(shopId)) || !/^\d{1,25}$/.test(String(itemId))) return null;
  const canonical = [...html.matchAll(/<link\b[^>]*>/gi)].map((match) => attributes(match[0]))
    .find((tag) => /(^|\s)canonical(\s|$)/i.test(tag.rel || ''))?.href;
  if (!sourceMatches(canonical, shopId, itemId)) return null;
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (attributes(match[1]).type?.toLowerCase() !== 'application/ld+json') continue;
    let data;
    try { data = JSON.parse(match[2]); } catch { continue; }
    const roots = Array.isArray(data) ? data : [data];
    const nodes = roots.flatMap((root) => [root, ...(Array.isArray(root?.['@graph']) ? root['@graph'] : [])]);
    for (const node of nodes) {
      const types = Array.isArray(node?.['@type']) ? node['@type'] : [node?.['@type']];
      if (!types.includes('Product') || node.sku !== `1__${itemId}__${shopId}`
        || !sourceMatches(node.url, shopId, itemId)) continue;
      const seller = node.offers?.seller;
      const identifiers = Array.isArray(seller?.identifier) ? seller.identifier : [seller?.identifier];
      if (!identifiers.some((id) => /^Shopee shop ID$/i.test(String(id?.propertyID || ''))
        && String(id?.value) === String(shopId))) continue;
      try {
        const shop = new URL(seller.url);
        if (shop.protocol !== 'https:' || !/(^|\.)shopee\.vn$/i.test(shop.hostname)
          || shop.username || shop.password || shop.port || shop.pathname !== `/shop/${shopId}`) continue;
      } catch { continue; }
      const title = cleanProductTitle(typeof node.name === 'string' ? node.name : '');
      const image = productImage(node.image);
      if (!title || !image || /<[^>]*>/.test(title)) continue;
      return { title, image, source: 'bangiare-exact-id', sourceUrl: canonical };
    }
  }
  return null;
}

async function limitedText(response) {
  if (Number(response.headers?.get?.('content-length')) > MAX_BYTES) throw new Error('PAYLOAD_TOO_LARGE');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('PAYLOAD_TOO_LARGE');
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new Error('PAYLOAD_TOO_LARGE');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function diagnostic(options, source, status, startedAt, extra = {}) {
  try { options.onDiagnostic?.({ source, reason: status, durationMs: Date.now() - startedAt, ...extra }); }
  catch { /* Observability must not interrupt review collection. */ }
}

async function readPublicPage(sourceUrl, ids, options) {
  // Fixed HTTPS allowlist and manual redirects: no fetches of URLs supplied by
  // JSON-LD, affiliate links, search snippets or a source-controlled Location.
  if (!sourceMatches(sourceUrl, ids.shopId, ids.itemId)) return { status: 'id_mismatch' };
  const startedAt = Date.now();
  const timeoutMs = Math.max(100, Math.min(5000, Number(options.timeoutMs) || 2500));
  try {
    const response = await (options.fetchImpl || fetch)(sourceUrl, {
      redirect: 'manual', signal: combineAbortSignals(options.signal, AbortSignal.timeout(timeoutMs)),
      headers: { accept: 'text/html', 'user-agent': 'RealViewMetadata/1.0 (+https://www.realview.com.vn/)' }
    });
    const contentType = response.headers?.get?.('content-type') || '';
    if (!response.ok || (contentType && !/^text\/html\b/i.test(contentType))) {
      diagnostic(options, 'bangiare_exact_id', 'http_error', startedAt, { status: response.status });
      await response.body?.cancel?.().catch(() => {});
      return { status: 'failed' };
    }
    const metadata = extractShopeePublicMetadata(await limitedText(response), ids.shopId, ids.itemId);
    diagnostic(options, 'bangiare_exact_id', metadata ? 'resolved' : 'metadata_missing', startedAt,
      { status: response.status, hasTitle: Boolean(metadata?.title), hasImage: Boolean(metadata?.image), sourceUrl });
    return { status: metadata ? 'resolved' : 'empty', metadata, latencyMs: Date.now() - startedAt };
  } catch (error) {
    const status = /Timeout|Abort/.test(error.name) ? 'timeout' : 'failed';
    diagnostic(options, 'bangiare_exact_id', status, startedAt);
    return { status };
  }
}

export async function fetchShopeePublicMetadata(productUrl, options = {}) {
  const env = options.env || process.env;
  if (OFF.test(String(env.SHOPEE_PUBLIC_METADATA_ENABLED || ''))) return { status: 'disabled' };
  const ids = idsFor(productUrl, options);
  if (!ids) return { status: 'id_mismatch' };
  return readPublicPage(`https://${SOURCE_HOST}/san-pham-zk1.${ids.itemId}.${ids.shopId}.html`, ids, options);
}

export async function fetchShopeeSeoMetadata(productUrl, options = {}) {
  const env = options.env || process.env;
  // Explicit opt-in: search uses a separate provider quota, not Apify's pool.
  const key = String(env.SERPAPI_API_KEY || env.GOOGLE_LENS_SERPAPI_KEY || '').trim();
  if (env.SHOPEE_METADATA_SEO_ENABLED !== 'true' || !key) return { status: 'disabled' };
  const ids = idsFor(productUrl, options);
  if (!ids) return { status: 'id_mismatch' };
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(100, Math.min(5000, Number(options.timeoutMs) || 4000));
  const seen = new Set();
  try {
    for (const query of [`"${ids.shopId}" "${ids.itemId}"`, `site:${SOURCE_HOST} "${ids.itemId}"`]) {
      if (Date.now() >= deadline || seen.size >= 3) break;
      const endpoint = new URL('https://serpapi.com/search.json');
      for (const [name, value] of Object.entries({ engine: 'google', q: query, gl: 'vn', hl: 'vi', num: '5', api_key: key })) {
        endpoint.searchParams.set(name, value);
      }
      const response = await (options.fetchImpl || fetch)(endpoint, {
        redirect: 'manual', signal: combineAbortSignals(options.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now())))
      });
      if (!response.ok) throw new Error('SEARCH_HTTP_ERROR');
      const payload = JSON.parse(await limitedText(response));
      if (payload.error) throw new Error('SEARCH_PROVIDER_ERROR');
      for (const result of (Array.isArray(payload.organic_results) ? payload.organic_results : []).slice(0, 5)) {
        const candidate = String(result.link || '');
        if (seen.size >= 3 || Date.now() >= deadline) break;
        if (seen.has(candidate) || !sourceMatches(candidate, ids.shopId, ids.itemId)) continue;
        seen.add(candidate);
        const found = await readPublicPage(candidate, ids, { ...options, timeoutMs: Math.min(2500, Math.max(1, deadline - Date.now())) });
        if (found.metadata) return { ...found, latencyMs: Date.now() - startedAt };
      }
    }
    diagnostic(options, 'metadata_seo', 'metadata_missing', startedAt);
    return { status: 'empty' };
  } catch (error) {
    const status = /Timeout|Abort/.test(error.name) ? 'timeout' : 'failed';
    // Never log the search endpoint: its URL contains a private API key.
    diagnostic(options, 'metadata_seo', status, startedAt);
    return { status };
  }
}
