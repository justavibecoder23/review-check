import { isRedisConfigured, redisCommand } from './redis-rest.mjs';

export const APIFY_TIKTOK_CIRCUIT_KEY = 'realview:apify:circuit-breaker:tiktok:v1';

const RECORD_SCRIPT = String.raw`
-- TIKTOK_CIRCUIT_BREAKER_V1
local actorId = ARGV[1]
local outcome = ARGV[2]
local nowMs = tonumber(ARGV[3]) or 0
local threshold = tonumber(ARGV[4]) or 3
local openMs = tonumber(ARGV[5]) or 300000
local state = {consecutiveFailures=0, state='closed', openUntilMs=0}
local raw = redis.call('HGET', KEYS[1], actorId)
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and type(decoded) == 'table' then state = decoded end
end
if outcome == 'success' then
  state = {consecutiveFailures=0, state='closed', openUntilMs=0, lastSuccessAt=nowMs}
elseif outcome == 'failure' then
  state.consecutiveFailures = (tonumber(state.consecutiveFailures) or 0) + 1
  state.lastFailureAt = nowMs
  if state.consecutiveFailures >= threshold then
    state.state = 'open'
    state.openUntilMs = nowMs + openMs
  end
end
redis.call('HSET', KEYS[1], actorId, cjson.encode(state))
return cjson.encode(state)
`;

function integer(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

export async function getTikTokCircuitState(actorId, options = {}) {
  if (!isRedisConfigured()) return { state: 'closed', consecutiveFailures: 0, openUntilMs: 0 };
  try {
    const raw = await redisCommand(['HGET', APIFY_TIKTOK_CIRCUIT_KEY, actorId], options);
    const state = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
    const nowMs = options.nowMs ?? Date.now();
    if (!state || Number(state.openUntilMs) <= nowMs) return { ...state, state: 'closed', openUntilMs: 0 };
    return state;
  } catch {
    return { state: 'closed', consecutiveFailures: 0, openUntilMs: 0 };
  }
}

export async function assertTikTokCircuitClosed(actorId, options = {}) {
  const state = await getTikTokCircuitState(actorId, options);
  if (state.state !== 'open') return state;
  const error = new Error('Nguồn thu thập TikTok đang tạm ngắt sau nhiều lỗi liên tiếp.');
  error.code = 'TIKTOK_CIRCUIT_OPEN';
  error.statusCode = 503;
  error.retryAt = new Date(Number(state.openUntilMs)).toISOString();
  throw error;
}

export async function recordTikTokActorHealth(actorId, outcome, options = {}) {
  if (!isRedisConfigured() || !['success', 'failure', 'neutral'].includes(outcome)) return null;
  if (outcome === 'neutral') return getTikTokCircuitState(actorId, options);
  try {
    const raw = await redisCommand([
      'EVAL', RECORD_SCRIPT, '1', APIFY_TIKTOK_CIRCUIT_KEY,
      actorId, outcome, String(options.nowMs ?? Date.now()),
      String(integer(process.env.TIKTOK_CIRCUIT_FAILURE_THRESHOLD, 3, 2, 20)),
      String(integer(process.env.TIKTOK_CIRCUIT_OPEN_MS, 300_000, 30_000, 3_600_000))
    ], options);
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}
