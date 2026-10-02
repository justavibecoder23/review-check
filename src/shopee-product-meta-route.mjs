import { getShopeeProductIds, isShopeeUrl } from '../src/shopee-url.mjs';
import { getShopeeProductMetadata, setShopeeProductMetadata } from '../src/product-cache.mjs';
import { fetchProductPageMetaCandidates, fetchShopeeProductApiMeta, productMetadataUrls } from '../src/sources.mjs';
import { fetchShopeeDetailActorMetadata, shopeeDetailEnabled } from '../src/shopee-detail-metadata.mjs';
import { verifyShopeeMetadataTicket } from '../src/shopee-metadata-ticket.mjs';

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
  if (url.protocol !== 'https:' || !isShopeeUrl(url.href)) throw new Error('INVALID_SHOPEE_URL');
  const ids = getShopeeProductIds(url);
  if (!ids) throw new Error('MISSING_PRODUCT_ID');
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
  const cached = await getShopeeProductMetadata(product.shopId, product.itemId).catch(() => null);
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

  // This route is independent of the analysis request. The Actor is the
  // primary source; free page/API probes only run if it fails or is disabled.
  const ids = { platform: 'Shopee', shopId: product.shopId, itemId: product.itemId };
  const actor = actorEnabled()
    ? await fetchActor(product.url, ids)
    : { status: 'disabled' };
  let metadata = { ...cached, ...actor.metadata };
  if (actor.status === 'pending') return send(response, 200, {
    status: 'pending', shopId: product.shopId, itemId: product.itemId, metadata
  });
  if (metadata.title && metadata.image) return send(response, 200, {
    status: 'resolved', shopId: product.shopId, itemId: product.itemId, metadata,
    ...(actor.latencyMs != null ? { actorLatencyMs: actor.latencyMs } : {})
  });
  const [page, api] = await Promise.all([
    fetchPage(productMetadataUrls(product.url, ids), {
      expectedShopId: product.shopId, expectedItemId: product.itemId, timeoutMs: 2_500
    }).catch(() => ({})),
    fetchItemApi(product.shopId, product.itemId, { timeoutMs: 2_500 }).catch(() => ({}))
  ]);
  metadata = { ...metadata, ...page, ...api };
  if (metadata.title || metadata.image) {
    const saved = await setShopeeProductMetadata(product.shopId, product.itemId, metadata,
      { source: 'background-free-probe' }).catch(() => null);
    metadata = saved?.metadata || metadata;
  }
  if (metadata.title && metadata.image) return send(response, 200, { status: 'resolved',
    shopId: product.shopId, itemId: product.itemId, metadata });
  return send(response, 200, {
    status: metadata.title || metadata.image ? 'partial' : actor.status === 'disabled' ? 'free_sources_empty' : actor.status,
    shopId: product.shopId, itemId: product.itemId,
    metadata,
    ...(actor.latencyMs != null ? { actorLatencyMs: actor.latencyMs } : {})
  });
  };
}

export default createShopeeProductMetaHandler();
