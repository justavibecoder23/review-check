import { randomUUID } from 'node:crypto';
import { redisCommand, isRedisConfigured } from './redis-rest.mjs';
import { getShopeeProductIds } from './shopee-url.mjs';
import { getShopeeProductMetadata, setShopeeProductMetadata } from './product-cache.mjs';
import { cleanProductTitle } from './product-metadata-quality.mjs';
import {
  reserveShopeeDetailCostCredential,
  finalizeShopeeDetailCostCredential
} from './apify-credential-store.mjs';
import { classifyApifyFailure } from './apify-tiktok-runtime.mjs';

const ACTOR_ID = 'zen-studio/shopee-product-detail-scraper';
const LOCK_RELEASE_SCRIPT = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
const COOLDOWN_SECONDS = 10 * 60;

function cooldownKey(shopId, itemId) {
  return `realview:product-meta:v1:shopee:actor-cooldown:${shopId}:${itemId}`;
}

export function shopeeDetailEnabled(env = process.env) {
  return !['false', '0', 'off', 'no'].includes(String(env.SHOPEE_DETAIL_ACTOR_ENABLED || '').toLowerCase());
}

export function normalizeShopeeDetailActorItem(item, shopId, itemId) {
  if (!item || String(item.shopId ?? item.shop_id ?? '') !== String(shopId)
    || String(item.itemId ?? item.item_id ?? '') !== String(itemId)) return null;
  const title = cleanProductTitle(item.name || item.title);
  const rawImage = String(item.image || item.images?.[0] || '').trim();
  let image = '';
  if (/^[\w-]{16,}$/.test(rawImage)) image = `https://down-vn.img.susercontent.com/file/${rawImage}`;
  else {
    try {
      const url = new URL(rawImage);
      if (url.protocol === 'https:' && /(?:^|\.)susercontent\.com$/i.test(url.hostname)) image = url.href;
    } catch { /* Invalid or untrusted image. */ }
  }
  return title || image ? { ...(title ? { title } : {}), ...(image ? { image } : {}) } : null;
}

async function acquireLock(shopId, itemId, options) {
  const key = `realview:product-meta:v1:shopee:actor-lock:${shopId}:${itemId}`;
  const owner = randomUUID();
  // A timed-out Apify start may still have created a run. Keep this product
  // reserved long enough to prevent an automatic second paid run.
  const result = await redisCommand(['SET', key, owner, 'NX', 'EX', '1800'], {
    fetchImpl: options.redisFetchImpl, timeoutMs: 1_500
  });
  return result === 'OK' ? { key, owner } : null;
}

async function releaseLock(lock, options) {
  if (!lock) return;
  await redisCommand(['EVAL', LOCK_RELEASE_SCRIPT, '1', lock.key, lock.owner], {
    fetchImpl: options.redisFetchImpl, timeoutMs: 1_500
  }).catch(() => null);
}

export async function fetchShopeeDetailActorMetadata(productUrl, options = {}) {
  const env = options.env || process.env;
  if (!shopeeDetailEnabled(env)) return { status: 'disabled' };
  let parsed;
  try { parsed = new URL(productUrl); } catch { return { status: 'invalid_url' }; }
  if (parsed.protocol !== 'https:' || !/(?:^|\.)shopee\.vn$/i.test(parsed.hostname)) return { status: 'invalid_url' };
  const ids = getShopeeProductIds(parsed);
  if (!ids || (options.shopId && ids.shopId !== String(options.shopId))
    || (options.itemId && ids.itemId !== String(options.itemId))) return { status: 'id_mismatch' };
  const cached = await getShopeeProductMetadata(ids.shopId, ids.itemId, options);
  if (cached?.title && cached?.image) return { status: 'cached', metadata: cached };
  if (!isRedisConfigured() && !options.redisFetchImpl) return { status: 'unavailable' };
  const coolingDown = await redisCommand(['GET', cooldownKey(ids.shopId, ids.itemId)], {
    fetchImpl: options.redisFetchImpl, timeoutMs: 1_500
  }).catch(() => null);
  if (coolingDown) return { status: 'cooldown', metadata: cached };
  const lock = await acquireLock(ids.shopId, ids.itemId, options).catch(() => null);
  if (!lock) return { status: 'pending' };

  let credential;
  let actorRunId = '';
  let actorStarted = false;
  let actualCostMicroUsd = null;
  let itemCount = 0;
  let metadataResolved = false;
  let metadataComplete = false;
  let statusCode = 0;
  let failureClass = '';
  const startedAt = Date.now();
  const timeoutMs = Math.max(5_000, Math.min(25_000, Number(env.SHOPEE_DETAIL_ACTOR_TIMEOUT_MS) || 12_000));
  const deadline = startedAt + timeoutMs;
  const fetchImpl = options.fetchImpl || fetch;
  const plannedCostMicroUsd = Math.max(5_000, Math.min(250_000,
    Number(env.SHOPEE_DETAIL_MAX_COST_MICRO_USD) || 50_000));
  try {
    // Double-check under the per-product lock before spending a run.
    const afterLock = await getShopeeProductMetadata(ids.shopId, ids.itemId, options);
    if (afterLock?.title && afterLock?.image) return { status: 'cached', metadata: afterLock };
    const allocation = await (options.reserveImpl || reserveShopeeDetailCostCredential)({
      actorId: ACTOR_ID,
      plannedCostMicroUsd,
      fetchImpl: options.redisFetchImpl,
      usageFetchImpl: options.usageFetchImpl
    });
    credential = allocation.credential;
    const endpoint = `https://api.apify.com/v2/acts/${encodeURIComponent(ACTOR_ID.replace('/', '~'))}`;
    const runUrl = new URL(`${endpoint}/runs`);
    // Obtain the run ID promptly, then poll. Waiting until the entire local
    // deadline in this first request would make a network timeout ambiguous.
    runUrl.searchParams.set('waitForFinish', '1');
    // The same ceiling is reserved in Redis and enforced by Apify. An Actor
    // pricing change must not silently spend the budget kept for review runs.
    runUrl.searchParams.set('maxTotalChargeUsd', String(plannedCostMicroUsd / 1_000_000));
    const start = await fetchImpl(runUrl.href, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ startUrls: [{ url: parsed.href }], includeReviews: false }),
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now()))
    });
    statusCode = start.status;
    if (!start.ok) throw Object.assign(new Error(`Actor chi tiết trả HTTP ${start.status}`), { statusCode: start.status });
    let run = (await start.json()).data;
    actorRunId = String(run?.id || '');
    actorStarted = Boolean(actorRunId);
    if (!actorRunId) throw new Error('Actor không trả runId.');
    while (!['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'].includes(String(run.status).toUpperCase())) {
      if (Date.now() >= deadline) throw Object.assign(new Error('Actor metadata quá hạn.'), { name: 'TimeoutError' });
      const poll = await fetchImpl(`https://api.apify.com/v2/actor-runs/${encodeURIComponent(actorRunId)}?waitForFinish=2`, {
        headers: { authorization: `Bearer ${credential.token}` },
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now()))
      });
      statusCode = poll.status;
      if (!poll.ok) throw Object.assign(new Error(`Actor status HTTP ${poll.status}`), { statusCode: poll.status });
      run = (await poll.json()).data;
    }
    if (run.usageTotalUsd !== null && run.usageTotalUsd !== undefined
      && run.usageTotalUsd !== '' && Number.isFinite(Number(run.usageTotalUsd))) {
      actualCostMicroUsd = Math.max(0, Math.round(Number(run.usageTotalUsd) * 1_000_000));
    }
    if (String(run.status).toUpperCase() !== 'SUCCEEDED') {
      statusCode = 502;
      throw Object.assign(new Error(`Actor ${run.status}`), { failureClass: 'actor_run_failed' });
    }
    if (!run.defaultDatasetId) throw new Error('Actor không có dataset.');
    const dataset = await fetchImpl(`https://api.apify.com/v2/datasets/${encodeURIComponent(run.defaultDatasetId)}/items?clean=true&limit=1`, {
      headers: { authorization: `Bearer ${credential.token}` },
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now()))
    });
    statusCode = dataset.status;
    if (!dataset.ok) throw Object.assign(new Error(`Dataset HTTP ${dataset.status}`), { statusCode: dataset.status });
    const items = await dataset.json();
    itemCount = Array.isArray(items) ? items.length : 0;
    const metadata = normalizeShopeeDetailActorItem(items?.[0], ids.shopId, ids.itemId);
    metadataResolved = Boolean(metadata?.title || metadata?.image);
    metadataComplete = Boolean((metadata?.title || afterLock?.title)
      && (metadata?.image || afterLock?.image));
    if (metadata) await setShopeeProductMetadata(ids.shopId, ids.itemId,
      { ...afterLock, ...metadata }, { ...options, source: 'detail-actor' });
    return { status: metadata ? 'resolved' : 'empty', metadata, latencyMs: Date.now() - startedAt };
  } catch (error) {
    failureClass = error?.failureClass || (credential
      ? classifyApifyFailure(error?.statusCode, error)
      : 'reservation_failed');
    // A terminal run may have a known bill even if reading its dataset fails.
    // Finalize that actual cost instead of leaving a stale reservation.
    if (actorStarted && actualCostMicroUsd != null
      && ['timeout', 'upstream_service_error', 'unknown_error'].includes(failureClass)) {
      failureClass = 'actor_run_failed';
    }
    return { status: failureClass === 'timeout' ? 'timeout' : 'failed', latencyMs: Date.now() - startedAt };
  } finally {
    if (credential) await (options.finalizeImpl || finalizeShopeeDetailCostCredential)(credential, {
      actorId: ACTOR_ID, actorRunId, actualCostMicroUsd: actualCostMicroUsd ?? 0,
      itemCount, statusCode, actorStarted, metadataResolved,
      failureClass: actorStarted && actualCostMicroUsd == null
        && !['timeout', 'upstream_service_error', 'unknown_error'].includes(failureClass)
        ? 'cost_pending' : failureClass,
      retryAfterMs: failureClass === 'timeout' || (actorStarted && actualCostMicroUsd == null)
        ? 30 * 60_000 : undefined
    }, { fetchImpl: options.redisFetchImpl }).catch(() => null);
    console.log(JSON.stringify({
      level: 'info', event: 'shopee_detail_actor_attempt',
      shopId: ids.shopId, itemId: ids.itemId,
      actorStarted, actorRunId: actorRunId || null,
      itemCount, latencyMs: Date.now() - startedAt,
      actualCostMicroUsd, failureClass: failureClass || null
    }));
    const ambiguousStart = Boolean(credential && !actorRunId
      && ['timeout', 'upstream_service_error', 'unknown_error'].includes(failureClass));
    if (!ambiguousStart && !(actorStarted && actualCostMicroUsd == null)) {
      // A failed or partial paid run must not be immediately repeated by a
      // page refresh or replay of the same signed metadata ticket.
      let mayRelease = true;
      if (credential && !metadataComplete) {
        const cooldownSaved = await redisCommand(['SET', cooldownKey(ids.shopId, ids.itemId), '1',
          'EX', String(COOLDOWN_SECONDS)], {
          fetchImpl: options.redisFetchImpl, timeoutMs: 1_500
        }).then(() => true).catch(() => false);
        mayRelease = cooldownSaved;
      }
      if (mayRelease) await releaseLock(lock, options);
    }
  }
}
