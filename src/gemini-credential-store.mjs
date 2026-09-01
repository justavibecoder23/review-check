import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { isRedisConfigured, redisCommand, redisTransaction } from './redis-rest.mjs';

export const GEMINI_POOL_KEY = 'realview:gemini:credential-pool:v1';
export const GEMINI_POOL_STATES_KEY = 'realview:gemini:credential-pool:v1:states';
export const DEFAULT_GEMINI_MODELS = Object.freeze([
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-3.5-flash-lite'
]);

const RESERVE_GEMINI_CREDENTIAL_SCRIPT = String.raw`
-- GEMINI_CREDENTIAL_RESERVATION
local raw = redis.call('GET', KEYS[1])
if not raw then return cjson.encode({ok=false, code='POOL_NOT_CONFIGURED'}) end
local pool = cjson.decode(raw)
local nowMs = tonumber(ARGV[1]) or 0
local excluded = {}
if ARGV[3] and ARGV[3] ~= '' then
  for _, id in ipairs(cjson.decode(ARGV[3])) do excluded[id] = true end
end

for _, credential in ipairs(pool.credentials or {}) do
  if not excluded[credential.id] then
  local stateRaw = redis.call('HGET', KEYS[2], credential.id)
  local state = stateRaw and cjson.decode(stateRaw) or nil
  if state and tonumber(state.resetAtMs or 0) <= nowMs then
    redis.call('HDEL', KEYS[2], credential.id)
    state = nil
  end
  local exhausted = state and state.models or {}
  local exhaustedCount = 0
  for _, model in ipairs(pool.models or {}) do
    if exhausted[model] then exhaustedCount = exhaustedCount + 1 end
  end
  if exhaustedCount < #(pool.models or {}) then
    return cjson.encode({
      ok=true,
      source='redis-vault',
      credential=credential,
      exhaustedModels=exhausted,
      models=pool.models or {},
      resetAt=state and state.resetAt or ARGV[2]
    })
  end
  end
end

if next(excluded) then
  return cjson.encode({ok=false, code='POOL_RETRY_EXHAUSTED', resetAt=ARGV[2]})
end
return cjson.encode({ok=false, code='POOL_EXHAUSTED', resetAt=ARGV[2]})
`;

const MARK_GEMINI_MODEL_EXHAUSTED_SCRIPT = String.raw`
-- GEMINI_MODEL_EXHAUSTION
local raw = redis.call('GET', KEYS[1])
if not raw then return cjson.encode({ok=false, code='POOL_NOT_CONFIGURED'}) end
local pool = cjson.decode(raw)
local credentialId = ARGV[1]
local model = ARGV[2]
local nowIso = ARGV[3]
local nowMs = tonumber(ARGV[4]) or 0
local resetAt = ARGV[5]
local resetAtMs = tonumber(ARGV[6]) or 0
local stateRaw = redis.call('HGET', KEYS[2], credentialId)
local state = stateRaw and cjson.decode(stateRaw) or nil

if not state or tonumber(state.resetAtMs or 0) <= nowMs then
  state = {id=credentialId, models={}, resetAt=resetAt, resetAtMs=resetAtMs}
end
state.models[model] = nowIso
state.updatedAt = nowIso
state.resetAt = resetAt
state.resetAtMs = resetAtMs

local exhaustedCount = 0
for _, requiredModel in ipairs(pool.models or {}) do
  if state.models[requiredModel] then exhaustedCount = exhaustedCount + 1 end
end
state.exhaustedCount = exhaustedCount
state.used = exhaustedCount >= #(pool.models or {})
if state.used and not state.usedAt then state.usedAt = nowIso end
redis.call('HSET', KEYS[2], credentialId, cjson.encode(state))
return cjson.encode({ok=true, exhaustedCount=exhaustedCount, used=state.used, resetAt=resetAt})
`;

function vaultKey() {
  const encoded = String(process.env.GEMINI_API_KEY_VAULT_KEY || '');
  if (!encoded) throw new Error('Chưa cấu hình GEMINI_API_KEY_VAULT_KEY.');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('GEMINI_API_KEY_VAULT_KEY phải là khóa base64 32 byte.');
  return key;
}

export function geminiCredentialId(apiKey) {
  return createHash('sha256').update(String(apiKey)).digest('hex').slice(0, 16);
}

function encryptApiKey(apiKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', vaultKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };
}

function decryptApiKey(record) {
  const decipher = createDecipheriv('aes-256-gcm', vaultKey(), Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

function cleanLabel(value, fallback) {
  const label = String(value || fallback || '').trim();
  if (!/^[\p{L}\p{N}_. -]{2,64}$/u.test(label)) {
    throw new Error('Nhãn Gemini key phải dài 2–64 ký tự và chỉ dùng chữ, số, khoảng trắng, dấu chấm, gạch ngang hoặc gạch dưới.');
  }
  return label;
}

function normalizeCredentials(credentials) {
  if (!Array.isArray(credentials) || !credentials.length || credentials.length > 200) {
    throw new Error('Pool Gemini phải có từ 1 đến 200 API key.');
  }
  const seen = new Set();
  return credentials.map((item, index) => {
    const apiKey = String(typeof item === 'string' ? item : item?.apiKey || item?.key || item?.token || '').trim();
    if (apiKey.length < 16 || apiKey.length > 500) throw new Error(`Gemini API key ${index + 1} không hợp lệ.`);
    const id = geminiCredentialId(apiKey);
    if (seen.has(id)) throw new Error('Danh sách chứa Gemini API key bị trùng.');
    seen.add(id);
    return {
      id,
      label: cleanLabel(typeof item === 'string' ? null : item?.label, `gemini-key-${String(index + 1).padStart(2, '0')}`),
      apiKey
    };
  });
}

function parseHashReply(value) {
  if (!Array.isArray(value)) return value && typeof value === 'object' ? value : {};
  const result = {};
  for (let index = 0; index < value.length; index += 2) result[value[index]] = value[index + 1];
  return result;
}

function parseState(value) {
  if (!value) return null;
  try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; }
}

function pacificDateKey(value) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(value);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

export function nextPacificResetAt(value = new Date()) {
  const now = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(now.getTime())) throw new Error('Thời gian reset Gemini không hợp lệ.');
  const currentDay = pacificDateKey(now);
  let low = now.getTime();
  let high = low + 30 * 60 * 60 * 1000;
  while (high - low > 1_000) {
    const middle = Math.floor((low + high) / 2);
    if (pacificDateKey(new Date(middle)) === currentDay) low = middle;
    else high = middle;
  }
  return new Date(Math.round(high / 60_000) * 60_000).toISOString();
}

async function readConfig(options = {}) {
  const raw = await redisCommand(['GET', GEMINI_POOL_KEY], options);
  return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
}

export async function saveGeminiCredentialPool({ credentials = [], mode = 'replace' }, options = {}) {
  if (!isRedisConfigured()) throw new Error('Chưa cấu hình Upstash Redis.');
  if (!['replace', 'append'].includes(mode)) throw new Error('mode chỉ nhận replace hoặc append.');
  const incoming = normalizeCredentials(credentials);
  const existing = mode === 'append' ? await readConfig(options) : null;
  const existingIds = new Set((existing?.credentials || []).map((credential) => credential.id));
  if (incoming.some((credential) => existingIds.has(credential.id))) {
    throw new Error('Có Gemini API key đã tồn tại trong pool.');
  }
  const encryptedIncoming = incoming.map(({ apiKey, ...credential }) => ({ ...credential, ...encryptApiKey(apiKey) }));
  const combined = [...(existing?.credentials || []), ...encryptedIncoming];
  if (combined.length > 200) throw new Error('Pool Gemini không được vượt quá 200 API key.');
  const config = {
    version: 1,
    updatedAt: new Date().toISOString(),
    timeZone: 'America/Los_Angeles',
    models: [...DEFAULT_GEMINI_MODELS],
    credentials: combined
  };
  await redisCommand(['SET', GEMINI_POOL_KEY, JSON.stringify(config)], options);
  return getGeminiCredentialPoolStatus(options);
}

export async function reserveGeminiCredential(options = {}) {
  if (!isRedisConfigured()) {
    const error = new Error('Chưa cấu hình Upstash Redis cho Gemini pool.');
    error.code = 'POOL_NOT_CONFIGURED';
    throw error;
  }
  const now = options.now ? new Date(options.now) : new Date();
  const resetAt = nextPacificResetAt(now);
  const excludedIds = [...new Set((options.excludeCredentialIds || []).map(String).filter(Boolean))];
  const raw = await redisCommand([
    'EVAL', RESERVE_GEMINI_CREDENTIAL_SCRIPT, '2', GEMINI_POOL_KEY, GEMINI_POOL_STATES_KEY,
    String(now.getTime()), resetAt, JSON.stringify(excludedIds)
  ], options);
  const allocation = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!allocation?.ok) {
    const error = new Error(allocation?.code === 'POOL_EXHAUSTED'
      ? `Tất cả Gemini API key đã dùng hết quota ngày. Pool sẽ tự mở lại sau ${allocation.resetAt || resetAt}.`
      : allocation?.code === 'POOL_RETRY_EXHAUSTED'
        ? 'Không còn Gemini API key dự phòng khác để retry.'
        : 'Chưa cấu hình Gemini API key pool.');
    error.code = allocation?.code || 'POOL_NOT_CONFIGURED';
    error.statusCode = allocation?.code === 'POOL_EXHAUSTED' ? 429 : 503;
    error.resetAt = allocation?.resetAt || resetAt;
    throw error;
  }
  return {
    source: allocation.source,
    id: allocation.credential.id,
    label: allocation.credential.label,
    apiKey: decryptApiKey(allocation.credential),
    models: Array.isArray(allocation.models) ? allocation.models : [...DEFAULT_GEMINI_MODELS],
    exhaustedModels: Object.keys(allocation.exhaustedModels || {}),
    resetAt: allocation.resetAt || resetAt
  };
}

export async function markGeminiModelExhausted(credential, model, options = {}) {
  if (!credential?.id) throw new Error('Thiếu mã Gemini API key cần cập nhật.');
  if (!DEFAULT_GEMINI_MODELS.includes(model)) throw new Error('Model Gemini không thuộc chuỗi quota được quản lý.');
  const now = options.now ? new Date(options.now) : new Date();
  const resetAt = nextPacificResetAt(now);
  const raw = await redisCommand([
    'EVAL', MARK_GEMINI_MODEL_EXHAUSTED_SCRIPT, '2', GEMINI_POOL_KEY, GEMINI_POOL_STATES_KEY,
    credential.id, model, now.toISOString(), String(now.getTime()), resetAt, String(new Date(resetAt).getTime())
  ], options);
  const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!result?.ok) throw new Error('Không cập nhật được quota Gemini trên Redis.');
  return {
    used: Boolean(result.used),
    exhaustedCount: Number(result.exhaustedCount) || 0,
    resetAt: result.resetAt || resetAt
  };
}

export async function getGeminiCredentialPoolStatus(options = {}) {
  if (!isRedisConfigured()) {
    return { version: 1, provider: 'none', models: [...DEFAULT_GEMINI_MODELS], active: null, backup: [], used: [], totals: { credentials: 0, active: 0, backup: 0, used: 0 } };
  }
  const [configRaw, statesRaw] = await redisTransaction([
    ['GET', GEMINI_POOL_KEY],
    ['HGETALL', GEMINI_POOL_STATES_KEY]
  ], options);
  if (!configRaw) {
    return { version: 1, provider: 'upstash-redis', models: [...DEFAULT_GEMINI_MODELS], active: null, backup: [], used: [], totals: { credentials: 0, active: 0, backup: 0, used: 0 } };
  }
  const config = typeof configRaw === 'string' ? JSON.parse(configRaw) : configRaw;
  const states = parseHashReply(statesRaw);
  const nowMs = (options.now ? new Date(options.now) : new Date()).getTime();
  const publicCredentials = (config.credentials || []).map(({ id, label }) => {
    const state = parseState(states[id]);
    const validState = state && Number(state.resetAtMs || 0) > nowMs ? state : null;
    const exhaustedModels = Object.keys(validState?.models || {}).filter((model) => config.models.includes(model));
    return {
      id,
      label,
      exhaustedModels,
      remainingModels: config.models.filter((model) => !exhaustedModels.includes(model)),
      status: exhaustedModels.length >= config.models.length ? 'used' : 'available',
      resetAt: validState?.resetAt || nextPacificResetAt(new Date(nowMs))
    };
  });
  let activeAssigned = false;
  const available = publicCredentials.filter((credential) => credential.status === 'available').map((credential) => {
    if (!activeAssigned) {
      activeAssigned = true;
      return { ...credential, status: 'active' };
    }
    return { ...credential, status: 'backup' };
  });
  const used = publicCredentials.filter((credential) => credential.status === 'used');
  return {
    version: config.version || 1,
    provider: 'upstash-redis',
    updatedAt: config.updatedAt || null,
    timeZone: config.timeZone || 'America/Los_Angeles',
    models: config.models || [...DEFAULT_GEMINI_MODELS],
    resetAt: nextPacificResetAt(new Date(nowMs)),
    active: available.find((credential) => credential.status === 'active') || null,
    backup: available.filter((credential) => credential.status === 'backup'),
    used,
    totals: {
      credentials: publicCredentials.length,
      active: activeAssigned ? 1 : 0,
      backup: Math.max(0, available.length - 1),
      used: used.length
    }
  };
}
