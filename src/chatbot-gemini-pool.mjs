import { timingSafeEqual } from 'node:crypto';
import { redisCommand } from './redis-rest.mjs';
import {
  getGeminiCredentialPoolStatus,
  listAvailableGeminiCredentials,
  markGeminiModelExhausted,
  saveGeminiCredentialPool,
  geminiCredentialId,
  nextPacificResetAt
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

export async function getChatbotGeminiHealthSnapshot(options = {}) {
  const snapshot = await getGeminiHealthSnapshot({ ...options, healthKey: CHATBOT_GEMINI_HEALTH_KEY });
  // Honor pre-fix permission failures too, rather than retrying after the old cooldown.
  for (const state of Object.values(snapshot)) {
    if ([401,403].includes(Number(state.lastStatusCode))) {
      state.permissionDisabled = true;
      state.permissionReason ||= 'permission_denied';
    }
  }
  return snapshot;
}

export function beginChatbotGeminiRoute(routeId, options = {}) {
  return beginGeminiRoute(routeId, { ...options, healthKey: CHATBOT_GEMINI_HEALTH_KEY, honorPermissionDisabled: true });
}

export function finishChatbotGeminiRoute(routeId, result, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const quotaCooldown = result?.errorType === 'daily-quota'
    ? Date.parse(nextPacificResetAt(new Date(nowMs)))
    : Number(result?.statusCode) === 429 ? nowMs + Math.max(60_000,Number(result.retryAfterMs) || 0) : 0;
  return finishGeminiRoute(routeId, {...result,minCooldownUntilMs:quotaCooldown}, { ...options, healthKey: CHATBOT_GEMINI_HEALTH_KEY, honorPermissionDisabled: true });
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
  const primaryKey = String(process.env.CHATBOT_GEMINI_API_KEY || '').trim();
  const primaryId = primaryKey ? geminiCredentialId(primaryKey) : null;
  if (primaryId && !credentials.some(credential => credential.id === primaryId)) credentials.unshift({id:primaryId,label:'Dedicated chatbot key'});
  const routes = credentials.flatMap((credential) => (pool.models?.length ? pool.models : Object.keys(GEMINI_MODEL_LIMITS)).map((model) => {
    const routeId = geminiRouteId(credential.id, model);
    const state = snapshot[routeId] || {};
    const pressure = geminiRoutePressure(state, model, Date.now());
    return {
      credentialId: credential.id,
      label: credential.label,
      model,
      status: state.permissionDisabled === true ? 'permission_disabled' : availability(pressure),
      permissionReason: state.permissionDisabled === true ? state.permissionReason || 'permission_denied' : null,
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
        used: routes.filter((route) => route.status === 'used').length,
        permissionDisabled: routes.filter((route) => route.status === 'permission_disabled').length
      }
    }
  };
}

const RESTORE_PERMISSION_SCRIPT = String.raw`
-- CHATBOT_PERMISSION_RESTORE
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return cjson.encode({ok=false, code='NOT_FOUND'}) end
local state = cjson.decode(raw)
if tonumber(state.inFlight or 0) > 0 then return cjson.encode({ok=false, code='BUSY'}) end
state.permissionDisabled = nil
state.permissionReason = nil
state.permissionDisabledAt = nil
if tonumber(state.lastStatusCode) == 401 or tonumber(state.lastStatusCode) == 403 then
  state.lastStatusCode = cjson.null
  state.lastError = cjson.null
end
state.permissionRestoredAt = ARGV[2]
-- Do not erase dayRequests, quota reservations, cooldown or usage records.
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(state))
return cjson.encode({ok=true})
`;

export async function updateChatbotGeminiAdminPool(body, options = {}) {
  // The API authenticates admin before entering this function. Importing keys
  // never unblocks permission failures. Only an explicit verified recovery does.
  if (body?.action === 'restore-permission') {
    const status = await readChatbotGeminiAdminStatus(options);
    const route = status.health.routes.find(item => item.credentialId === body.credentialId && item.model === body.model);
    if (body.confirmedProviderAccess !== true || !route || route.status !== 'permission_disabled') {
      throw Object.assign(new Error('Cần xác nhận quyền Google đã được khôi phục cho đúng route chatbot.'),{statusCode:400});
    }
    const raw = await redisCommand(['EVAL',RESTORE_PERMISSION_SCRIPT,'1',CHATBOT_GEMINI_HEALTH_KEY,
      geminiRouteId(route.credentialId,route.model),new Date().toISOString()],options);
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!result?.ok) throw Object.assign(new Error('Route chưa thể mở lại; kiểm tra request đang chạy.'),{statusCode:409});
    return {permissionRestored:true,credentialId:route.credentialId,model:route.model};
  }
  return saveGeminiCredentialPool({
    credentials: body?.credentials,
    mode: body?.mode || 'append'
  }, withStoreOptions(options));
}
