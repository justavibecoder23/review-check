import { isRedisConfigured, redisCommand } from './redis-rest.mjs';

export const GEMINI_HEALTH_KEY = 'realview:gemini:route-health:v1';
const MINUTE_MS = 60_000;
const MAX_EVENT_AGE_MS = 5 * MINUTE_MS;
const FAILURE_STREAK_WINDOW_MS = 10 * MINUTE_MS;
const LATENCY_HALF_LIFE_MS = 10 * MINUTE_MS;
const LATENCY_OBSERVATION_MAX_AGE_MS = 30 * MINUTE_MS;
const FAST_LATENCY_MS = 8_000;
const SLOW_LATENCY_MS = 15_000;
const ATTEMPT_TIMEOUT_MS = 25_000;
const MAX_LATENCY_PRESSURE = 0.15;
export const GEMINI_TIMEOUT_COOLDOWN_MS = 5_000;
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
if tonumber(state.inFlight or 0) > 0 then
  return cjson.encode({ok=false, code='BUSY', state=state})
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
local neutral = ARGV[8] == 'cancelled'
local statusCode = tonumber(ARGV[6]) or 0
local latencyMs = math.max(0, tonumber(ARGV[7]) or 0)
if state.day ~= ARGV[4] then
  state.day = ARGV[4]
  state.dayRequests = 0
end
state.inFlight = math.max(0, tonumber(state.inFlight or 0) - 1)
state.reservedTokens = math.max(0, tonumber(state.reservedTokens or 0) - math.max(0, tonumber(ARGV[10]) or 0))
if not neutral then
  local previousLatency = tonumber(state.ewmaLatencyMs or 0)
  if previousLatency > 0 then
    state.ewmaLatencyMs = math.floor(previousLatency * 0.75 + latencyMs * 0.25 + 0.5)
  else
    state.ewmaLatencyMs = math.floor(latencyMs + 0.5)
  end
end
if ok then
  state.consecutiveFailures = 0
  state.successfulRequests = math.max(0, tonumber(state.successfulRequests or 0)) + 1
  state.lastSuccessAt = ARGV[3]
  state.lastSuccessAtMs = nowMs
  state.lastStatusCode = statusCode > 0 and statusCode or cjson.null
  state.lastError = cjson.null
elseif not neutral then
  state.consecutiveFailures = math.max(0, tonumber(state.consecutiveFailures or 0)) + 1
  state.failedRequests = math.max(0, tonumber(state.failedRequests or 0)) + 1
  state.lastFailureAt = ARGV[3]
  state.lastFailureAtMs = nowMs
  state.lastStatusCode = statusCode > 0 and statusCode or cjson.null
  state.lastError = ARGV[8]
end
state.lastFinishedAt = ARGV[3]
state.lastFinishedAtMs = nowMs
local events = {}
for _, event in ipairs(state.events or {}) do
  if tonumber(event.at or 0) >= nowMs - ${MAX_EVENT_AGE_MS} then table.insert(events, event) end
end
if not neutral then
  table.insert(events, {at=nowMs, ok=ok, latencyMs=latencyMs, tokens=math.max(0, tonumber(ARGV[9]) or 0), statusCode=statusCode > 0 and statusCode or cjson.null})
end
while #events > 30 do table.remove(events, 1) end
state.events = events
local cooldownUntilMs = math.max(0, tonumber(state.cooldownUntilMs or 0))
if not ok and not neutral then
  local cooldownMs = 0
  if statusCode == 429 then cooldownMs = ${MINUTE_MS}
  elseif ARGV[8] == 'timeout' then cooldownMs = ${GEMINI_TIMEOUT_COOLDOWN_MS}
  elseif statusCode == 503 then
    cooldownMs = state.consecutiveFailures >= 2 and 120000 or ${MINUTE_MS}
  elseif statusCode >= 500 then cooldownMs = 15000 end
  if cooldownMs == 0 then cooldownMs = ${MINUTE_MS} end
  state.cooldownUntilMs = math.max(cooldownUntilMs, nowMs + cooldownMs)
elseif ok then
  state.cooldownUntilMs = 0
end
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(state))
return cjson.encode(state)
`;

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function booleanSetting(value, fallback = true) {
  if (value == null || value === '') return fallback;
  return !['0', 'false', 'off', 'no'].includes(String(value).trim().toLowerCase());
}

export function geminiHealthScoringV2Enabled() {
  return booleanSetting(process.env.GEMINI_HEALTH_SCORING_V2, true);
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
  next.successfulRequests = Math.max(0, number(next.successfulRequests));
  next.failedRequests = Math.max(0, number(next.failedRequests));
  const successfulEvents = next.events.filter((event) => event?.ok);
  const failedEvents = next.events.filter((event) => !event?.ok);
  next.lastSuccessAtMs = Math.max(0, number(
    next.lastSuccessAtMs,
    successfulEvents.length ? number(successfulEvents.at(-1)?.at) : 0
  ));
  next.lastFailureAtMs = Math.max(0, number(
    next.lastFailureAtMs,
    failedEvents.length ? number(failedEvents.at(-1)?.at) : 0
  ));
  next.lastFinishedAtMs = Math.max(0, number(next.lastFinishedAtMs));
  next.cooldownUntilMs = Math.max(0, number(next.cooldownUntilMs));
  return next;
}

function latencyHealth(current, nowMs) {
  const ewmaLatencyMs = Math.max(0, number(current.ewmaLatencyMs));
  const idleMs = current.lastFinishedAtMs > 0 ? Math.max(0, nowMs - current.lastFinishedAtMs) : Number.POSITIVE_INFINITY;
  const hasFreshObservation = ewmaLatencyMs > 0 && idleMs <= LATENCY_OBSERVATION_MAX_AGE_MS;
  const latencyFreshness = hasFreshObservation
    ? Math.pow(0.5, idleMs / LATENCY_HALF_LIFE_MS)
    : 0;
  let performanceTier = 'unknown';
  if (hasFreshObservation) {
    if (ewmaLatencyMs <= FAST_LATENCY_MS) performanceTier = 'fast';
    else if (ewmaLatencyMs <= SLOW_LATENCY_MS) performanceTier = 'normal';
    else performanceTier = 'slow';
  }
  const normalizedLatency = clamp(
    (ewmaLatencyMs - FAST_LATENCY_MS) / Math.max(1, ATTEMPT_TIMEOUT_MS - FAST_LATENCY_MS),
    0,
    1
  );
  return {
    performanceTier,
    latencyFreshness,
    latencyPressure: normalizedLatency * latencyFreshness * MAX_LATENCY_PRESSURE
  };
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
  const rpmLimited = Boolean(limits.rpm && recentStarts.length >= limits.rpm);
  const tpmLimited = Boolean(limits.tpm && recentTokens >= limits.tpm);
  const minuteLimited = rpmLimited || tpmLimited;
  const dailyLimited = Boolean(limits.rpd && current.dayRequests >= limits.rpd);
  const utilization = Math.max(rpmRatio, tpmRatio, rpdRatio);
  const quotaPressure = utilization + Math.max(0, utilization - 0.8) * 20;
  const v2Enabled = geminiHealthScoringV2Enabled();
  const latency = latencyHealth(current, nowMs);
  const unresolvedFailure = current.lastFailureAtMs > current.lastSuccessAtMs;
  const recentFailure = unresolvedFailure && current.lastFailureAtMs >= nowMs - MAX_EVENT_AGE_MS;
  const activeFailureStreak = current.consecutiveFailures >= 2
    && current.lastFailureAtMs >= nowMs - FAILURE_STREAK_WINDOW_MS;
  const degraded = v2Enabled
    ? recentFailure || activeFailureStreak
    : Math.max(0, number(current.ewmaLatencyMs) - 2_500) > 0 || failures > 0;
  const healthReason = recentFailure
    ? 'recent_failure'
    : activeFailureStreak
      ? 'consecutive_failures'
      : null;
  const failurePressure = v2Enabled
    ? (recentFailure ? Math.min(1, failures || 1) : 0) + (activeFailureStreak ? 0.5 : 0)
    : recent.length ? failures / recent.length : 0;
  const latencyPressure = v2Enabled
    ? latency.latencyPressure
    : Math.max(0, number(current.ewmaLatencyMs) - 2_500) / 7_500;
  return {
    cooldown: current.cooldownUntilMs > nowMs,
    recentRequests: recentStarts.length,
    recentTokens,
    dayRequests: current.dayRequests,
    limits,
    rpmLimited,
    tpmLimited,
    minuteLimited,
    dailyLimited,
    inFlight: current.inFlight,
    degraded,
    healthStatus: degraded ? 'degraded' : 'healthy',
    healthReason,
    performanceTier: latency.performanceTier,
    latencyFreshness: latency.latencyFreshness,
    lastSuccessAtMs: current.lastSuccessAtMs,
    lastFailureAtMs: current.lastFailureAtMs,
    value: quotaPressure + current.inFlight * 0.35 + latencyPressure + failurePressure
  };
}

export function geminiRouteScore(state, model, nowMs = Date.now()) {
  const pressure = geminiRoutePressure(state, model, nowMs);
  if (pressure.cooldown || pressure.minuteLimited || pressure.dailyLimited || pressure.inFlight > 0) return Number.POSITIVE_INFINITY;
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
