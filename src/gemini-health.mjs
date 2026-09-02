import { isRedisConfigured, redisCommand } from './redis-rest.mjs';

export const GEMINI_HEALTH_KEY = 'realview:gemini:route-health:v1';
const MINUTE_MS = 60_000;
const MAX_EVENT_AGE_MS = 5 * MINUTE_MS;
export const GEMINI_TIMEOUT_COOLDOWN_MS = 120_000;
export const GEMINI_MODEL_LIMITS = Object.freeze({
  'gemini-3.5-flash-lite': { rpm: 15, tpm: 250_000, rpd: 500 }
});

const BEGIN_ROUTE_SCRIPT = String.raw`
-- GEMINI_HEALTH_BEGIN
local raw = redis.call('HGET', KEYS[1], ARGV[1])
local state = raw and cjson.decode(raw) or {}
local nowMs = tonumber(ARGV[2]) or 0
local rpm = math.max(0, tonumber(ARGV[5]) or 0)
local tpm = math.max(0, tonumber(ARGV[6]) or 0)
local rpd = math.max(0, tonumber(ARGV[7]) or 0)
local reservedTokens = math.max(0, tonumber(ARGV[8]) or 0)
if state.day ~= ARGV[4] then
  state.day = ARGV[4]
  state.dayRequests = 0
end
if tonumber(state.lastStartedAtMs or 0) < nowMs - 120000 then
  state.inFlight = 0
  state.reservedTokens = 0
end
local starts = {}
for _, startedAt in ipairs(state.starts or {}) do
  if tonumber(startedAt or 0) >= nowMs - ${MINUTE_MS} then table.insert(starts, tonumber(startedAt)) end
end
local recentTokens = 0
for _, event in ipairs(state.events or {}) do
  if tonumber(event.at or 0) >= nowMs - ${MINUTE_MS} then
    recentTokens = recentTokens + math.max(0, tonumber(event.tokens) or 0)
  end
end
local currentReservedTokens = math.max(0, tonumber(state.reservedTokens or 0))
if tonumber(state.cooldownUntilMs or 0) > nowMs then
  return cjson.encode({ok=false, code='COOLDOWN', state=state})
end
if rpm > 0 and #starts >= rpm then
  return cjson.encode({ok=false, code='RPM_LIMIT', state=state})
end
if tpm > 0 and recentTokens + currentReservedTokens + reservedTokens > tpm then
  return cjson.encode({ok=false, code='TPM_LIMIT', state=state})
end
if rpd > 0 and tonumber(state.dayRequests or 0) >= rpd then
  return cjson.encode({ok=false, code='RPD_LIMIT', state=state})
end
table.insert(starts, nowMs)
while #starts > 30 do table.remove(starts, 1) end
state.starts = starts
state.inFlight = math.max(0, tonumber(state.inFlight or 0)) + 1
state.reservedTokens = currentReservedTokens + reservedTokens
state.dayRequests = math.max(0, tonumber(state.dayRequests or 0)) + 1
state.lastStartedAt = ARGV[3]
state.lastStartedAtMs = nowMs
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(state))
return cjson.encode({ok=true, state=state})
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
state.reservedTokens = math.max(0, tonumber(state.reservedTokens or 0) - math.max(0, tonumber(ARGV[10]) or 0))
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
table.insert(events, {at=nowMs, ok=ok, latencyMs=latencyMs, tokens=math.max(0, tonumber(ARGV[9]) or 0), statusCode=statusCode > 0 and statusCode or cjson.null})
while #events > 30 do table.remove(events, 1) end
state.events = events
local cooldownUntilMs = math.max(0, tonumber(state.cooldownUntilMs or 0))
if not ok then
  local cooldownMs = 0
  if statusCode == 429 then cooldownMs = ${MINUTE_MS}
  elseif ARGV[8] == 'timeout' then cooldownMs = ${GEMINI_TIMEOUT_COOLDOWN_MS}
  elseif statusCode == 503 then
    cooldownMs = state.consecutiveFailures >= 2 and 120000 or ${MINUTE_MS}
  elseif statusCode >= 500 then cooldownMs = 15000 end
  if cooldownMs == 0 then cooldownMs = ${MINUTE_MS} end
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

export function configuredGeminiLimit(model) {
  const limits = parseJson(process.env.GEMINI_MODEL_LIMITS_JSON, {});
  const item = limits?.[model] || GEMINI_MODEL_LIMITS[model] || {};
  return {
    rpm: Math.max(0, number(item.rpm)),
    tpm: Math.max(0, number(item.tpm)),
    rpd: Math.max(0, number(item.rpd))
  };
}

function normalizeState(state, nowMs) {
  const next = state && typeof state === 'object' ? { ...state } : {};
  next.events = Array.isArray(next.events)
    ? next.events.filter((event) => number(event.at) >= nowMs - MAX_EVENT_AGE_MS).slice(-30)
    : [];
  next.starts = Array.isArray(next.starts)
    ? next.starts.map((value) => number(value)).filter((value) => value >= nowMs - MINUTE_MS).slice(-30)
    : [];
  if (next.day !== pacificDay(nowMs)) {
    next.day = pacificDay(nowMs);
    next.dayRequests = 0;
  }
  next.inFlight = Math.max(0, number(next.inFlight));
  next.reservedTokens = Math.max(0, number(next.reservedTokens));
  if (number(next.lastStartedAtMs) < nowMs - 120_000) {
    next.inFlight = 0;
    next.reservedTokens = 0;
  }
  next.dayRequests = Math.max(0, number(next.dayRequests));
  next.consecutiveFailures = Math.max(0, number(next.consecutiveFailures));
  next.cooldownUntilMs = Math.max(0, number(next.cooldownUntilMs));
  return next;
}

export function geminiRoutePressure(state, model, nowMs = Date.now()) {
  const current = normalizeState(state, nowMs);
  const recent = current.events.filter((event) => number(event.at) >= nowMs - MINUTE_MS);
  const recentStarts = current.starts.length ? current.starts : recent.map((event) => number(event.at));
  const failures = recent.filter((event) => !event.ok).length;
  const recentTokens = recent.reduce((sum, event) => sum + Math.max(0, number(event.tokens)), 0) + current.reservedTokens;
  const limits = configuredGeminiLimit(model);
  const rpmRatio = limits.rpm ? recentStarts.length / limits.rpm : recentStarts.length / 10;
  const tpmRatio = limits.tpm ? recentTokens / limits.tpm : 0;
  const rpdRatio = limits.rpd ? current.dayRequests / limits.rpd : 0;
  const minuteLimited = Boolean((limits.rpm && recentStarts.length >= limits.rpm)
    || (limits.tpm && recentTokens >= limits.tpm));
  const dailyLimited = Boolean(limits.rpd && current.dayRequests >= limits.rpd);
  const utilization = Math.max(rpmRatio, tpmRatio, rpdRatio);
  const quotaPressure = utilization + Math.max(0, utilization - 0.8) * 20;
  const latencyPressure = Math.max(0, number(current.ewmaLatencyMs) - 2_500) / 7_500;
  const failurePressure = recent.length ? failures / recent.length : 0;
  return {
    cooldown: current.cooldownUntilMs > nowMs,
    recentRequests: recentStarts.length,
    recentTokens,
    dayRequests: current.dayRequests,
    limits,
    minuteLimited,
    dailyLimited,
    inFlight: current.inFlight,
    value: quotaPressure + current.inFlight * 0.35 + latencyPressure + failurePressure
  };
}

export function geminiRouteScore(state, model, nowMs = Date.now()) {
  const pressure = geminiRoutePressure(state, model, nowMs);
  if (pressure.cooldown || pressure.minuteLimited || pressure.dailyLimited) return Number.POSITIVE_INFINITY;
  return pressure.value;
}

export async function getGeminiHealthSnapshot(options = {}) {
  if (!isRedisConfigured()) return {};
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
}

export async function beginGeminiRoute(routeId, options = {}) {
  if (!isRedisConfigured()) return null;
  const nowMs = number(options.nowMs, Date.now());
  const limits = configuredGeminiLimit(options.model);
  const raw = await redisCommand([
    'EVAL', BEGIN_ROUTE_SCRIPT, '1', GEMINI_HEALTH_KEY,
    routeId, String(nowMs), new Date(nowMs).toISOString(), pacificDay(nowMs),
    String(limits.rpm), String(limits.tpm), String(limits.rpd), String(Math.max(0, number(options.reservedTokens)))
  ], options);
  return parseJson(raw, null);
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
      String(statusCode || 0), String(latencyMs), String(result?.errorType || 'unknown').slice(0, 80),
      String(Math.max(0, number(result?.tokens))), String(Math.max(0, number(result?.reservedTokens)))
    ], options);
    return parseJson(raw, null);
  } catch {
    return null;
  }
}
