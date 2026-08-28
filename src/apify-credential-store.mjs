import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { isRedisConfigured, redisCommand, redisTransaction } from './redis-rest.mjs';

export const APIFY_POOL_KEY = 'realview:apify:credential-pool:v2';
export const APIFY_POOL_COUNTERS_KEY = 'realview:apify:credential-pool:v2:counters';
export const APIFY_POOL_USED_KEY = 'realview:apify:credential-pool:v2:used';
export const DEFAULT_MAX_USES_PER_KEY = 10;
export const APIFY_STARS = Object.freeze([5, 4, 3, 2, 1]);

// Chọn một nhóm còn hạn mức và cộng bộ đếm cho cả 5 key trong cùng một lệnh Redis.
// Nhờ vậy hai request đồng thời không thể cùng lấy lượt thứ 10 của một nhóm.
const RESERVE_POOL_SCRIPT = String.raw`
local raw = redis.call('GET', KEYS[1])
if not raw then
  return cjson.encode({ok=false, code='POOL_NOT_CONFIGURED'})
end

local pool = cjson.decode(raw)
local limit = tonumber(pool.maxUsesPerKey) or 10
local selected = nil

for _, group in ipairs(pool.groups or {}) do
  local eligible = true
  for _, credential in ipairs(group.credentials or {}) do
    local count = tonumber(redis.call('HGET', KEYS[2], credential.id) or '0')
    if count >= limit then
      eligible = false
      break
    end
  end
  if eligible and not selected then selected = group end
end

if not selected then
  return cjson.encode({ok=false, code='POOL_EXHAUSTED', maxUsesPerKey=limit})
end

local allocation = {
  ok=true,
  source='redis-vault',
  groupId=selected.id,
  groupLabel=selected.label,
  maxUsesPerKey=limit,
  credentials={}
}
local retiresAfterReservation = false

for _, credential in ipairs(selected.credentials) do
  local count = tonumber(redis.call('HINCRBY', KEYS[2], credential.id, 1))
  local allocated = {}
  for key, value in pairs(credential) do allocated[key] = value end
  allocated.usageCount = count
  table.insert(allocation.credentials, allocated)
  if count >= limit then retiresAfterReservation = true end
end

allocation.retiresAfterReservation = retiresAfterReservation
allocation.reservedAt = ARGV[1]

if retiresAfterReservation then
  for _, credential in ipairs(allocation.credentials) do
    local used = {
      id=credential.id,
      label=credential.label,
      star=credential.star,
      groupId=selected.id,
      groupLabel=selected.label,
      usageCount=credential.usageCount,
      usedAt=ARGV[1]
    }
    redis.call('HSET', KEYS[3], credential.id, cjson.encode(used))
  end
end

return cjson.encode(allocation)
`;

function vaultKey() {
  const encoded = String(process.env.APIFY_TOKEN_VAULT_KEY || '');
  if (!encoded) throw new Error('Chưa cấu hình APIFY_TOKEN_VAULT_KEY.');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('APIFY_TOKEN_VAULT_KEY phải là khóa base64 32 byte.');
  return key;
}

export function apifyCredentialId(token) {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function groupId(credentials) {
  return createHash('sha256')
    .update(credentials.map(({ star, id }) => `${star}:${id}`).join('|'))
    .digest('hex')
    .slice(0, 16);
}

function encryptToken(token) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', vaultKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };
}

function decryptToken(record) {
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
    throw new Error('Nhãn key/nhóm phải dài 2–64 ký tự và chỉ dùng chữ, số, khoảng trắng, dấu chấm, gạch ngang hoặc gạch dưới.');
  }
  return label;
}

function cleanMaxUses(value, fallback = DEFAULT_MAX_USES_PER_KEY) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error('maxUsesPerKey phải là số nguyên từ 1 đến 100.');
  }
  return parsed;
}

function normalizeInputCredentials(group, groupIndex) {
  const rawCredentials = group?.credentials || group?.keys;
  if (!Array.isArray(rawCredentials) || rawCredentials.length !== APIFY_STARS.length) {
    throw new Error(`Nhóm ${groupIndex + 1} phải có đúng 5 key, tương ứng 5★, 4★, 3★, 2★ và 1★.`);
  }
  const byStar = new Map();
  rawCredentials.forEach((item, index) => {
    const star = Number(item?.star ?? APIFY_STARS[index]);
    if (!APIFY_STARS.includes(star) || byStar.has(star)) {
      throw new Error(`Nhóm ${groupIndex + 1} có star trùng hoặc không hợp lệ.`);
    }
    const token = String(item?.token || '').trim();
    if (token.length < 16 || token.length > 500) throw new Error(`Apify token cho ${star}★ không hợp lệ.`);
    byStar.set(star, {
      token,
      id: apifyCredentialId(token),
      star,
      label: cleanLabel(item?.label, `account-${star}-star`)
    });
  });
  if (APIFY_STARS.some((star) => !byStar.has(star))) {
    throw new Error(`Nhóm ${groupIndex + 1} phải có đủ star 5, 4, 3, 2 và 1.`);
  }
  return APIFY_STARS.map((star) => byStar.get(star));
}

function buildEncryptedGroups(groups) {
  if (!Array.isArray(groups) || !groups.length || groups.length > 50) {
    throw new Error('Cần cấu hình từ 1 đến 50 nhóm Apify; mỗi nhóm có đúng 5 key.');
  }
  const seenCredentialIds = new Set();
  const seenGroupIds = new Set();
  return groups.map((group, groupIndex) => {
    const credentials = normalizeInputCredentials(group, groupIndex);
    for (const credential of credentials) {
      if (seenCredentialIds.has(credential.id)) throw new Error('Mỗi Apify token chỉ được xuất hiện một lần trong pool.');
      seenCredentialIds.add(credential.id);
    }
    const id = groupId(credentials);
    if (seenGroupIds.has(id)) throw new Error('Pool chứa nhóm Apify trùng nhau.');
    seenGroupIds.add(id);
    return {
      id,
      label: cleanLabel(group?.label, `apify-group-${groupIndex + 1}`),
      credentials: credentials.map(({ token, ...credential }) => ({ ...credential, ...encryptToken(token) }))
    };
  });
}

function parseHashReply(value) {
  if (!Array.isArray(value)) return value && typeof value === 'object' ? value : {};
  const result = {};
  for (let index = 0; index < value.length; index += 2) result[value[index]] = value[index + 1];
  return result;
}

function publicCredential(credential, counters, maxUsesPerKey) {
  const usageCount = Number(counters[credential.id]) || 0;
  return {
    id: credential.id,
    label: credential.label,
    star: Number(credential.star),
    usageCount,
    remainingUses: Math.max(0, maxUsesPerKey - usageCount),
    status: usageCount >= maxUsesPerKey ? 'used' : 'available'
  };
}

function emptyPoolStatus(provider = 'none') {
  return {
    version: 2,
    provider,
    maxUsesPerKey: DEFAULT_MAX_USES_PER_KEY,
    updatedAt: null,
    active: null,
    reserve: [],
    used: [],
    usedHistory: [],
    totals: { groups: 0, active: 0, reserve: 0, used: 0, credentials: 0 }
  };
}

function buildPoolStatus(config, counterReply, usedReply) {
  const counters = parseHashReply(counterReply);
  const maxUsesPerKey = cleanMaxUses(config.maxUsesPerKey);
  let activeAssigned = false;
  const groups = (config.groups || []).map((group) => {
    const credentialStatuses = group.credentials.map((credential) => publicCredential(credential, counters, maxUsesPerKey));
    const exhausted = credentialStatuses.some((credential) => credential.usageCount >= maxUsesPerKey);
    const status = exhausted ? 'used' : activeAssigned ? 'reserve' : 'active';
    if (status === 'active') activeAssigned = true;
    const credentials = credentialStatuses.map((credential) => ({ ...credential, status }));
    return { id: group.id, label: group.label, status, credentials };
  });
  const active = groups.find((group) => group.status === 'active') || null;
  const reserve = groups.filter((group) => group.status === 'reserve');
  const used = groups.filter((group) => group.status === 'used');
  const usedHistory = Object.values(parseHashReply(usedReply)).flatMap((value) => {
    try { return [typeof value === 'string' ? JSON.parse(value) : value]; } catch { return []; }
  }).sort((left, right) => String(right.usedAt || '').localeCompare(String(left.usedAt || '')));
  return {
    version: config.version || 2,
    provider: 'upstash-redis',
    maxUsesPerKey,
    updatedAt: config.updatedAt || null,
    active,
    reserve,
    used,
    usedHistory,
    totals: {
      groups: groups.length,
      active: active ? 1 : 0,
      reserve: reserve.length,
      used: used.length,
      credentials: groups.length * APIFY_STARS.length
    }
  };
}

async function readPoolConfig(options = {}) {
  const value = await redisCommand(['GET', APIFY_POOL_KEY], options);
  if (!value) return null;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

export async function saveApifyCredentialPool({ groups, maxUsesPerKey, mode = 'replace' }, options = {}) {
  if (!isRedisConfigured()) throw new Error('Chưa cấu hình Upstash Redis.');
  if (!['replace', 'append'].includes(mode)) throw new Error('mode chỉ nhận replace hoặc append.');
  const newGroups = buildEncryptedGroups(groups);
  const existing = mode === 'append' ? await readPoolConfig(options) : null;
  const combinedGroups = [...(existing?.groups || []), ...newGroups];
  const credentialIds = new Set();
  for (const group of combinedGroups) {
    for (const credential of group.credentials) {
      if (credentialIds.has(credential.id)) throw new Error('Token mới đã tồn tại trong pool.');
      credentialIds.add(credential.id);
    }
  }
  if (combinedGroups.length > 50) throw new Error('Pool không được vượt quá 50 nhóm.');
  const config = {
    version: 2,
    maxUsesPerKey: cleanMaxUses(maxUsesPerKey, existing?.maxUsesPerKey),
    updatedAt: new Date().toISOString(),
    groups: combinedGroups
  };
  await redisCommand(['SET', APIFY_POOL_KEY, JSON.stringify(config)], options);
  return getApifyCredentialPoolStatus(options);
}

export async function reserveApifyCredentialSet(options = {}) {
  if (!isRedisConfigured()) throw new Error('Cần cấu hình Upstash Redis để cấp phát và xoay vòng 5 Apify key an toàn.');
  if (!process.env.APIFY_TOKEN_VAULT_KEY) throw new Error('Chưa cấu hình APIFY_TOKEN_VAULT_KEY.');
  const raw = await redisCommand([
    'EVAL', RESERVE_POOL_SCRIPT, '3', APIFY_POOL_KEY, APIFY_POOL_COUNTERS_KEY, APIFY_POOL_USED_KEY,
    new Date().toISOString()
  ], options);
  const allocation = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!allocation?.ok) {
    const error = new Error(allocation?.code === 'POOL_EXHAUSTED'
      ? 'Tất cả nhóm Apify đã dùng đủ số lượt. Hãy thêm một nhóm 5 key dự phòng trong /api/apify-config.'
      : 'Chưa cấu hình pool 5 Apify key trong /api/apify-config.');
    error.statusCode = 503;
    throw error;
  }
  return {
    groupId: allocation.groupId,
    groupLabel: allocation.groupLabel,
    source: allocation.source,
    maxUsesPerKey: Number(allocation.maxUsesPerKey),
    retiresAfterReservation: Boolean(allocation.retiresAfterReservation),
    reservedAt: allocation.reservedAt,
    credentials: allocation.credentials.map((credential) => ({
      id: credential.id,
      label: credential.label,
      star: Number(credential.star),
      usageCount: Number(credential.usageCount),
      token: decryptToken(credential)
    }))
  };
}

export async function getApifyCredentialPoolStatus(options = {}) {
  if (!isRedisConfigured()) return emptyPoolStatus();
  const [configValue, counters, used] = await redisTransaction([
    ['GET', APIFY_POOL_KEY],
    ['HGETALL', APIFY_POOL_COUNTERS_KEY],
    ['HGETALL', APIFY_POOL_USED_KEY]
  ], options);
  if (!configValue) return emptyPoolStatus('upstash-redis');
  const config = typeof configValue === 'string' ? JSON.parse(configValue) : configValue;
  return buildPoolStatus(config, counters, used);
}
