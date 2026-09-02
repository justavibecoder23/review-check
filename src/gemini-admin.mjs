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

export async function readGeminiAdminStatus(options = {}) {
  const [pool, snapshot] = await Promise.all([
    getGeminiCredentialPoolStatus(options),
    getGeminiHealthSnapshot(options)
  ]);
  const credentials = [pool.active, ...(pool.backup || []), ...(pool.used || [])].filter(Boolean);
  const nowMs = (options.now ? new Date(options.now) : new Date()).getTime();
  const routes = credentials.flatMap((credential) => (pool.models || []).map((model) => {
    const routeId = geminiRouteId(credential.id, model);
    const state = snapshot[routeId] || {};
    const pressure = geminiRoutePressure(state, model, nowMs);
    return {
      credentialId: credential.id,
      label: credential.label,
      model,
      status: pressure.dailyLimited
        ? 'used'
        : pressure.cooldown || pressure.minuteLimited
          ? 'pending'
          : pressure.value >= 1
            ? 'busy'
            : 'healthy',
      recentRequests: pressure.recentRequests,
      recentTokens: pressure.recentTokens,
      dayRequests: pressure.dayRequests,
      limits: GEMINI_MODEL_LIMITS[model] || null,
      inFlight: pressure.inFlight,
      ewmaLatencyMs: Number(state.ewmaLatencyMs) || 0,
      consecutiveFailures: Number(state.consecutiveFailures) || 0,
      cooldownUntil: pressure.cooldown ? new Date(Number(state.cooldownUntilMs)).toISOString() : null
    };
  }));
  const routeByCredential = new Map(routes.map((route) => [route.credentialId, route]));
  const originalUsedIds = new Set((pool.used || []).map((credential) => credential.id));
  const used = credentials.filter((credential) => originalUsedIds.has(credential.id)
    || routeByCredential.get(credential.id)?.status === 'used').map((credential) => ({ ...credential, status: 'used' }));
  const usedIds = new Set(used.map((credential) => credential.id));
  const pending = credentials.filter((credential) => !usedIds.has(credential.id)
    && routeByCredential.get(credential.id)?.status === 'pending').map((credential) => ({
      ...credential,
      status: 'pending',
      pendingUntil: routeByCredential.get(credential.id)?.cooldownUntil || null
    }));
  const pendingIds = new Set(pending.map((credential) => credential.id));
  const available = credentials.filter((credential) => !usedIds.has(credential.id) && !pendingIds.has(credential.id))
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
    pending,
    used,
    totals: {
      credentials: credentials.length,
      active: available.length ? 1 : 0,
      backup: Math.max(0, available.length - 1),
      pending: pending.length,
      used: used.length
    }
  };
  return {
    pool: normalizedPool,
    health: {
      routes,
      totals: {
        healthy: routes.filter((route) => route.status === 'healthy').length,
        busy: routes.filter((route) => route.status === 'busy').length,
        pending: routes.filter((route) => route.status === 'pending').length,
        used: routes.filter((route) => route.status === 'used').length
      }
    }
  };
}

export async function updateGeminiAdminPool(body, options = {}) {
  return saveGeminiCredentialPool({
    credentials: body?.credentials,
    mode: body?.mode || 'append'
  }, options);
}
