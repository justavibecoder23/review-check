import { combineAbortSignals } from './abort.mjs';
import { isRedisConfigured, redisCommand } from './redis-rest.mjs';
import { reserveCounterpartCostCredential, finalizeCounterpartCostCredential } from './apify-credential-store.mjs';
import { getShopeeProductIds } from './shopee-url.mjs';
import { cleanProductTitle } from './product-metadata-quality.mjs';
import { classifyApifyFailure } from './apify-tiktok-runtime.mjs';

function metadataKey(shopId, itemId) {
  if (!/^\d+$/.test(String(shopId)) || !/^\d+$/.test(String(itemId))) throw new Error('Invalid Shopee product identity');
  return `realview:product-meta:v1:shopee:${shopId}:${itemId}`;
}

export function normalizeShopeeProductDetails(shopId, itemId, value = {}, { requireIdentity = false } = {}) {
  const ids = value.url ? (() => { try { return getShopeeProductIds(value.url); } catch { return null; } })() : null;
  const foundShopId = value.shopId ?? value.shop_id ?? value.shopid ?? ids?.shopId;
  const foundItemId = value.itemId ?? value.item_id ?? value.itemid ?? ids?.itemId;
  if ((requireIdentity && (foundShopId == null || foundItemId == null))
    || (foundShopId != null && String(foundShopId) !== String(shopId))
    || (foundItemId != null && String(foundItemId) !== String(itemId))) return {};
  const title = cleanProductTitle(value.title || value.name || value.productName);
  let image = String(value.image || value.productImage || value.images?.[0] || '').trim();
  if (/^[\w-]{16,}$/.test(image)) image = `https://down-vn.img.susercontent.com/file/${image}`;
  try {
    const url = new URL(image);
    if (url.protocol !== 'https:' || !/(^|\.)(?:susercontent|shopeeusercontent)\.com$/i.test(url.hostname)
      || url.username || url.password || url.port) image = '';
    else image = url.href;
  } catch { image = ''; }
  const categoryPath = value.categoryPath || value.categoryBreadcrumb || value.feCategoryBreadcrumb;
  return {
    ...(title ? { title } : {}), ...(image ? { image } : {}),
    ...(Array.isArray(categoryPath) ? { categoryPath: categoryPath.filter((entry) => typeof entry === 'string') } : {})
  };
}

export async function readShopeeProductMetadata(shopId, itemId, options = {}) {
  if (!isRedisConfigured() && !options.redisFetchImpl) return null;
  const raw = await redisCommand(['GET', metadataKey(shopId, itemId)], {
    fetchImpl: options.redisFetchImpl, timeoutMs: 900
  }).catch(() => null);
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!value || String(value.shopId) !== String(shopId) || String(value.itemId) !== String(itemId)) return null;
    return { ...normalizeShopeeProductDetails(shopId, itemId, value), attempted: true };
  } catch { return null; }
}

export async function writeShopeeProductMetadata(shopId, itemId, metadata, options = {}) {
  if (!isRedisConfigured() && !options.redisFetchImpl) return;
  const normalized = normalizeShopeeProductDetails(shopId, itemId, metadata);
  const ttl = normalized.image ? 5 * 24 * 60 * 60 : 5 * 60;
  await redisCommand(['SET', metadataKey(shopId, itemId), JSON.stringify({
    shopId: String(shopId), itemId: String(itemId), ...normalized
  }), 'EX', String(ttl)], { fetchImpl: options.redisFetchImpl, timeoutMs: 1200 }).catch(() => null);
}

// Product rows from this actor are separate from buyer reviews. Fetch one exact
// product only when page/API metadata is unavailable; use the existing cost pool.
export async function fetchShopeeProductDetails(product, options = {}) {
  const env = options.env || process.env;
  if (!options.reserveCounterpartImpl && (!isRedisConfigured() || !env.APIFY_TOKEN_VAULT_KEY)) return {};
  const actorId = String(env.SHOPEE_PRODUCT_METADATA_ACTOR_ID || 'zen-studio/shopee-product-detail-scraper').replace('~', '/');
  const timeoutMs = Math.max(10_000, Math.min(35_000, Number(env.SHOPEE_PRODUCT_METADATA_TIMEOUT_MS) || 30_000));
  const signal = combineAbortSignals(options.signal, AbortSignal.timeout(timeoutMs));
  const fetchImpl = options.fetchImpl || fetch;
  const allocation = await (options.reserveCounterpartImpl || reserveCounterpartCostCredential)({
    actorId, plannedCostMicroUsd: 25_000, pricingVersion: 'shopee-product-metadata-2026-10',
    fetchImpl: options.redisFetchImpl, usageFetchImpl: options.usageFetchImpl
  });
  const credential = allocation.credential;
  const headers = { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' };
  let runId = null, cost = null, started = false, statusCode = 0, itemCount = 0, failureClass = '';
  try {
    const response = await fetchImpl(`https://api.apify.com/v2/acts/${encodeURIComponent(actorId.replace('/', '~'))}/runs?waitForFinish=20&maxTotalChargeUsd=0.025`, {
      method: 'POST', headers, signal,
      body: JSON.stringify({ startUrls: [{ url: product.resolvedUrl || product.canonicalUrl }], includeReviews: false })
    });
    statusCode = response.status;
    if (!response.ok) throw Object.assign(new Error(`Shopee metadata actor HTTP ${response.status}`), { statusCode });
    let run = (await response.json())?.data;
    runId = run?.id;
    started = Boolean(runId);
    if (!runId) throw new Error('Shopee metadata actor missing run ID');
    while (!['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'].includes(run.status)) {
      const poll = await fetchImpl(`https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}?waitForFinish=5`, { headers, signal });
      statusCode = poll.status;
      if (!poll.ok) throw Object.assign(new Error('Shopee metadata actor polling failed'), { statusCode });
      run = (await poll.json())?.data;
      if (!run) throw new Error('Shopee metadata actor missing status');
    }
    cost = run.usageTotalUsd != null && Number.isFinite(Number(run.usageTotalUsd)) ? Math.round(Number(run.usageTotalUsd) * 1_000_000) : null;
    if (run.status !== 'SUCCEEDED' || !run.defaultDatasetId) throw new Error(`Shopee metadata actor ${run.status}`);
    const dataset = await fetchImpl(`https://api.apify.com/v2/datasets/${encodeURIComponent(run.defaultDatasetId)}/items?clean=true&limit=1`, { headers, signal });
    statusCode = dataset.status;
    if (!dataset.ok) throw Object.assign(new Error('Shopee metadata dataset failed'), { statusCode });
    const rows = await dataset.json();
    itemCount = Array.isArray(rows) ? rows.length : 0;
    return normalizeShopeeProductDetails(product.shopId, product.itemId, rows?.[0] || {}, { requireIdentity: true });
  } catch (error) {
    failureClass = classifyApifyFailure(error?.statusCode, error);
    throw error;
  } finally {
    await (options.finalizeCounterpartImpl || finalizeCounterpartCostCredential)(credential, {
      actorId, actorRunId: runId, actorStarted: started, actualCostMicroUsd: cost ?? 0, itemCount, statusCode,
      failureClass: started && cost == null && !failureClass ? 'cost_pending' : failureClass
    }, { fetchImpl: options.redisFetchImpl }).catch(() => null);
  }
}
