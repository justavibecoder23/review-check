import { getShopeeProductIds, isShopeeUrl } from '../src/shopee-url.mjs';
import { getShopeeProductMetadata, setShopeeProductMetadata } from '../src/product-cache.mjs';
import { fetchProductPageMetaCandidates, fetchShopeeProductApiMeta, productMetadataUrls } from '../src/sources.mjs';
import { fetchShopeeDetailActorMetadata, shopeeDetailEnabled } from '../src/shopee-detail-metadata.mjs';
import { verifyShopeeMetadataTicket } from '../src/shopee-metadata-ticket.mjs';
import { fetchShopeePublicMetadata, fetchShopeeSeoMetadata } from './shopee-public-metadata.mjs';

function send(response, status, body) {
  response.setHeader('Cache-Control', 'private, no-store');
  return response.status(status).json(body);
}

function requestProduct(request) {
  const body = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : request.body || {};
  const productUrl = String(request.method === 'GET'
    ? new URL(request.url, 'https://realview.local').searchParams.get('url') || ''
    : body.url || '').slice(0, 2_000);
  const url = new URL(productUrl);
  if (url.protocol !== 'https:' || !isShopeeUrl(url.href)
    || url.username || url.password || url.port) throw new Error('INVALID_SHOPEE_URL');
  const ids = getShopeeProductIds(url);
  if (!ids || !/^\d{1,25}$/.test(ids.shopId) || !/^\d{1,25}$/.test(ids.itemId)) throw new Error('MISSING_PRODUCT_ID');
  return { url: url.href, ...ids };
}

function sameOrigin(request) {
  const origin = String(request.headers?.origin || '');
  const host = String(request.headers?.['x-forwarded-host'] || request.headers?.host || '').split(',')[0];
  if (!origin || !host) return true;
  try { return new URL(origin).host === host; } catch { return false; }
}

export function createShopeeProductMetaHandler({
  fetchActor = fetchShopeeDetailActorMetadata,
  actorEnabled = shopeeDetailEnabled,
  fetchPublic = fetchShopeePublicMetadata,
  fetchSeo = fetchShopeeSeoMetadata,
  getMetadata = getShopeeProductMetadata,
  saveMetadata = setShopeeProductMetadata,
  fetchPage = fetchProductPageMetaCandidates,
  fetchItemApi = fetchShopeeProductApiMeta
} = {}) {
  return async function handler(request, response) {
  if (!['GET', 'POST'].includes(request.method)) {
    response.setHeader('Allow', 'GET, POST');
    return send(response, 405, { error: 'METHOD_NOT_ALLOWED' });
  }
  if (!sameOrigin(request)) return send(response, 403, { error: 'ORIGIN_NOT_ALLOWED' });
  let product;
  try { product = requestProduct(request); } catch { return send(response, 400, { error: 'INVALID_SHOPEE_PRODUCT' }); }
  const cached = await getMetadata(product.shopId, product.itemId).catch(() => null);
  if (request.method === 'GET' || (cached?.title && cached?.image)) {
    return send(response, 200, { status: cached ? 'cached' : 'missing', shopId: product.shopId,
      itemId: product.itemId, metadata: cached });
  }
  let body;
  try { body = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : request.body || {}; }
  catch { return send(response, 400, { error: 'INVALID_REQUEST_BODY' }); }
  if (!verifyShopeeMetadataTicket(body.metadataTicket, product.shopId, product.itemId)) {
    return send(response, 403, { error: 'METADATA_TICKET_INVALID' });
  }

  // Exact-ID public data first: an existing paid run's lock must not prevent
  // recovery of this product from a working independent source.
  const ids = { platform: 'Shopee', shopId: product.shopId, itemId: product.itemId };
  const onDiagnostic = (entry) => {
    if (process.env.VERCEL) console.log(JSON.stringify({ event: 'product_metadata_probe',
      platform: 'Shopee', shopId: product.shopId, productId: product.itemId, ...entry }));
  };
  const publicResult = await fetchPublic(product.url, { ...ids, onDiagnostic }).catch(() => ({ status: 'failed' }));
  let metadata = { ...cached, ...publicResult.metadata };
  const resolved = async (source) => {
    const saved = await saveMetadata(product.shopId, product.itemId, metadata, { source }).catch(() => null);
    return send(response, 200, { status: 'resolved', shopId: product.shopId,
      itemId: product.itemId, metadata: saved?.metadata || metadata });
  };
  if (metadata.title && metadata.image) return resolved('bangiare-exact-id');
  const [page, api] = await Promise.all([
    fetchPage(productMetadataUrls(product.url, ids), {
      expectedShopId: product.shopId, expectedItemId: product.itemId, timeoutMs: 2_500, onDiagnostic
    }).catch(() => ({})),
    fetchItemApi(product.shopId, product.itemId, { timeoutMs: 2_500, onDiagnostic }).catch(() => ({}))
  ]);
  metadata = { ...metadata, ...page, ...api };
  if (metadata.title || metadata.image) {
    const saved = await saveMetadata(product.shopId, product.itemId, metadata,
      { source: 'background-free-probe' }).catch(() => null);
    metadata = saved?.metadata || metadata;
  }
  if (metadata.title && metadata.image) return send(response, 200, { status: 'resolved',
    shopId: product.shopId, itemId: product.itemId, metadata });
  const seo = await fetchSeo(product.url, { ...ids, onDiagnostic }).catch(() => ({ status: 'failed' }));
  metadata = { ...metadata, ...seo.metadata };
  if (metadata.title && metadata.image) return resolved('bangiare-exact-id');
  const actor = actorEnabled() ? await fetchActor(product.url, ids) : { status: 'disabled' };
  metadata = { ...metadata, ...actor.metadata };
  if (metadata.title && metadata.image) return resolved('detail-actor');
  return send(response, 200, {
    status: metadata.title || metadata.image ? 'partial' : actor.status === 'disabled' ? 'free_sources_empty' : actor.status,
    shopId: product.shopId, itemId: product.itemId,
    metadata,
    ...(actor.latencyMs != null ? { actorLatencyMs: actor.latencyMs } : {})
  });
  };
}

export default createShopeeProductMetaHandler();
