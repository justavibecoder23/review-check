import { createHash } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { normalizePlatform } from '../src/counterpart-search.mjs';
import {
  createCounterpartJob,
  publicCounterpartJob,
  resumeCounterpartJob
} from '../src/counterpart-job-store.mjs';
import { isRedisConfigured, redisCommand } from '../src/redis-rest.mjs';
import { isShopeeUrl, getShopeeProductIds } from '../src/shopee-url.mjs';
import { readShopeeProductMetadata } from '../src/shopee-product-metadata.mjs';

const MAX_BODY_BYTES = 12_000;

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'private, no-store');
  response.end(JSON.stringify(payload));
}

async function requestBody(request) {
  if (request.body && typeof request.body === 'object') return request.body;
  if (typeof request.body === 'string') {
    if (Buffer.byteLength(request.body) > MAX_BODY_BYTES) throw Object.assign(new Error('Payload quá lớn.'), { statusCode: 413 });
    return JSON.parse(request.body || '{}');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Payload quá lớn.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function sourceFromPayload(payload = {}) {
  const source = payload.source && typeof payload.source === 'object' ? payload.source : {};
  return {
    platform: normalizePlatform(source.platform),
    title: String(source.title || '').trim().slice(0, 240),
    url: String(source.url || '').trim().slice(0, 2_000),
    image: String(source.image || source.imageUrl || source.thumbnail || '').trim().slice(0, 2_000),
    itemId: String(source.itemId || '').trim().slice(0, 80),
    productId: String(source.productId || '').trim().slice(0, 80),
    resultId: String(source.resultId || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80),
    analysisCompletedAt: Number.isFinite(Date.parse(source.analysisCompletedAt || ''))
      ? new Date(source.analysisCompletedAt).toISOString()
      : ''
  };
}

function isSameOriginRequest(request) {
  const origin = String(request.headers?.origin || '').trim();
  const host = String(request.headers?.['x-forwarded-host'] || request.headers?.host || '').split(',')[0].trim();
  if (!origin || !host) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function requestUrl(request) {
  return new URL(request.url || '/api/match-counterpart', 'https://realview.local');
}

async function withinRateLimit(request) {
  if (!isRedisConfigured()) return true;
  const forwarded = String(request.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const address = forwarded || request.socket?.remoteAddress || 'unknown';
  const identity = createHash('sha256').update(address).digest('hex').slice(0, 20);
  const hour = new Date().toISOString().slice(0, 13);
  const key = `realview:counterpart:rate:${hour}:${identity}`;
  try {
    const count = Number(await redisCommand(['INCR', key], { timeoutMs: 1_500 }));
    if (count === 1) await redisCommand(['EXPIRE', key, '3700'], { timeoutMs: 1_500 }).catch(() => null);
    return count <= 12;
  } catch {
    return true;
  }
}

export default async function handler(request, response) {
  if (!['GET', 'POST'].includes(request.method)) {
    response.setHeader('allow', 'GET, POST');
    return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
  }

  if (!isSameOriginRequest(request)) return sendJson(response, 403, { error: 'ORIGIN_NOT_ALLOWED' });
  if (requestUrl(request).searchParams.get('operation') === 'product-media') {
    return sendJson(response, 410, { error: 'PRODUCT_MEDIA_MIRROR_DISABLED' });
  }
  if (request.method === 'POST' && !(await withinRateLimit(request))) {
    return sendJson(response, 429, { status: 'unavailable', reason: 'rate_limited' });
  }

  try {
    if (requestUrl(request).searchParams.get('operation') === 'product-metadata') {
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      const sourceUrl = requestUrl(request).searchParams.get('sourceUrl') || '';
      const ids = isShopeeUrl(sourceUrl) ? getShopeeProductIds(sourceUrl) : null;
      if (!ids) return sendJson(response, 400, { error: 'INVALID_SOURCE_PRODUCT' });
      // Read-only: polling never starts another paid Actor or reads reviews.
      const metadata = await readShopeeProductMetadata(ids.shopId, ids.itemId);
      return sendJson(response, 200, {
        status: metadata?.image ? 'ready' : metadata?.attempted ? 'unavailable' : 'pending',
        product: { shopId: ids.shopId, itemId: ids.itemId,
          ...(metadata?.title ? { title: metadata.title } : {}),
          ...(metadata?.image ? { image: metadata.image } : {}) }
      });
    }
    if (request.method === 'GET') {
      const jobId = new URL(request.url || '/api/match-counterpart', 'https://realview.local').searchParams.get('jobId');
      if (!/^[a-f0-9]{32}$/.test(String(jobId || ''))) return sendJson(response, 400, { error: 'INVALID_JOB_ID' });
      const scheduled = await resumeCounterpartJob(jobId);
      if (!scheduled.job) return sendJson(response, 404, { error: 'JOB_NOT_FOUND' });
      if (scheduled.background) waitUntil(scheduled.background);
      const payload = publicCounterpartJob(scheduled.job);
      return sendJson(response, ['ready', 'unavailable', 'disabled'].includes(payload.status) ? 200 : 202, payload);
    }
    const source = sourceFromPayload(await requestBody(request));
    if (!source.platform || !source.title || !source.url) {
      return sendJson(response, 400, { error: 'INVALID_SOURCE_PRODUCT' });
    }
    const scheduled = await createCounterpartJob(source);
    if (scheduled.background) waitUntil(scheduled.background);
    const payload = publicCounterpartJob(scheduled.job);
    return sendJson(response, ['ready', 'unavailable', 'disabled'].includes(payload.status) ? 200 : 202, payload);
  } catch (error) {
    console.error('[counterpart] search failed', {
      name: error?.name,
      message: error?.message,
      statusCode: error?.statusCode
    });
    return sendJson(response, Number(error?.statusCode) || 502, {
      status: 'unavailable',
      reason: 'search_failed',
      error: 'Không thể tìm sản phẩm đối ứng lúc này.'
    });
  }
}
