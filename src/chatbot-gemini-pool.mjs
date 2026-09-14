import { timingSafeEqual } from 'node:crypto';
import {
  getGeminiCredentialPoolStatus,
  listAvailableGeminiCredentials,
  markGeminiModelExhausted,
  saveGeminiCredentialPool
} from './gemini-credential-store.mjs';
import {
  beginGeminiRoute,
  GEMINI_MODEL_LIMITS,
  geminiRouteId,
  geminiRoutePressure,
  getGeminiHealthSnapshot,
  finishGeminiRoute
} from './gemini-health.mjs';

export const CHATBOT_GEMINI_POOL_KEY = 'realview:gemini:chatbot:credential-pool:v1';
export const CHATBOT_GEMINI_POOL_STATES_KEY = 'realview:gemini:chatbot:credential-pool:v1:states';
export const CHATBOT_GEMINI_HEALTH_KEY = 'realview:gemini:chatbot:route-health:v1';
const storeOptions = Object.freeze({
  poolKey: CHATBOT_GEMINI_POOL_KEY,
  statesKey: CHATBOT_GEMINI_POOL_STATES_KEY,
  vaultKeyEnv: 'CHATBOT_GEMINI_API_KEY_VAULT_KEY'
});

function withStoreOptions(options = {}) {
  return { ...options, ...storeOptions };
}

export function listAvailableChatbotGeminiCredentials(options = {}) {
  return listAvailableGeminiCredentials(withStoreOptions(options));
}

export function markChatbotGeminiModelExhausted(credential, model, options = {}) {
  return markGeminiModelExhausted(credential, model, withStoreOptions(options));
}

export function getChatbotGeminiHealthSnapshot(options = {}) {
  return getGeminiHealthSnapshot({ ...options, healthKey: CHATBOT_GEMINI_HEALTH_KEY });
}

export function beginChatbotGeminiRoute(routeId, options = {}) {
  return beginGeminiRoute(routeId, { ...options, healthKey: CHATBOT_GEMINI_HEALTH_KEY });
}

export function finishChatbotGeminiRoute(routeId, result, options = {}) {
  return finishGeminiRoute(routeId, result, { ...options, healthKey: CHATBOT_GEMINI_HEALTH_KEY });
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length > 0
    && leftBuffer.length === rightBuffer.length
    && timingSafeEqual(leftBuffer, rightBuffer);
}

export function assertChatbotGeminiAdmin(authorizationHeader) {
  const configured = String(
    process.env.CHATBOT_GEMINI_ADMIN_KEY
    || process.env.GEMINI_ADMIN_KEY
    || process.env.APIFY_ADMIN_KEY
    || ''
  );
  const supplied = String(authorizationHeader || '').replace(/^Bearer\s+/i, '');
  if (!configured || !safeEqual(supplied, configured)) {
    const error = new Error('Không có quyền quản trị Gemini pool của chatbot.');
    error.statusCode = 401;
    throw error;
  }
}

function availability(pressure) {
  if (pressure.dailyLimited) return 'used';
  if (pressure.cooldown) return 'cooldown';
  if (pressure.minuteLimited) return 'rate_limited';
  if (pressure.inFlight > 0) return 'busy';
  return 'available';
}

export async function readChatbotGeminiAdminStatus(options = {}) {
  const [pool, snapshot] = await Promise.all([
    getGeminiCredentialPoolStatus(withStoreOptions(options)),
    getChatbotGeminiHealthSnapshot(options)
  ]);
  const credentials = [pool.active, ...(pool.backup || []), ...(pool.used || [])].filter(Boolean);
  const routes = credentials.flatMap((credential) => (pool.models || []).map((model) => {
    const routeId = geminiRouteId(credential.id, model);
    const state = snapshot[routeId] || {};
    const pressure = geminiRoutePressure(state, model, Date.now());
    return {
      credentialId: credential.id,
      label: credential.label,
      model,
      status: availability(pressure),
      health: pressure.healthStatus,
      performanceTier: pressure.performanceTier,
      inFlight: pressure.inFlight,
      recentRequests: pressure.recentRequests,
      dayRequests: pressure.dayRequests,
      ewmaLatencyMs: Number(state.ewmaLatencyMs) || 0,
      consecutiveFailures: Number(state.consecutiveFailures) || 0,
      limits: GEMINI_MODEL_LIMITS[model] || null
    };
  }));
  return {
    pool,
    health: {
      routes,
      totals: {
        healthy: routes.filter((route) => route.health === 'healthy').length,
        degraded: routes.filter((route) => route.health === 'degraded').length,
        available: routes.filter((route) => route.status === 'available').length,
        busy: routes.filter((route) => route.status === 'busy').length,
        pending: routes.filter((route) => ['cooldown', 'rate_limited'].includes(route.status)).length,
        used: routes.filter((route) => route.status === 'used').length
      }
    }
  };
}

export function updateChatbotGeminiAdminPool(body, options = {}) {
  return saveGeminiCredentialPool({
    credentials: body?.credentials,
    mode: body?.mode || 'append'
  }, withStoreOptions(options));
}
