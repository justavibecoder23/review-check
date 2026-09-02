import { isRedisConfigured, redisCommand } from './redis-rest.mjs';

export const GEMINI_HEALTH_KEY = 'realview:gemini:route-health:v1';
const MINUTE_MS = 60_000;
const MAX_EVENT_AGE_MS = 5 * MINUTE_MS;
const CONFIRMED_MODEL_LIMITS = Object.freeze({
  'gemini-3.5-flash': { rpm: 5, rpd: 20 }
});

const BEGIN_ROUTE_SCRIPT = String.raw`
-- GEMINI_HEALTH_BEGIN
local raw = redis.call('HGET', KEYS[1], ARGV[1])
local state = raw and cjson.decode(raw) or {}
if state.day ~= ARGV[4] then
  state.day = ARGV[4]
  state.dayRequests = 0
end
if tonumber(state.lastStartedAtMs or 0) < tonumber(ARGV[2]) - 120000 then state.inFlight = 0 end
state.inFlight = math.max(0, tonumber(state.inFlight or 0)) + 1
state.dayRequests = math.max(0, tonumber(state.dayRequests or 0)) + 1
state.lastStartedAt = ARGV[3]
state.lastStartedAtMs = tonumber(ARGV[2])
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(state))
return cjson.encode(state)
`;

const FINISH_ROUTE_SCRIPT = String.raw`
-- GEMINI_HEALTH_FINISH
local raw = redis.call('HGET', KEYS[1], ARGV[1])
local state = raw and cjson.decode(raw) or {}
local nowMs = tonumber(ARGV[2]) or 0
local ok = ARGV[5] == '1'
local statusCode = tonumber(ARGV[6]) or 0
local latencyMs = math.max(0, tonumber(ARGV[7]) or 0)
if state.day ~= ARGV[4] then
  state.day = ARGV[4]
  state.dayRequests = 0
end
state.inFlight = math.max(0, tonumber(state.inFlight or 0) - 1)
local previousLatency = tonumber(state.ewmaLatencyMs or 0)
if previousLatency > 0 then
  state.ewmaLatencyMs = math.floor(previousLatency * 0.75 + latencyMs * 0.25 + 0.5)
else
  state.ewmaLatencyMs = math.floor(latencyMs + 0.5)
end
state.consecutiveFailures = ok and 0 or math.max(0, tonumber(state.consecutiveFailures or 0)) + 1
state.lastStatusCode = statusCode > 0 and statusCode or cjson.null
state.lastError = ok and cjson.null or ARGV[8]
state.lastFinishedAt = ARGV[3]
state.lastFinishedAtMs = nowMs
local events = {}
for _, event in ipairs(state.events or {}) do
  if tonumber(event.at or 0) >= nowMs - ${MAX_EVENT_AGE_MS} then table.insert(events, event) end
end
table.insert(events, {at=nowMs, ok=ok, latencyMs=latencyMs, statusCode=statusCode > 0 and statusCode or cjson.null})
while #events > 30 do table.remove(events, 1) end
state.events = events
local cooldownUntilMs = math.max(0, tonumber(state.cooldownUntilMs or 0))
if not ok then
  local cooldownMs = 0
  if statusCode == 429 then cooldownMs = ${MINUTE_MS}
  elseif ARGV[8] == 'timeout' or statusCode == 503 then
    cooldownMs = state.consecutiveFailures >= 2 and ${MINUTE_MS} or 15000
  elseif statusCode >= 500 then cooldownMs = 15000 end
  state.cooldownUntilMs = math.max(cooldownUntilMs, nowMs + cooldownMs)
else
  state.cooldownUntilMs = 0
end
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(state))
return cjson.encode(state)
`;

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseJson(value, fallback) {
  try { return value ? (typeof value === 'string' ? JSON.parse(value) : value) : fallback; } catch { return fallback; }
}

function pacificDay(nowMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(nowMs));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function geminiRouteId(credentialId, model) {
  return `${String(credentialId || 'environment')}:${String(model)}`;
}

function configuredLimit(model) {
  const limits = parseJson(process.env.GEMINI_MODEL_LIMITS_JSON, {});
  const item = limits?.[model] || CONFIRMED_MODEL_LIMITS[model] || {};
  return {
    rpm: Math.max(0, number(item.rpm)),
    rpd: Math.max(0, number(item.rpd))
  };
}

function normalizeState(state, nowMs) {
  const next = state && typeof state === 'object' ? { ...state } : {};
  next.events = Array.isArray(next.events)
    ? next.events.filter((event) => number(event.at) >= nowMs - MAX_EVENT_AGE_MS).slice(-30)
    : [];
  if (next.day !== pacificDay(nowMs)) {
    next.day = pacificDay(nowMs);
    next.dayRequests = 0;
  }
  next.inFlight = Math.max(0, number(next.inFlight));
  if (number(next.lastStartedAtMs) < nowMs - 120_000) next.inFlight = 0;
  next.dayRequests = Math.max(0, number(next.dayRequests));
  next.consecutiveFailures = Math.max(0, number(next.consecutiveFailures));
  next.cooldownUntilMs = Math.max(0, number(next.cooldownUntilMs));
  return next;
}

export function geminiRoutePressure(state, model, nowMs = Date.now()) {
  const current = normalizeState(state, nowMs);
  const recent = current.events.filter((event) => number(event.at) >= nowMs - MINUTE_MS);
  const failures = recent.filter((event) => !event.ok).length;
  const limits = configuredLimit(model);
  const rpmRatio = limits.rpm ? recent.length / limits.rpm : recent.length / 10;
  const rpdRatio = limits.rpd ? current.dayRequests / limits.rpd : 0;
  const quotaPressure = Math.max(0, Math.max(rpmRatio, rpdRatio) - 0.8) * 5;
  const latencyPressure = Math.max(0, number(current.ewmaLatencyMs) - 2_500) / 7_500;
  const failurePressure = recent.length ? failures / recent.length : 0;
  return {
    cooldown: current.cooldownUntilMs > nowMs,
    recentRequests: recent.length,
    dayRequests: current.dayRequests,
    inFlight: current.inFlight,
    value: quotaPressure + current.inFlight * 0.35 + latencyPressure + failurePressure
  };
}

export function geminiRouteScore(state, model, nowMs = Date.now()) {
  const pressure = geminiRoutePressure(state, model, nowMs);
  if (pressure.cooldown) return Number.POSITIVE_INFINITY;
  return pressure.value;
}

export async function getGeminiHealthSnapshot(options = {}) {
  if (!isRedisConfigured()) return {};
  try {
    const routeIds = [...new Set((options.routeIds || []).map(String).filter(Boolean))];
    if (routeIds.length) {
      const values = await redisCommand(['HMGET', GEMINI_HEALTH_KEY, ...routeIds], options);
      return Object.fromEntries(routeIds.map((routeId, index) => [routeId, parseJson(values?.[index], {})]));
    }
    const raw = await redisCommand(['HGETALL', GEMINI_HEALTH_KEY], options);
    const pairs = Array.isArray(raw) ? raw : Object.entries(raw || {}).flat();
    const result = {};
    for (let index = 0; index < pairs.length; index += 2) result[pairs[index]] = parseJson(pairs[index + 1], {});
    return result;
  } catch {
    return {};
  }
}

export async function beginGeminiRoute(routeId, options = {}) {
  if (!isRedisConfigured()) return null;
  try {
    const nowMs = number(options.nowMs, Date.now());
    const raw = await redisCommand([
      'EVAL', BEGIN_ROUTE_SCRIPT, '1', GEMINI_HEALTH_KEY,
      routeId, String(nowMs), new Date(nowMs).toISOString(), pacificDay(nowMs)
    ], options);
    return parseJson(raw, null);
  } catch {
    return null;
  }
}

export async function finishGeminiRoute(routeId, result, options = {}) {
  if (!isRedisConfigured()) return null;
  try {
    const nowMs = number(options.nowMs, Date.now());
    const ok = Boolean(result?.ok);
    const statusCode = number(result?.statusCode);
    const latencyMs = Math.max(0, number(result?.latencyMs));
    const raw = await redisCommand([
      'EVAL', FINISH_ROUTE_SCRIPT, '1', GEMINI_HEALTH_KEY,
      routeId, String(nowMs), new Date(nowMs).toISOString(), pacificDay(nowMs), ok ? '1' : '0',
      String(statusCode || 0), String(latencyMs), String(result?.errorType || 'unknown').slice(0, 80)
    ], options);
    return parseJson(raw, null);
  } catch {
    return null;
  }
}
