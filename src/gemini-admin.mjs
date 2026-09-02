import { timingSafeEqual } from 'node:crypto';
import { getGeminiCredentialPoolStatus, saveGeminiCredentialPool } from './gemini-credential-store.mjs';
import { geminiRouteId, geminiRoutePressure, getGeminiHealthSnapshot } from './gemini-health.mjs';

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
      status: pressure.cooldown ? 'cooldown' : pressure.value >= 1 ? 'busy' : 'healthy',
      recentRequests: pressure.recentRequests,
      dayRequests: pressure.dayRequests,
      inFlight: pressure.inFlight,
      ewmaLatencyMs: Number(state.ewmaLatencyMs) || 0,
      consecutiveFailures: Number(state.consecutiveFailures) || 0,
      cooldownUntil: pressure.cooldown ? new Date(Number(state.cooldownUntilMs)).toISOString() : null
    };
  }));
  return {
    pool,
    health: {
      routes,
      totals: {
        healthy: routes.filter((route) => route.status === 'healthy').length,
        busy: routes.filter((route) => route.status === 'busy').length,
        cooldown: routes.filter((route) => route.status === 'cooldown').length
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
