import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { isRedisConfigured, redisCommand, redisTransaction } from './redis-rest.mjs';

export const APIFY_POOL_KEY = 'realview:apify:credential-pool:v2';
export const APIFY_POOL_COUNTERS_KEY = 'realview:apify:credential-pool:v2:counters';
export const APIFY_POOL_USED_KEY = 'realview:apify:credential-pool:v2:used';
export const APIFY_TIKTOK_RUN_COUNTERS_KEY = 'realview:apify:credential-pool:v2:tiktok:runs';
export const APIFY_TIKTOK_REVIEW_COUNTERS_KEY = 'realview:apify:credential-pool:v2:tiktok:reviews';
export const APIFY_TIKTOK_RESERVED_REVIEWS_KEY = 'realview:apify:credential-pool:v2:tiktok:reserved';
export const APIFY_TIKTOK_USED_KEY = 'realview:apify:credential-pool:v2:tiktok:used';
export const APIFY_TIKTOK_FINALIZED_RESERVATIONS_KEY = 'realview:apify:credential-pool:v2:tiktok:finalized';
export const DEFAULT_MAX_USES_PER_KEY = 10;
export const APIFY_STARS = Object.freeze([5, 4, 3, 2, 1]);
export const APIFY_FREE_USAGE_MICRO_USD = 5_000_000;
export const SHOPEE_USAGE_MICRO_USD_PER_REVIEW = 3_990;
export const TIKTOK_USAGE_MICRO_USD_PER_REVIEW = 400;
export const SHOPEE_MAX_REVIEWS_PER_RUN = 20;

// TikTok được tính theo số review, không dùng chung bộ đếm lượt của Shopee.
// Việc giữ một hash reservation riêng ngăn hai request đồng thời cùng tiêu
// quá ngân sách review còn lại của một token.
const RESERVE_TIKTOK_CREDENTIALS_SCRIPT = String.raw`
-- TIKTOK_CREDENTIAL_RESERVATION
local raw = redis.call('GET', KEYS[1])
if not raw then return cjson.encode({ok=false, code='POOL_NOT_CONFIGURED'}) end
local pool = cjson.decode(raw)
local desired = tonumber(ARGV[1]) or 1
local requestedPerKey = tonumber(ARGV[2]) or 1
local maxReviews = tonumber(ARGV[3]) or 6200
local nowMs = tonumber(ARGV[5]) or 0
local freeUsage = tonumber(ARGV[6]) or 5000000
local shopeeCostPerReview = tonumber(ARGV[7]) or 3990
local tiktokCostPerReview = tonumber(ARGV[8]) or 400
local shopeeMaxUses = tonumber(ARGV[9]) or 10
local shopeeReviewsPerRun = tonumber(ARGV[10]) or 20
local leaseMs = tonumber(ARGV[11]) or 180000
local selected = {}

local function readReservationState(credentialId)
  local state = {leases={}}
  local rawReserved = redis.call('HGET', KEYS[4], credentialId)
  if rawReserved then
    local decodedOk, decoded = pcall(cjson.decode, rawReserved)
    if decodedOk and type(decoded) == 'table' and type(decoded.leases) == 'table' then
      state = decoded
    else
      local legacyAmount = math.max(0, tonumber(rawReserved) or 0)
      if legacyAmount > 0 then
        state.leases.legacy = {amount=legacyAmount, expiresAtMs=nowMs + leaseMs}
      end
    end
  end
  local reserved = 0
  for reservationId, lease in pairs(state.leases) do
    if tonumber(lease.expiresAtMs or 0) <= nowMs then
      state.leases[reservationId] = nil
    else
      reserved = reserved + math.max(0, tonumber(lease.amount) or 0)
    end
  end
  redis.call('HSET', KEYS[4], credentialId, cjson.encode(state))
  return state, reserved
end

for _, group in ipairs(pool.groups or {}) do
  for _, credential in ipairs(group.credentials or {}) do
    local reviews = tonumber(redis.call('HGET', KEYS[3], credential.id) or '0')
    local reservationState, reserved = readReservationState(credential.id)
    local shopeeUses = math.min(shopeeMaxUses, math.max(0, tonumber(redis.call('HGET', KEYS[5], credential.id) or '0')))
    local shopeeSpent = shopeeUses * shopeeReviewsPerRun * shopeeCostPerReview
    local shopeeReserved = math.max(0, shopeeMaxUses - shopeeUses) * shopeeReviewsPerRun * shopeeCostPerReview
    local usageRemaining = math.max(0, freeUsage - shopeeSpent - shopeeReserved - (reviews + reserved) * tiktokCostPerReview)
    local usageReviewCapacity = math.floor(usageRemaining / tiktokCostPerReview)
    local remaining = math.min(maxReviews - reviews - reserved, usageReviewCapacity)
    if remaining > 0 and #selected < desired then
      table.insert(selected, {
        credential=credential,
        groupId=group.id,
        groupLabel=group.label,
        reviews=reviews,
        reserved=reserved,
        planned=math.min(requestedPerKey, remaining),
        shopeeUses=shopeeUses,
        shopeeReservedUsage=shopeeReserved,
        usageRemaining=usageRemaining,
        reservationState=reservationState
      })
    end
  end
end

if #selected < desired then
  return cjson.encode({ok=false, code='INSUFFICIENT_KEYS', available=#selected, requested=desired})
end

local allocation = {ok=true, source='redis-vault', maxReviewsPerKey=maxReviews, credentials={}, reservedAt=ARGV[4]}
for _, candidate in ipairs(selected) do
  local runCount = tonumber(redis.call('HINCRBY', KEYS[2], candidate.credential.id, 1))
  local reservationId = candidate.credential.id .. ':' .. tostring(runCount) .. ':' .. tostring(nowMs)
  local expiresAtMs = nowMs + leaseMs
  candidate.reservationState.leases[reservationId] = {amount=candidate.planned, expiresAtMs=expiresAtMs}
  redis.call('HSET', KEYS[4], candidate.credential.id, cjson.encode(candidate.reservationState))
  local reservedAfter = candidate.reserved + candidate.planned
  local allocated = {}
  for key, value in pairs(candidate.credential) do allocated[key] = value end
  allocated.groupId = candidate.groupId
  allocated.groupLabel = candidate.groupLabel
  allocated.runCount = runCount
  allocated.reviewCount = candidate.reviews
  allocated.plannedReviews = candidate.planned
  allocated.reservedReviews = reservedAfter
  allocated.shopeeUses = candidate.shopeeUses
  allocated.shopeeReservedUsageMicroUsd = candidate.shopeeReservedUsage
  allocated.usageRemainingMicroUsd = candidate.usageRemaining - candidate.planned * tiktokCostPerReview
  allocated.reservationId = reservationId
  allocated.reservationExpiresAtMs = expiresAtMs
  table.insert(allocation.credentials, allocated)
end
return cjson.encode(allocation)
`;

const FINALIZE_TIKTOK_CREDENTIAL_SCRIPT = String.raw`
-- TIKTOK_CREDENTIAL_FINALIZATION
local planned = tonumber(ARGV[1]) or 0
local actual = tonumber(ARGV[2]) or 0
local maxReviews = tonumber(ARGV[3]) or 6200
local exhausted = ARGV[4] == '1'
local reservationId = ARGV[8]
local nowMs = tonumber(ARGV[9]) or 0
-- Giữ cửa sổ idempotency 24 giờ và tự dọn dữ liệu cũ để key Redis không tăng vô hạn.
redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', nowMs - 86400000)
if reservationId and reservationId ~= '' and redis.call('ZSCORE', KEYS[4], reservationId) then
  local currentReviews = tonumber(redis.call('HGET', KEYS[1], ARGV[5]) or '0')
  return cjson.encode({ok=true, reviewCount=currentReviews, exhausted=(currentReviews >= maxReviews), alreadyFinalized=true})
end
local state = {leases={}}
local rawReserved = redis.call('HGET', KEYS[2], ARGV[5])
if rawReserved then
  local decodedOk, decoded = pcall(cjson.decode, rawReserved)
  if decodedOk and type(decoded) == 'table' and type(decoded.leases) == 'table' then state = decoded end
end
if reservationId and reservationId ~= '' then state.leases[reservationId] = nil end
for id, lease in pairs(state.leases) do
  if tonumber(lease.expiresAtMs or 0) <= nowMs then state.leases[id] = nil end
end
redis.call('HSET', KEYS[2], ARGV[5], cjson.encode(state))
local reviewCount = tonumber(redis.call('HINCRBY', KEYS[1], ARGV[5], actual))
if exhausted and reviewCount < maxReviews then
  reviewCount = maxReviews
  redis.call('HSET', KEYS[1], ARGV[5], reviewCount)
end
if reviewCount >= maxReviews then
  redis.call('HSET', KEYS[3], ARGV[5], cjson.encode({
    id=ARGV[5], label=ARGV[6], reviewCount=reviewCount,
    maxReviewsPerKey=maxReviews, usedAt=ARGV[7]
  }))
end
if reservationId and reservationId ~= '' then redis.call('ZADD', KEYS[4], nowMs, reservationId) end
return cjson.encode({ok=true, reviewCount=reviewCount, exhausted=(reviewCount >= maxReviews), alreadyFinalized=false})
`;

// Chọn số key còn hạn mức theo yêu cầu và cộng bộ đếm trong cùng một lệnh Redis.
// Ưu tiên mọi key còn lượt trong nhóm active; nếu nhóm thiếu key thì bù bằng
// key ít được dùng nhất từ các nhóm reserve. Pool gốc không bị gom nhóm lại,
// nên active/reserve/pending và lịch sử bộ đếm vẫn được giữ nguyên.
const RESERVE_POOL_SCRIPT = String.raw`
local raw = redis.call('GET', KEYS[1])
if not raw then
  return cjson.encode({ok=false, code='POOL_NOT_CONFIGURED'})
end

local pool = cjson.decode(raw)
local limit = tonumber(pool.maxUsesPerKey) or 10
local desired = tonumber(ARGV[2]) or 5
local stars = cjson.decode(ARGV[3] or '[5,4,3,2,1]')
local selected = {}
local candidates = {}
local activeGroupIndex = nil
local order = 0

for groupIndex, group in ipairs(pool.groups or {}) do
  for _, credential in ipairs(group.credentials or {}) do
    order = order + 1
    local count = tonumber(redis.call('HGET', KEYS[2], credential.id) or '0')
    if count < limit then
      if not activeGroupIndex then activeGroupIndex = groupIndex end
      table.insert(candidates, {
        credential=credential,
        count=count,
        order=order,
        groupIndex=groupIndex,
        groupId=group.id,
        groupLabel=group.label
      })
    end
  end
end

table.sort(candidates, function(left, right)
  if left.groupIndex ~= right.groupIndex then return left.groupIndex < right.groupIndex end
  if left.count == right.count then return left.order < right.order end
  return left.count < right.count
end)

for _, candidate in ipairs(candidates) do
  if #selected >= desired then break end
  table.insert(selected, candidate)
end

if #selected < desired or #stars ~= desired then
  return cjson.encode({ok=false, code='POOL_EXHAUSTED', maxUsesPerKey=limit})
end

local mixedGroups = false
for index = 2, #selected do
  if selected[index].groupId ~= selected[1].groupId then mixedGroups = true end
end
local allocationGroupId = mixedGroups and 'mixed-available-keys' or selected[1].groupId
local allocationGroupLabel = mixedGroups and 'mixed-available-keys' or selected[1].groupLabel
local allocation = {
  ok=true,
  source='redis-vault',
  groupId=allocationGroupId,
  groupLabel=allocationGroupLabel,
  maxUsesPerKey=limit,
  credentials={}
}
local retiresAfterReservation = false

for index, candidate in ipairs(selected) do
  local credential = candidate.credential
  local count = tonumber(redis.call('HINCRBY', KEYS[2], credential.id, 1))
  local allocated = {}
  for key, value in pairs(credential) do allocated[key] = value end
  allocated.poolStar = credential.star
  allocated.star = stars[index]
  allocated.poolGroupId = candidate.groupId
  allocated.poolGroupLabel = candidate.groupLabel
  allocated.usageCount = count
  table.insert(allocation.credentials, allocated)
  if count >= limit then retiresAfterReservation = true end
end

allocation.retiresAfterReservation = retiresAfterReservation
allocation.reservedAt = ARGV[1]

if retiresAfterReservation then
  for _, credential in ipairs(allocation.credentials) do
    if credential.usageCount >= limit then
      local used = {
        id=credential.id,
        label=credential.label,
        star=credential.star,
        poolStar=credential.poolStar,
        groupId=credential.poolGroupId,
        groupLabel=credential.poolGroupLabel,
        usageCount=credential.usageCount,
        usedAt=ARGV[1]
      }
      redis.call('HSET', KEYS[3], credential.id, cjson.encode(used))
    end
  end
end

return cjson.encode(allocation)
`;

// SINGLE_CREDENTIAL_RESERVATION: chọn đúng một key còn lượt, tăng riêng bộ đếm
// của key đó và giữ nguyên toàn bộ key dự phòng.
const RESERVE_SINGLE_CREDENTIAL_SCRIPT = String.raw`
-- SINGLE_CREDENTIAL_RESERVATION
local raw = redis.call('GET', KEYS[1])
if not raw then
  return cjson.encode({ok=false, code='POOL_NOT_CONFIGURED'})
end

local pool = cjson.decode(raw)
local limit = tonumber(pool.maxUsesPerKey) or 10
local selectedGroup = nil
local selectedCredential = nil

for _, group in ipairs(pool.groups or {}) do
  for _, credential in ipairs(group.credentials or {}) do
    local count = tonumber(redis.call('HGET', KEYS[2], credential.id) or '0')
    if count < limit then
      selectedGroup = group
      selectedCredential = credential
      break
    end
  end
  if selectedCredential then break end
end

if not selectedCredential then
  return cjson.encode({ok=false, code='POOL_EXHAUSTED', maxUsesPerKey=limit})
end

local count = tonumber(redis.call('HINCRBY', KEYS[2], selectedCredential.id, 1))
local allocated = {}
for key, value in pairs(selectedCredential) do allocated[key] = value end
allocated.usageCount = count

local allocation = {
  ok=true,
  source='redis-vault',
  groupId=selectedGroup.id,
  groupLabel=selectedGroup.label,
  maxUsesPerKey=limit,
  credential=allocated,
  retiresAfterReservation=(count >= limit),
  reservedAt=ARGV[1]
}

if count >= limit then
  local used = {
    id=allocated.id,
    label=allocated.label,
    star=allocated.star,
    groupId=selectedGroup.id,
    groupLabel=selectedGroup.label,
    usageCount=count,
    usedAt=ARGV[1]
  }
  redis.call('HSET', KEYS[3], allocated.id, cjson.encode(used))
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

function cleanUsageInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function apifyUsageConfig() {
  const freeUsageMicroUsd = cleanUsageInteger(process.env.APIFY_FREE_USAGE_MICRO_USD, APIFY_FREE_USAGE_MICRO_USD);
  const shopeeCostPerReviewMicroUsd = cleanUsageInteger(process.env.SHOPEE_USAGE_MICRO_USD_PER_REVIEW, SHOPEE_USAGE_MICRO_USD_PER_REVIEW);
  const tiktokCostPerReviewMicroUsd = cleanUsageInteger(process.env.TIKTOK_USAGE_MICRO_USD_PER_REVIEW, TIKTOK_USAGE_MICRO_USD_PER_REVIEW);
  const shopeeReviewsPerRun = SHOPEE_MAX_REVIEWS_PER_RUN;
  const shopeeReservedUsageMicroUsd = DEFAULT_MAX_USES_PER_KEY * shopeeReviewsPerRun * shopeeCostPerReviewMicroUsd;
  const safeTikTokReviewsPerKey = Math.max(0, Math.floor(
    (freeUsageMicroUsd - shopeeReservedUsageMicroUsd) / tiktokCostPerReviewMicroUsd
  ));
  return {
    freeUsageMicroUsd,
    shopeeCostPerReviewMicroUsd,
    tiktokCostPerReviewMicroUsd,
    shopeeReviewsPerRun,
    shopeeReservedUsageMicroUsd,
    safeTikTokReviewsPerKey
  };
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
  if (!Array.isArray(groups) || groups.length > 50) {
    throw new Error('Pool không được vượt quá 50 nhóm Apify; mỗi nhóm có đúng 5 key.');
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

function buildEncryptedPending(pendingCredentials = []) {
  if (!Array.isArray(pendingCredentials) || pendingCredentials.length > 4) {
    throw new Error('Danh sách pending chỉ được có từ 0 đến 4 Apify key.');
  }
  const seen = new Set();
  return pendingCredentials.map((item, index) => {
    const token = String(typeof item === 'string' ? item : item?.token || '').trim();
    if (token.length < 16 || token.length > 500) throw new Error(`Apify token pending ${index + 1} không hợp lệ.`);
    const id = apifyCredentialId(token);
    if (seen.has(id)) throw new Error('Mỗi Apify token pending chỉ được xuất hiện một lần.');
    seen.add(id);
    return {
      id,
      label: cleanLabel(typeof item === 'string' ? null : item?.label, `pending-${index + 1}`),
      ...encryptToken(token)
    };
  });
}

function completePendingGroups(existingPending, incomingGroups, incomingPending) {
  if (!existingPending.length) return { groups: incomingGroups, pendingCredentials: incomingPending };
  const queue = [
    ...existingPending,
    ...incomingGroups.flatMap((group) => group.credentials),
    ...incomingPending
  ];
  const groups = [];
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  while (queue.length >= APIFY_STARS.length) {
    const credentials = queue.splice(0, APIFY_STARS.length).map((credential, index) => ({
      ...credential,
      star: APIFY_STARS[index]
    }));
    groups.push({
      id: groupId(credentials),
      label: `completed-pending-${stamp}-${groups.length + 1}`,
      credentials
    });
  }
  return {
    groups,
    pendingCredentials: queue.map(({ star: _star, ...credential }) => credential)
  };
}

function parseHashReply(value) {
  if (!Array.isArray(value)) return value && typeof value === 'object' ? value : {};
  const result = {};
  for (let index = 0; index < value.length; index += 2) result[value[index]] = value[index + 1];
  return result;
}

function activeTikTokReservedReviews(value, nowMs = Date.now()) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.max(0, numeric);
  try {
    const state = typeof value === 'string' ? JSON.parse(value) : value;
    return Object.values(state?.leases || {}).reduce((sum, lease) => (
      Number(lease?.expiresAtMs) > nowMs ? sum + Math.max(0, Number(lease?.amount) || 0) : sum
    ), 0);
  } catch {
    return 0;
  }
}

function publicCredential(credential, counters, maxUsesPerKey, tiktok = {}) {
  const usageCount = Number(counters[credential.id]) || 0;
  const tiktokRunCount = Number(tiktok.runs?.[credential.id]) || 0;
  const tiktokReviewCount = Number(tiktok.reviews?.[credential.id]) || 0;
  const tiktokReservedReviews = activeTikTokReservedReviews(tiktok.reserved?.[credential.id]);
  const usage = apifyUsageConfig();
  const shopeeUses = Math.min(DEFAULT_MAX_USES_PER_KEY, usageCount);
  const shopeeSpentUsageMicroUsd = shopeeUses * usage.shopeeReviewsPerRun * usage.shopeeCostPerReviewMicroUsd;
  const shopeeReservedUsageMicroUsd = Math.max(0, DEFAULT_MAX_USES_PER_KEY - shopeeUses)
    * usage.shopeeReviewsPerRun * usage.shopeeCostPerReviewMicroUsd;
  const tiktokUsageMicroUsd = (tiktokReviewCount + tiktokReservedReviews) * usage.tiktokCostPerReviewMicroUsd;
  const usageRemainingMicroUsd = Math.max(0, usage.freeUsageMicroUsd - shopeeSpentUsageMicroUsd - shopeeReservedUsageMicroUsd - tiktokUsageMicroUsd);
  const effectiveTikTokLimit = usage.safeTikTokReviewsPerKey;
  return {
    id: credential.id,
    label: credential.label,
    star: Number(credential.star),
    usageCount,
    remainingUses: Math.max(0, maxUsesPerKey - usageCount),
    status: usageCount >= maxUsesPerKey ? 'used' : 'available',
    shopee: {
      usageCount,
      remainingUses: Math.max(0, maxUsesPerKey - usageCount),
      status: usageCount >= maxUsesPerKey ? 'used' : 'available'
    },
    tiktok: {
      runCount: tiktokRunCount,
      reviewCount: tiktokReviewCount,
      reservedReviews: tiktokReservedReviews,
      remainingReviews: Math.max(0, effectiveTikTokLimit - tiktokReviewCount - tiktokReservedReviews),
      maxReviewsPerKey: effectiveTikTokLimit,
      safeUsageMaxReviewsPerKey: usage.safeTikTokReviewsPerKey,
      usageRemainingMicroUsd,
      shopeeReservedUsageMicroUsd,
      status: tiktokReviewCount >= effectiveTikTokLimit ? 'used' : 'available'
    }
  };
}

function emptyPoolStatus(provider = 'none') {
  return {
    version: 2,
    provider,
    maxUsesPerKey: DEFAULT_MAX_USES_PER_KEY,
    tiktokMaxReviewsPerKey: apifyUsageConfig().safeTikTokReviewsPerKey,
    updatedAt: null,
    active: null,
    reserve: [],
    used: [],
    usedHistory: [],
    pending: [],
    pendingCount: 0,
    neededForNextGroup: 5,
    platforms: {
      shopee: { usedHistory: [] },
      tiktok: { usedHistory: [] }
    },
    totals: { groups: 0, active: 0, reserve: 0, used: 0, credentials: 0, pending: 0 }
  };
}

function buildPoolStatus(config, counterReply, usedReply, tiktokReplies = {}) {
  const counters = parseHashReply(counterReply);
  const tiktok = {
    runs: parseHashReply(tiktokReplies.runs),
    reviews: parseHashReply(tiktokReplies.reviews),
    reserved: parseHashReply(tiktokReplies.reserved),
    maxReviewsPerKey: apifyUsageConfig().safeTikTokReviewsPerKey
  };
  const maxUsesPerKey = cleanMaxUses(config.maxUsesPerKey);
  let activeAssigned = false;
  let activeCredentialAssigned = false;
  const groups = (config.groups || []).map((group) => {
    const credentialStatuses = group.credentials.map((credential) => publicCredential(credential, counters, maxUsesPerKey, tiktok));
    const exhausted = credentialStatuses.every((credential) => credential.usageCount >= maxUsesPerKey);
    const status = exhausted ? 'used' : activeAssigned ? 'reserve' : 'active';
    if (status === 'active') activeAssigned = true;
    const credentials = credentialStatuses.map((credential) => {
      if (credential.usageCount >= maxUsesPerKey) return { ...credential, status: 'used' };
      if (status === 'active' && !activeCredentialAssigned) {
        activeCredentialAssigned = true;
        return { ...credential, status: 'active' };
      }
      return { ...credential, status: 'reserve' };
    });
    return { id: group.id, label: group.label, status, credentials };
  });
  const active = groups.find((group) => group.status === 'active') || null;
  const reserve = groups.filter((group) => group.status === 'reserve');
  const used = groups.filter((group) => group.status === 'used');
  const usedHistory = Object.values(parseHashReply(usedReply)).flatMap((value) => {
    try { return [typeof value === 'string' ? JSON.parse(value) : value]; } catch { return []; }
  }).sort((left, right) => String(right.usedAt || '').localeCompare(String(left.usedAt || '')));
  const tiktokUsedHistory = Object.values(parseHashReply(tiktokReplies.used)).flatMap((value) => {
    try { return [typeof value === 'string' ? JSON.parse(value) : value]; } catch { return []; }
  }).filter((entry) => Number(entry?.reviewCount) >= tiktok.maxReviewsPerKey)
    .sort((left, right) => String(right.usedAt || '').localeCompare(String(left.usedAt || '')));
  const pending = (config.pendingCredentials || []).map(({ id, label }) => ({ id, label, status: 'pending' }));
  return {
    version: config.version || 2,
    provider: 'upstash-redis',
    maxUsesPerKey,
    tiktokMaxReviewsPerKey: tiktok.maxReviewsPerKey,
    updatedAt: config.updatedAt || null,
    active,
    reserve,
    used,
    usedHistory,
    pending,
    pendingCount: pending.length,
    neededForNextGroup: pending.length ? APIFY_STARS.length - pending.length : APIFY_STARS.length,
    platforms: {
      shopee: { maxUsesPerKey, usedHistory },
      tiktok: { maxReviewsPerKey: tiktok.maxReviewsPerKey, usedHistory: tiktokUsedHistory }
    },
    totals: {
      groups: groups.length,
      active: active ? 1 : 0,
      reserve: reserve.length,
      used: used.length,
      credentials: groups.length * APIFY_STARS.length + pending.length,
      pending: pending.length
    }
  };
}

async function readPoolConfig(options = {}) {
  const value = await redisCommand(['GET', APIFY_POOL_KEY], options);
  if (!value) return null;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

export async function saveApifyCredentialPool({ groups = [], pendingCredentials = [], maxUsesPerKey, mode = 'replace' }, options = {}) {
  if (!isRedisConfigured()) throw new Error('Chưa cấu hình Upstash Redis.');
  if (!['replace', 'append'].includes(mode)) throw new Error('mode chỉ nhận replace hoặc append.');
  const newGroups = buildEncryptedGroups(groups);
  const newPending = buildEncryptedPending(pendingCredentials);
  if (!newGroups.length && !newPending.length) throw new Error('Cần ít nhất một Apify key để cập nhật pool.');
  const incomingCredentials = [...newGroups.flatMap((group) => group.credentials), ...newPending];
  if (new Set(incomingCredentials.map((credential) => credential.id)).size !== incomingCredentials.length) {
    throw new Error('Mỗi Apify token chỉ được xuất hiện một lần trong dữ liệu cập nhật.');
  }
  const [counterReply, usedReply] = await redisTransaction([
    ['HGETALL', APIFY_POOL_COUNTERS_KEY],
    ['HGETALL', APIFY_POOL_USED_KEY]
  ], options);
  const historicalCounters = parseHashReply(counterReply);
  const historicalUsed = parseHashReply(usedReply);
  const reusedCredentials = incomingCredentials
    .filter((credential) => Number(historicalCounters[credential.id] || 0) > 0 || historicalUsed[credential.id]);
  if (reusedCredentials.length) {
    throw new Error(`Có ${reusedCredentials.length} Apify key đã có lịch sử sử dụng. Hãy nạp key mới để không làm sai bộ đếm.`);
  }
  const existing = mode === 'append' ? await readPoolConfig(options) : null;
  const completed = completePendingGroups(existing?.pendingCredentials || [], newGroups, newPending);
  const combinedGroups = [...(existing?.groups || []), ...completed.groups];
  const combinedPending = completed.pendingCredentials;
  const credentialIds = new Set();
  for (const group of combinedGroups) {
    for (const credential of group.credentials) {
      if (credentialIds.has(credential.id)) throw new Error('Token mới đã tồn tại trong pool.');
      credentialIds.add(credential.id);
    }
  }
  for (const credential of combinedPending) {
    if (credentialIds.has(credential.id)) throw new Error('Token pending đã tồn tại trong pool.');
    credentialIds.add(credential.id);
  }
  if (combinedGroups.length > 50) throw new Error('Pool không được vượt quá 50 nhóm.');
  const config = {
    version: 2,
    maxUsesPerKey: cleanMaxUses(maxUsesPerKey, existing?.maxUsesPerKey),
    updatedAt: new Date().toISOString(),
    groups: combinedGroups,
    pendingCredentials: combinedPending
  };
  await redisCommand(['SET', APIFY_POOL_KEY, JSON.stringify(config)], options);
  return getApifyCredentialPoolStatus(options);
}

export async function reserveApifyCredentialSet(options = {}) {
  if (!isRedisConfigured()) throw new Error('Cần cấu hình Upstash Redis để cấp phát và xoay vòng Apify key an toàn.');
  if (!process.env.APIFY_TOKEN_VAULT_KEY) throw new Error('Chưa cấu hình APIFY_TOKEN_VAULT_KEY.');
  const stars = Array.isArray(options.stars) && options.stars.length
    ? options.stars.map(Number).filter((star) => APIFY_STARS.includes(star))
    : [...APIFY_STARS];
  const count = Math.min(5, Math.max(1, Number.parseInt(String(options.count ?? stars.length), 10) || stars.length));
  if (stars.length !== count || new Set(stars).size !== stars.length) throw new Error('Danh sách filter sao không hợp lệ.');
  const raw = await redisCommand([
    'EVAL', RESERVE_POOL_SCRIPT, '3', APIFY_POOL_KEY, APIFY_POOL_COUNTERS_KEY, APIFY_POOL_USED_KEY,
    new Date().toISOString(), String(count), JSON.stringify(stars)
  ], options);
  const allocation = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!allocation?.ok) {
    const error = new Error(allocation?.code === 'POOL_EXHAUSTED'
      ? `Không còn đủ ${count} Apify key khả dụng. Hãy bổ sung key dự phòng trong /api/apify-config.`
      : 'Chưa cấu hình pool Apify key trong /api/apify-config.');
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

export async function reserveApifyCredential(options = {}) {
  if (!isRedisConfigured()) throw new Error('Cần cấu hình Upstash Redis để cấp phát và xoay vòng Apify key an toàn.');
  if (!process.env.APIFY_TOKEN_VAULT_KEY) throw new Error('Chưa cấu hình APIFY_TOKEN_VAULT_KEY.');
  const raw = await redisCommand([
    'EVAL', RESERVE_SINGLE_CREDENTIAL_SCRIPT, '3', APIFY_POOL_KEY, APIFY_POOL_COUNTERS_KEY, APIFY_POOL_USED_KEY,
    new Date().toISOString()
  ], options);
  const allocation = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!allocation?.ok) {
    const error = new Error(allocation?.code === 'POOL_EXHAUSTED'
      ? 'Tất cả Apify key đã dùng đủ số lượt. Hãy bổ sung key dự phòng trong /api/apify-config.'
      : 'Chưa cấu hình Apify key trong /api/apify-config.');
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
    credential: {
      id: allocation.credential.id,
      label: allocation.credential.label,
      usageCount: Number(allocation.credential.usageCount),
      token: decryptToken(allocation.credential)
    }
  };
}

function decryptTikTokAllocation(allocation) {
  return {
    source: allocation.source,
    maxReviewsPerKey: Number(allocation.maxReviewsPerKey),
    reservedAt: allocation.reservedAt,
    credentials: allocation.credentials.map((credential) => ({
      id: credential.id,
      label: credential.label,
      groupId: credential.groupId,
      groupLabel: credential.groupLabel,
      runCount: Number(credential.runCount),
      reviewCount: Number(credential.reviewCount),
      plannedReviews: Number(credential.plannedReviews),
      reservedReviews: Number(credential.reservedReviews),
      reservationId: credential.reservationId || null,
      reservationExpiresAtMs: Number(credential.reservationExpiresAtMs) || null,
      maxReviewsPerKey: Number(allocation.maxReviewsPerKey),
      usageRemainingMicroUsd: Number(credential.usageRemainingMicroUsd) || 0,
      shopeeReservedUsageMicroUsd: Number(credential.shopeeReservedUsageMicroUsd) || 0,
      token: decryptToken(credential)
    }))
  };
}

export async function reserveTikTokCredentials({ count = 5, reviewsPerCredential = 40, ...options } = {}) {
  if (!isRedisConfigured()) throw new Error('Cần cấu hình Upstash Redis để cấp phát Apify key cho TikTok an toàn.');
  if (!process.env.APIFY_TOKEN_VAULT_KEY) throw new Error('Chưa cấu hình APIFY_TOKEN_VAULT_KEY.');
  const desired = Math.min(5, Math.max(1, Number.parseInt(String(count), 10) || 1));
  const planned = Math.min(200, Math.max(1, Number.parseInt(String(reviewsPerCredential), 10) || 40));
  const usage = apifyUsageConfig();
  const maxReviewsPerKey = usage.safeTikTokReviewsPerKey;
  if (maxReviewsPerKey < 1) {
    const error = new Error('Usage Apify hiện không đủ để vừa chạy TikTok vừa chừa đủ 10 lượt Shopee cho mỗi key.');
    error.code = 'APIFY_USAGE_RESERVED_FOR_SHOPEE';
    error.statusCode = 503;
    throw error;
  }
  const raw = await redisCommand([
    'EVAL', RESERVE_TIKTOK_CREDENTIALS_SCRIPT, '5',
    APIFY_POOL_KEY, APIFY_TIKTOK_RUN_COUNTERS_KEY, APIFY_TIKTOK_REVIEW_COUNTERS_KEY, APIFY_TIKTOK_RESERVED_REVIEWS_KEY, APIFY_POOL_COUNTERS_KEY,
    String(desired), String(planned), String(maxReviewsPerKey), new Date().toISOString(), String(Date.now()),
    String(usage.freeUsageMicroUsd), String(usage.shopeeCostPerReviewMicroUsd), String(usage.tiktokCostPerReviewMicroUsd),
    String(DEFAULT_MAX_USES_PER_KEY), String(usage.shopeeReviewsPerRun),
    String(Math.max(120_000, Number.parseInt(String(options.reservationLeaseMs || 180_000), 10) || 180_000))
  ], options);
  const allocation = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!allocation?.ok) {
    const error = new Error(allocation?.code === 'INSUFFICIENT_KEYS'
      ? `Không còn đủ ${desired} Apify key có hạn mức TikTok; hiện chỉ có ${Number(allocation.available) || 0} key.`
      : 'Chưa cấu hình Apify key trong /api/apify-config.');
    error.code = allocation?.code || 'POOL_NOT_CONFIGURED';
    error.available = Number(allocation?.available) || 0;
    error.statusCode = 503;
    throw error;
  }
  return decryptTikTokAllocation(allocation);
}

export async function finalizeTikTokCredential(credential, result = {}, options = {}) {
  if (!credential?.id) throw new Error('Thiếu mã Apify key để chốt bộ đếm TikTok.');
  const plannedReviews = Math.max(0, Number(credential.plannedReviews) || 0);
  const actualReviews = Math.max(0, Number(result.reviewCount) || 0);
  const maxReviewsPerKey = Number.isInteger(Number(credential.maxReviewsPerKey))
    ? Number(credential.maxReviewsPerKey)
    : apifyUsageConfig().safeTikTokReviewsPerKey;
  const forceExhausted = Boolean(result.quotaExhausted);
  const raw = await redisCommand([
    'EVAL', FINALIZE_TIKTOK_CREDENTIAL_SCRIPT, '4',
    APIFY_TIKTOK_REVIEW_COUNTERS_KEY, APIFY_TIKTOK_RESERVED_REVIEWS_KEY, APIFY_TIKTOK_USED_KEY, APIFY_TIKTOK_FINALIZED_RESERVATIONS_KEY,
    String(plannedReviews), String(actualReviews), String(maxReviewsPerKey), forceExhausted ? '1' : '0',
    credential.id, credential.label || credential.id, new Date().toISOString(),
    credential.reservationId || '', String(Date.now())
  ], options);
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

export async function getApifyCredentialPoolStatus(options = {}) {
  if (!isRedisConfigured()) return emptyPoolStatus();
  const [configValue, counters, used, tiktokRuns, tiktokReviews, tiktokReserved, tiktokUsed] = await redisTransaction([
    ['GET', APIFY_POOL_KEY],
    ['HGETALL', APIFY_POOL_COUNTERS_KEY],
    ['HGETALL', APIFY_POOL_USED_KEY],
    ['HGETALL', APIFY_TIKTOK_RUN_COUNTERS_KEY],
    ['HGETALL', APIFY_TIKTOK_REVIEW_COUNTERS_KEY],
    ['HGETALL', APIFY_TIKTOK_RESERVED_REVIEWS_KEY],
    ['HGETALL', APIFY_TIKTOK_USED_KEY]
  ], options);
  if (!configValue) return emptyPoolStatus('upstash-redis');
  const config = typeof configValue === 'string' ? JSON.parse(configValue) : configValue;
  return buildPoolStatus(config, counters, used, {
    runs: tiktokRuns,
    reviews: tiktokReviews,
    reserved: tiktokReserved,
    used: tiktokUsed
  });
}
