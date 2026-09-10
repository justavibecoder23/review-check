import { timingSafeEqual } from 'node:crypto';
import { getGeminiCredentialPoolStatus, saveGeminiCredentialPool } from './gemini-credential-store.mjs';
import { GEMINI_MODEL_LIMITS, geminiRouteId, geminiRoutePressure, getGeminiHealthSnapshot } from './gemini-health.mjs';

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && leftBuffer.length > 0 && timingSafeEqual(leftBuffer, rightBuffer);
}

export function assertGeminiAdmin(authorizationHeader) {
  const configured = String(process.env.GEMINI_ADMIN_KEY || process.env.APIFY_ADMIN_KEY || '');
  const supplied = String(authorizationHeader || '').replace(/^Bearer\s+/i, '');
  if (!configured || !safeEqual(supplied, configured)) {
    const error = new Error('Không có quyền quản trị cấu hình Gemini.');
    error.statusCode = 401;
    throw error;
  }
}

export function geminiAdminRouteStatus(pressure) {
  if (pressure.dailyLimited) return 'used';
  if (pressure.cooldown) return 'cooldown';
  if (pressure.minuteLimited) return 'rate_limited';
  if (pressure.inFlight > 0) return 'in_flight';
  if (pressure.degraded) return 'degraded';
  return 'healthy';
}

export function geminiAdminAvailabilityStatus(pressure) {
  if (pressure.dailyLimited) return 'used';
  if (pressure.cooldown) return 'cooldown';
  if (pressure.minuteLimited) return 'rate_limited';
  if (pressure.inFlight > 0) return 'busy';
  return 'available';
}

export function summarizeGeminiAdminRoutes(routes = []) {
  return {
    healthy: routes.filter((route) => route.healthStatus === 'healthy').length,
    degraded: routes.filter((route) => route.healthStatus === 'degraded').length,
    available: routes.filter((route) => route.availabilityStatus === 'available').length,
    fast: routes.filter((route) => route.performanceTier === 'fast').length,
    normal: routes.filter((route) => route.performanceTier === 'normal').length,
    slow: routes.filter((route) => route.performanceTier === 'slow').length,
    unknown: routes.filter((route) => route.performanceTier === 'unknown').length,
    inFlight: routes.filter((route) => route.availabilityStatus === 'busy').length,
    cooldown: routes.filter((route) => route.availabilityStatus === 'cooldown').length,
    rateLimited: routes.filter((route) => route.availabilityStatus === 'rate_limited').length,
    // Giữ hai trường cũ để dashboard/CLI hiện tại không bị vỡ.
    busy: routes.filter((route) => route.availabilityStatus === 'busy').length,
    pending: routes.filter((route) => ['cooldown', 'rate_limited'].includes(route.availabilityStatus)).length,
    used: routes.filter((route) => route.availabilityStatus === 'used').length
  };
}

function routeTimestamp(value) {
  const timestamp = Number(value) || 0;
  return timestamp > 0 ? new Date(timestamp).toISOString() : null;
}

export async function readGeminiAdminStatus(options = {}) {
  const [pool, snapshot] = await Promise.all([
    getGeminiCredentialPoolStatus(options),
    getGeminiHealthSnapshot(options)
  ]);
  const rawCredentials = [pool.active, ...(pool.backup || []), ...(pool.used || [])].filter(Boolean);
  const labelCounts = rawCredentials.reduce((counts, credential) => {
    counts.set(credential.label, (counts.get(credential.label) || 0) + 1);
    return counts;
  }, new Map());
  const credentials = rawCredentials.map((credential) => ({
    ...credential,
    displayLabel: labelCounts.get(credential.label) > 1
      ? `${credential.label} · ${String(credential.id || '').slice(0, 6)}`
      : credential.label
  }));
  const nowMs = (options.now ? new Date(options.now) : new Date()).getTime();
  const routes = credentials.flatMap((credential) => (pool.models || []).map((model) => {
    const routeId = geminiRouteId(credential.id, model);
    const state = snapshot[routeId] || {};
    const pressure = geminiRoutePressure(state, model, nowMs);
    return {
      credentialId: credential.id,
      label: credential.label,
      displayLabel: credential.displayLabel,
      model,
      status: geminiAdminRouteStatus(pressure),
      availabilityStatus: geminiAdminAvailabilityStatus(pressure),
      healthStatus: pressure.healthStatus,
      healthReason: pressure.healthReason,
      performanceTier: pressure.performanceTier,
      latencyFreshness: Number(pressure.latencyFreshness.toFixed(4)),
      recentRequests: pressure.recentRequests,
      recentTokens: pressure.recentTokens,
      dayRequests: pressure.dayRequests,
      rpmLimited: pressure.rpmLimited,
      tpmLimited: pressure.tpmLimited,
      limits: GEMINI_MODEL_LIMITS[model] || null,
      inFlight: pressure.inFlight,
      ewmaLatencyMs: Number(state.ewmaLatencyMs) || 0,
      consecutiveFailures: Number(state.consecutiveFailures) || 0,
      successfulRequests: Number(state.successfulRequests) || 0,
      failedRequests: Number(state.failedRequests) || 0,
      lastSuccessAt: routeTimestamp(pressure.lastSuccessAtMs),
      lastFailureAt: routeTimestamp(pressure.lastFailureAtMs),
      cooldownUntil: pressure.cooldown ? new Date(Number(state.cooldownUntilMs)).toISOString() : null
    };
  }));
  const routeByCredential = new Map(routes.map((route) => [route.credentialId, route]));
  const originalUsedIds = new Set((pool.used || []).map((credential) => credential.id));
  const used = credentials.filter((credential) => originalUsedIds.has(credential.id)
    || routeByCredential.get(credential.id)?.availabilityStatus === 'used').map((credential) => ({ ...credential, status: 'used' }));
  const usedIds = new Set(used.map((credential) => credential.id));
  const pendingStatuses = new Set(['cooldown', 'rate_limited']);
  const pending = credentials.filter((credential) => !usedIds.has(credential.id)
    && pendingStatuses.has(routeByCredential.get(credential.id)?.availabilityStatus)).map((credential) => ({
      ...credential,
      status: 'pending',
      pendingUntil: routeByCredential.get(credential.id)?.cooldownUntil || null
    }));
  const pendingIds = new Set(pending.map((credential) => credential.id));
  const busy = credentials.filter((credential) => !usedIds.has(credential.id) && !pendingIds.has(credential.id)
    && routeByCredential.get(credential.id)?.availabilityStatus === 'busy').map((credential) => ({
      ...credential,
      status: 'busy'
    }));
  const available = credentials.filter((credential) => routeByCredential.get(credential.id)?.availabilityStatus === 'available')
    .sort((left, right) => {
      const leftRoute = routeByCredential.get(left.id) || {};
      const rightRoute = routeByCredential.get(right.id) || {};
      return Number(leftRoute.dayRequests || 0) - Number(rightRoute.dayRequests || 0)
        || Number(leftRoute.recentRequests || 0) - Number(rightRoute.recentRequests || 0);
    });
  const normalizedPool = {
    ...pool,
    active: available[0] ? { ...available[0], status: 'active' } : null,
    backup: available.slice(1).map((credential) => ({ ...credential, status: 'backup' })),
    busy,
    pending,
    used,
    totals: {
      credentials: credentials.length,
      active: available.length ? 1 : 0,
      backup: Math.max(0, available.length - 1),
      busy: busy.length,
      pending: pending.length,
      used: used.length
    }
  };
  return {
    pool: normalizedPool,
    health: {
      routes,
      totals: summarizeGeminiAdminRoutes(routes)
    }
  };
}

export async function updateGeminiAdminPool(body, options = {}) {
  return saveGeminiCredentialPool({
    credentials: body?.credentials,
    mode: body?.mode || 'append'
  }, options);
}
