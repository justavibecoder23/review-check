import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { redisCommand, isRedisConfigured } from './redis-rest.mjs';
import { pruneAnalysisReport } from '../public/history-manager.js';
import { saveAccountHistory } from './account-store.mjs';

const PREFIX = 'realview:guest-analysis:v1';
const COOKIE = 'realview_guest';
const LIMIT = 3;
const IP_DEVICE_LIMIT = 20;
const LEASE_SECONDS = 120;
const GUEST_HISTORY_SECONDS = 30 * 24 * 60 * 60;
const SAME_PRODUCT_SECONDS = 5 * 24 * 60 * 60;

function quotaError(message, code, statusCode = 429, remainingGuestQuota = null) {
  return Object.assign(new Error(message), { code, statusCode, remainingGuestQuota });
}

function ensureStorage() {
  if (!isRedisConfigured()) {
    throw quotaError('Hệ thống lượt dùng thử đang tạm thời không khả dụng. Vui lòng thử lại sau.', 'GUEST_QUOTA_UNAVAILABLE', 503);
  }
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

function ipDigest(request) {
  const raw = String(request.headers?.['x-vercel-forwarded-for'] || request.headers?.['x-forwarded-for'] || request.socket?.remoteAddress || '')
    .split(',')[0].trim();
  if (!raw) return '';
  // The Redis token is already mandatory for anonymous quota storage; a separate
  // secret can be supplied to keep IP hashes stable across Redis token rotations.
  const secret = process.env.GUEST_QUOTA_SECRET || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return createHmac('sha256', secret).update(raw).digest('hex').slice(0, 32);
}

function guestId(request, response) {
  const match = String(request.headers?.cookie || '').match(/(?:^|;\s*)realview_guest=([^;]+)/);
  const existing = match?.[1] || '';
  const id = /^[A-Za-z0-9_-]{43}$/.test(existing) ? existing : randomBytes(32).toString('base64url');
  const secure = process.env.VERCEL === '1' || String(request.headers?.['x-forwarded-proto'] || '').toLowerCase() === 'https';
  const cookie = [`${COOKIE}=${id}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', secure ? 'Secure' : '', 'Max-Age=31536000'].filter(Boolean).join('; ');
  const previous = response.getHeader?.('Set-Cookie');
  response.setHeader('Set-Cookie', previous ? [...(Array.isArray(previous) ? previous : [previous]), cookie] : cookie);
  return id;
}

function keys(id, request, rawUrl = '') {
  const device = digest(id);
  const ip = ipDigest(request);
  const url = String(rawUrl || '').trim();
  let product = url;
  try {
    const parsed = new URL(url);
    const shopeeId = parsed.pathname.match(/[.-]i\.\d+\.(\d{8,25})(?:\/|$)/i)?.[1]
      || parsed.pathname.match(/\/product\/\d+\/(\d{8,25})(?:\/|$)/i)?.[1];
    const tiktokId = parsed.pathname.match(/\/pdp\/[^/]*\/(\d{8,25})(?:\/|$)/i)?.[1];
    const directId = shopeeId || tiktokId;
    product = directId
      ? `${tiktokId ? 'tiktok' : 'shopee'}:${directId}`
      : `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname}${parsed.search}`;
  } catch { /* The analyzer will report an invalid link without charging. */ }
  return {
    device,
    count: `${PREFIX}:used:${device}`,
    pending: `${PREFIX}:pending:${device}`,
    duplicate: `${PREFIX}:product:${device}:${digest(product)}`,
    ipCount: ip ? `${PREFIX}:ip-devices:${ip}` : '',
    ipSeen: ip ? `${PREFIX}:ip-seen:${ip}:${device}` : '',
    historyIndex: `${PREFIX}:history:${device}:index`,
    historyItem: (id) => `${PREFIX}:history:${device}:item:${id}`
  };
}

const RESERVE = `
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local pending = redis.call('ZCARD', KEYS[2])
local remaining = math.max(0, tonumber(ARGV[3]) - used - pending)
if redis.call('EXISTS', KEYS[3]) == 1 then return {2, math.max(0, tonumber(ARGV[3]) - used)} end
if redis.call('ZSCORE', KEYS[2], ARGV[4]) then return {4, remaining} end
if remaining <= 0 then return {0, 0} end
if KEYS[4] ~= '' and redis.call('EXISTS', KEYS[5]) == 0 then
  local devices = tonumber(redis.call('GET', KEYS[4]) or '0')
  if devices >= tonumber(ARGV[5]) then return {3, remaining} end
  redis.call('INCR', KEYS[4])
  redis.call('EXPIRE', KEYS[4], 86400)
  redis.call('SET', KEYS[5], '1', 'EX', 86400)
end
redis.call('ZADD', KEYS[2], tonumber(ARGV[1]) + tonumber(ARGV[2]), ARGV[4])
redis.call('EXPIRE', KEYS[2], 300)
return {1, remaining - 1}
`;

const RENEW = `
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 0 end
redis.call('ZADD', KEYS[1], tonumber(ARGV[2]) + tonumber(ARGV[3]), ARGV[1])
redis.call('EXPIRE', KEYS[1], 300)
return 1
`;

const STATUS = `
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
return math.max(0, tonumber(ARGV[2]) - tonumber(redis.call('GET', KEYS[1]) or '0') - redis.call('ZCARD', KEYS[2]))
`;

const CONFIRM = `
local reserved = redis.call('ZREM', KEYS[2], ARGV[1])
local duplicate = redis.call('EXISTS', KEYS[3]) == 1
if reserved == 1 and not duplicate then
  redis.call('INCR', KEYS[1])
  redis.call('SET', KEYS[3], '1', 'EX', ARGV[2])
end
if reserved == 1 or duplicate then
  redis.call('SET', KEYS[5], ARGV[5], 'EX', ARGV[3])
  redis.call('ZADD', KEYS[4], ARGV[4], ARGV[6])
  redis.call('EXPIRE', KEYS[4], ARGV[3])
end
return math.max(0, tonumber(ARGV[7]) - tonumber(redis.call('GET', KEYS[1]) or '0'))
`;

function historyItem(result) {
  const fullReport = pruneAnalysisReport(result);
  const product = fullReport.product;
  const rawId = String(product.productId || product.itemId || '');
  const id = `${product.platform === 'TikTok Shop' ? 'tiktok-shop' : 'shopee'}_${/^\d{1,30}$/.test(rawId) ? rawId : digest(product.url)}`;
  const score = fullReport.trust?.score == null ? NaN : Number(fullReport.trust.score);
  const item = {
    id, platform: product.platform, url: product.url, title: product.title, image: product.image,
    price: product.price, score: Number.isFinite(score) ? score : null,
    tone: fullReport.trust?.tone || 'neutral',
    stats: {
      scanned: fullReport.stats.scanned ?? fullReport.reviews.length,
      kept: fullReport.stats.included ?? fullReport.reviews.filter((review) => review.included).length,
      excluded: fullReport.stats.excluded ?? fullReport.reviews.filter((review) => !review.included).length
    },
    analyzedAt: new Date().toISOString(), fullReport
  };
  while (Buffer.byteLength(JSON.stringify(item), 'utf8') > 650_000 && item.fullReport.reviews.length) {
    item.fullReport.reviews.splice(Math.floor(item.fullReport.reviews.length / 2));
  }
  return item;
}

export async function guestQuotaStatus(request, response, options = {}) {
  ensureStorage();
  const id = guestId(request, response);
  const key = keys(id, request);
  const remaining = Number(await (options.redisCommandImpl || redisCommand)([
    'EVAL', STATUS, '2', key.count, key.pending, String(Math.floor(Date.now() / 1000)), String(LIMIT)
  ]));
  if (!Number.isFinite(remaining)) throw quotaError('Chưa thể đọc lượt dùng thử. Vui lòng thử lại.', 'GUEST_QUOTA_UNAVAILABLE', 503);
  return { remainingGuestQuota: Math.max(0, remaining), guestQuotaLimit: LIMIT };
}

export async function reserveGuestAnalysis(request, response, rawUrl, options = {}) {
  ensureStorage();
  const id = guestId(request, response);
  const key = keys(id, request, rawUrl);
  const command = options.redisCommandImpl || redisCommand;
  const attempt = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const answer = await command(['EVAL', RESERVE, '5', key.count, key.pending, key.duplicate, key.ipCount, key.ipSeen,
    String(now), String(LEASE_SECONDS), String(LIMIT), attempt, String(IP_DEVICE_LIMIT)]);
  const state = Number(answer?.[0]);
  if (state === 0) throw quotaError(`Bạn đã dùng hết ${LIMIT} lượt thử. Hãy đăng ký hoặc đăng nhập để tiếp tục phân tích.`, 'GUEST_QUOTA_EXHAUSTED', 429, 0);
  if (state === 3) throw quotaError('Mạng này đang có quá nhiều thiết bị dùng thử. Hãy đăng nhập để tiếp tục.', 'GUEST_IP_DEVICE_LIMIT', 429, Number(answer[1]));
  if (state !== 1 && state !== 2) throw quotaError('Chưa thể cấp lượt dùng thử. Vui lòng thử lại.', 'GUEST_QUOTA_UNAVAILABLE', 503);
  let timer;
  if (state === 1) {
    timer = setInterval(() => {
      void command(['EVAL', RENEW, '1', key.pending, attempt, String(Math.floor(Date.now() / 1000)), String(LEASE_SECONDS)])
        .catch(() => {});
    }, 30_000);
    timer.unref?.();
  }
  return {
    remainingGuestQuota: Math.max(0, Number(answer[1])),
    async confirm(result) {
      clearInterval(timer);
      const item = historyItem(result);
      const remaining = Number(await command(['EVAL', CONFIRM, '5', key.count, key.pending, key.duplicate, key.historyIndex,
        key.historyItem(item.id), attempt, String(SAME_PRODUCT_SECONDS), String(GUEST_HISTORY_SECONDS),
        String(new Date(item.analyzedAt).getTime()), JSON.stringify(item), item.id, String(LIMIT)]));
      if (!Number.isFinite(remaining)) throw quotaError('Chưa thể xác nhận lượt dùng thử. Vui lòng thử lại.', 'GUEST_QUOTA_UNAVAILABLE', 503);
      return remaining;
    },
    async refund() {
      clearInterval(timer);
      if (state === 1) await command(['ZREM', key.pending, attempt]);
    }
  };
}

export async function claimGuestHistory(request, response, userId, options = {}) {
  const cookie = String(request.headers?.cookie || '').match(/(?:^|;\s*)realview_guest=([^;]+)/)?.[1] || '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(cookie)) return 0;
  const key = keys(cookie, request);
  const command = options.redisCommandImpl || redisCommand;
  const ids = await command(['ZREVRANGE', key.historyIndex, '0', '4']) || [];
  if (!ids.length) return 0;
  const values = await command(['MGET', ...ids.map(key.historyItem)]) || [];
  let claimed = 0;
  for (const value of values) {
    if (!value) continue;
    try {
      await (options.saveAccountHistoryImpl || saveAccountHistory)(userId, JSON.parse(value));
      claimed += 1;
    } catch (error) {
      console.error('[guest-quota] Unable to claim one history item:', error?.message);
    }
  }
  if (claimed === ids.length) await command(['DEL', key.historyIndex, ...ids.map(key.historyItem)]);
  return claimed;
}

export async function discardGuestHistory(request, options = {}) {
  const cookie = String(request.headers?.cookie || '').match(/(?:^|;\s*)realview_guest=([^;]+)/)?.[1] || '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(cookie)) return;
  const key = keys(cookie, request);
  const command = options.redisCommandImpl || redisCommand;
  const ids = await command(['ZREVRANGE', key.historyIndex, '0', '4']) || [];
  await command(['DEL', key.historyIndex, ...ids.map(key.historyItem)]);
}

export const guestQuotaConfig = Object.freeze({ limit: LIMIT, ipDeviceLimit: IP_DEVICE_LIMIT, leaseSeconds: LEASE_SECONDS });
