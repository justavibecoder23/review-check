import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { isRedisConfigured, redisCommand, redisTransaction } from './redis-rest.mjs';
import { SHOPEE_CACHE_HITS_KEY, SHOPEE_TOTAL_SERVED_KEY } from './product-cache.mjs';
import {
  TIKTOK_DEFAULT_ACTOR_ID,
  TIKTOK_DEFAULT_USAGE_MICRO_USD_PER_REVIEW,
  TIKTOK_TEMPORARY_ACTOR_ID,
  TIKTOK_TEMPORARY_STARTUP_FEE_MICRO_USD,
  TIKTOK_TEMPORARY_USAGE_MICRO_USD_PER_REVIEW
} from './apify-tiktok-runtime.mjs';

export const APIFY_POOL_KEY = 'realview:apify:credential-pool:v2';
export const APIFY_POOL_COUNTERS_KEY = 'realview:apify:credential-pool:v2:counters';
export const APIFY_POOL_USED_KEY = 'realview:apify:credential-pool:v2:used';
export const APIFY_TIKTOK_RUN_COUNTERS_KEY = 'realview:apify:credential-pool:v2:tiktok:runs';
export const APIFY_TIKTOK_REVIEW_COUNTERS_KEY = 'realview:apify:credential-pool:v2:tiktok:reviews';
export const APIFY_TIKTOK_RESERVED_REVIEWS_KEY = 'realview:apify:credential-pool:v2:tiktok:reserved';
export const APIFY_TIKTOK_USED_KEY = 'realview:apify:credential-pool:v2:tiktok:used';
export const APIFY_TIKTOK_FINALIZED_RESERVATIONS_KEY = 'realview:apify:credential-pool:v2:tiktok:finalized';
// Shopee Store Actor trial is lifetime-scoped. Keep this as a code-owned
// invariant so an older Redis pool document (which stored 10) cannot silently
// keep credentials retired after the limit is raised.
export const DEFAULT_MAX_USES_PER_KEY = 20;
export const APIFY_STARS = Object.freeze([5, 4, 3, 2, 1]);
export const APIFY_FREE_USAGE_MICRO_USD = 5_000_000;
export const SHOPEE_USAGE_MICRO_USD_PER_REVIEW = 3_990;
export const TIKTOK_USAGE_MICRO_USD_PER_REVIEW = 400;
export const SHOPEE_MAX_REVIEWS_PER_RUN = 20;
export const APIFY_COST_LEDGER_PREFIX = 'realview:apify:credential-pool:v4:cost';
export const APIFY_TIKTOK_COOLDOWN_KEY = 'realview:apify:credential-pool:v3:tiktok:cooldown';
export const APIFY_TIKTOK_ACTOR_DENIED_KEY = 'realview:apify:credential-pool:v3:tiktok:actor-denied';
export const APIFY_COST_MIGRATION_KEY = 'realview:apify:credential-pool:v4:cost:migrated';
export const APIFY_SHOPEE_LIFETIME_RESERVED_KEY = 'realview:apify:credential-pool:v4:shopee:lifetime-reserved';
export const APIFY_SHOPEE_ACTOR_START_COUNTERS_KEY = 'realview:apify:credential-pool:v5:shopee:actor-starts';
export const APIFY_SHOPEE_EMPTY_RUN_COUNTERS_KEY = 'realview:apify:credential-pool:v5:shopee:empty-runs';
export const APIFY_SHOPEE_ACTOR_EXHAUSTED_KEY = 'realview:apify:credential-pool:v5:shopee:actor-exhausted';
export const APIFY_TIKTOK_ACTOR_START_COUNTERS_KEY = 'realview:apify:credential-pool:v5:tiktok:actor-starts';
export const APIFY_TIKTOK_EMPTY_RUN_COUNTERS_KEY = 'realview:apify:credential-pool:v5:tiktok:empty-runs';
export const APIFY_TIKTOK_BILLED_ITEM_COUNTERS_KEY = 'realview:apify:credential-pool:v5:tiktok:billed-items';
export const SHOPEE_ACTOR_STARTUP_FEE_MICRO_USD = 8_000;

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
local shopeeRunCost = tonumber(ARGV[7]) or 87800
local tiktokCostPerReview = tonumber(ARGV[8]) or 400
local shopeeMaxUses = tonumber(ARGV[9]) or 20
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
    local shopeeSpent = shopeeUses * shopeeRunCost
    local shopeeReserved = math.max(0, shopeeMaxUses - shopeeUses) * shopeeRunCost
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

// The v4 ledger stores money per exact Apify account billing cycle, not review
// counts. Pricing is frozen into each reservation so a later actor flag change
// cannot re-price historical usage.
const RESERVE_TIKTOK_COST_SCRIPT = String.raw`
-- TIKTOK_COST_RESERVATION_V4
local raw = redis.call('GET', KEYS[1])
if not raw then return cjson.encode({ok=false, code='POOL_NOT_CONFIGURED'}) end
local pool = cjson.decode(raw)
local desired = tonumber(ARGV[1]) or 1
local requested = tonumber(ARGV[2]) or 1
local nowMs = tonumber(ARGV[3]) or 0
local leaseMs = tonumber(ARGV[4]) or 180000
local budget = tonumber(ARGV[5]) or 5000000
local shopeeRunCost = tonumber(ARGV[6]) or 87800
local itemCost = tonumber(ARGV[7]) or 800
local startupFee = tonumber(ARGV[8]) or 0
local actorId = ARGV[9]
local pricingVersion = ARGV[10]
local legacyItemCost = tonumber(ARGV[11]) or 800
local requestId = ARGV[12]
local maxShopeeUses = tonumber(ARGV[14]) or 20
local usageCycles = cjson.decode(ARGV[15] or '{}')
local selected = {}

local function cleanLeases(accountId)
  local state = {leases={}}
  local encoded = redis.call('HGET', KEYS[4], accountId)
  if encoded then
    local ok, decoded = pcall(cjson.decode, encoded)
    if ok and type(decoded) == 'table' and type(decoded.leases) == 'table' then state = decoded end
  end
  local total = 0
  for id, lease in pairs(state.leases) do
    if tonumber(lease.expiresAtMs or 0) <= nowMs then state.leases[id] = nil
    else total = total + math.max(0, tonumber(lease.costMicroUsd) or 0) end
  end
  return state, total
end

local function activeShopeeSlots(credentialId)
  local state = {leases={}}
  local encoded = redis.call('HGET', KEYS[12], credentialId)
  if encoded then
    local ok, decoded = pcall(cjson.decode, encoded)
    if ok and type(decoded) == 'table' and type(decoded.leases) == 'table' then state = decoded end
  end
  local count = 0
  for id, lease in pairs(state.leases) do
    if tonumber(lease.expiresAtMs or 0) <= nowMs then state.leases[id] = nil
    else count = count + 1 end
  end
  redis.call('HSET', KEYS[12], credentialId, cjson.encode(state))
  return count
end

for _, group in ipairs(pool.groups or {}) do
  for _, credential in ipairs(group.credentials or {}) do
    local usageCycle = usageCycles[credential.id]
    if #selected < desired and usageCycle then
      local accountId = credential.billingAccountId or credential.id
      local accountKey = accountId .. ':' .. usageCycle.cycleStartAt
      local cooldownUntil = tonumber(redis.call('HGET', KEYS[7], credential.id) or '0')
      local denied = redis.call('HEXISTS', KEYS[8], credential.id .. ':' .. actorId)
      local exhausted = redis.call('HEXISTS', KEYS[9], accountKey)
      if cooldownUntil <= nowMs and denied == 0 and exhausted == 0 then
        local spent = math.max(
          tonumber(redis.call('HGET', KEYS[3], accountKey) or '0'),
          tonumber(usageCycle.observedSpentMicroUsd) or 0
        )
        redis.call('HSET', KEYS[3], accountKey, spent)
        local shopeeUses = math.min(maxShopeeUses, math.max(0, tonumber(redis.call('HGET', KEYS[2], credential.id) or '0')))
        local shopeeSlots = activeShopeeSlots(credential.id)
        local state, reserved = cleanLeases(accountKey)
        local remainingShopeeUses = math.max(0, maxShopeeUses - shopeeUses - shopeeSlots)
        local shopeeReserve = remainingShopeeUses * shopeeRunCost
        local available = math.max(0, budget - shopeeReserve - spent - reserved)
        local affordable = math.max(0, math.floor((available - startupFee) / itemCost))
        local planned = math.min(requested, affordable)
        if planned > 0 then
          table.insert(selected, {
            credential=credential, groupId=group.id, groupLabel=group.label,
            accountId=accountId, accountKey=accountKey, usageCycle=usageCycle,
            state=state, spent=spent, reserved=reserved,
            available=available, planned=planned, shopeeReserve=shopeeReserve
          })
        end
      end
    end
  end
end
if #selected < desired then
  return cjson.encode({ok=false, code='INSUFFICIENT_BUDGET_OR_KEYS', available=#selected, requested=desired})
end

local result = {ok=true, source='redis-vault-cost-ledger-v4', credentials={}}
for index, candidate in ipairs(selected) do
  local reservationId = requestId .. ':' .. tostring(index)
  local plannedCost = startupFee + candidate.planned * itemCost
  candidate.state.leases[reservationId] = {
    costMicroUsd=plannedCost, plannedReviews=candidate.planned,
    itemCostMicroUsd=itemCost, startupFeeMicroUsd=startupFee,
    actorId=actorId, pricingVersion=pricingVersion,
    expiresAtMs=nowMs + leaseMs
  }
  redis.call('HSET', KEYS[4], candidate.accountKey, cjson.encode(candidate.state))
  local runCount = tonumber(redis.call('HINCRBY', KEYS[5], candidate.accountKey, 1))
  local allocated = {}
  for key, value in pairs(candidate.credential) do allocated[key] = value end
  allocated.groupId = candidate.groupId
  allocated.groupLabel = candidate.groupLabel
  allocated.billingAccountId = candidate.accountId
  allocated.accountCycleId = candidate.accountKey
  allocated.billingCycleStartAt = candidate.usageCycle.cycleStartAt
  allocated.billingCycleEndAt = candidate.usageCycle.cycleEndAt
  allocated.runCount = runCount
  allocated.plannedReviews = candidate.planned
  allocated.plannedCostMicroUsd = plannedCost
  allocated.spentMicroUsd = candidate.spent
  allocated.reservedMicroUsd = candidate.reserved + plannedCost
  allocated.shopeeReservedMicroUsd = candidate.shopeeReserve
  allocated.reservationId = reservationId
  allocated.reservationExpiresAtMs = nowMs + leaseMs
  table.insert(result.credentials, allocated)
end
return cjson.encode(result)
`;

const FINALIZE_TIKTOK_COST_SCRIPT = String.raw`
-- TIKTOK_COST_FINALIZATION_V4
local accountId = ARGV[1]
local credentialId = ARGV[2]
local reservationId = ARGV[3]
local operationId = ARGV[4]
local actualReviews = math.max(0, tonumber(ARGV[5]) or 0)
local statusCode = tonumber(ARGV[6]) or 0
local failureClass = ARGV[7]
local nowMs = tonumber(ARGV[8]) or 0
local retryAfterMs = tonumber(ARGV[9]) or 60000
local billingAccountId = ARGV[10]
local actorStarted = ARGV[13] == '1'
if redis.call('HEXISTS', KEYS[3], operationId) == 1 then
  return cjson.encode({ok=true, alreadyFinalized=true})
end
local state = {leases={}}
local encoded = redis.call('HGET', KEYS[2], accountId)
if encoded then
  local ok, decoded = pcall(cjson.decode, encoded)
  if ok and type(decoded) == 'table' and type(decoded.leases) == 'table' then state = decoded end
end
local lease = state.leases[reservationId]
if not lease then return cjson.encode({ok=false, code='RESERVATION_NOT_FOUND'}) end

if failureClass == 'timeout' or failureClass == 'upstream_service_error' or failureClass == 'unknown_error' then
  lease.expiresAtMs = nowMs + 86400000
  state.leases[reservationId] = lease
  redis.call('HSET', KEYS[2], accountId, cjson.encode(state))
  return cjson.encode({ok=true, pending=true, reservationId=reservationId})
end

state.leases[reservationId] = nil
redis.call('HSET', KEYS[2], accountId, cjson.encode(state))
local actualCost = 0
if statusCode >= 200 and statusCode < 300 then
  actualCost = (tonumber(lease.startupFeeMicroUsd) or 0) + actualReviews * (tonumber(lease.itemCostMicroUsd) or 0)
  redis.call('HINCRBY', KEYS[1], accountId, actualCost)
end
if actorStarted then redis.call('HINCRBY', KEYS[7], credentialId, 1) end
if actorStarted and statusCode >= 200 and statusCode < 300 and actualReviews == 0 then
  redis.call('HINCRBY', KEYS[8], credentialId, 1)
end
if statusCode >= 200 and statusCode < 300 and actualReviews > 0 then
  redis.call('HINCRBY', KEYS[9], credentialId, actualReviews)
end
if failureClass == 'billing_exhausted' then redis.call('HSET', KEYS[4], accountId, nowMs) end
if failureClass == 'actor_access_denied' or failureClass == 'invalid_auth' then
  redis.call('HSET', KEYS[5], credentialId .. ':' .. tostring(lease.actorId), nowMs)
end
if failureClass == 'temporary_throttle' then redis.call('HSET', KEYS[6], credentialId, nowMs + retryAfterMs) end
local entry = {
  operationId=operationId, reservationId=reservationId, credentialId=credentialId,
  billingAccountId=billingAccountId, accountCycleId=accountId,
  billingCycleStartAt=ARGV[11], billingCycleEndAt=ARGV[12], platform='tiktok',
  actorId=lease.actorId, pricingVersion=lease.pricingVersion,
  itemsBilled=actualReviews, startupFeeMicroUsd=tonumber(lease.startupFeeMicroUsd) or 0,
  itemCostMicroUsd=tonumber(lease.itemCostMicroUsd) or 0,
  totalCostMicroUsd=actualCost, actorStarted=actorStarted,
  emptyDataset=actorStarted and statusCode >= 200 and statusCode < 300 and actualReviews == 0,
  statusCode=statusCode, failureClass=failureClass,
  finalizedAt=nowMs
}
redis.call('HSET', KEYS[3], operationId, cjson.encode(entry))
return cjson.encode({ok=true, alreadyFinalized=false, costMicroUsd=actualCost})
`;

const RESERVE_SHOPEE_COST_SCRIPT = String.raw`
-- SHOPEE_LIFETIME_AND_COST_RESERVATION_V4
local raw = redis.call('GET', KEYS[1])
if not raw then return cjson.encode({ok=false, code='POOL_NOT_CONFIGURED'}) end
local pool = cjson.decode(raw)
local desired = tonumber(ARGV[1]) or 5
local stars = cjson.decode(ARGV[2] or '[5,4,3,2,1]')
local nowMs = tonumber(ARGV[3]) or 0
local leaseMs = tonumber(ARGV[4]) or 180000
local budget = tonumber(ARGV[5]) or 5000000
local runCost = tonumber(ARGV[6]) or 87800
local itemCost = tonumber(ARGV[7]) or 3990
local startupFee = tonumber(ARGV[8]) or 0
local actorId = ARGV[9]
local pricingVersion = ARGV[10]
local requestId = ARGV[11]
local period = ARGV[12]
local maxUses = tonumber(ARGV[13]) or 20
local legacyTikTokCost = tonumber(ARGV[14]) or 800
local usageCycles = cjson.decode(ARGV[16] or '{}')
local selected = {}
local order = 0

local function cleanState(key, id, amountField)
  local state = {leases={}}
  local encoded = redis.call('HGET', key, id)
  if encoded then
    local ok, decoded = pcall(cjson.decode, encoded)
    if ok and type(decoded) == 'table' and type(decoded.leases) == 'table' then state = decoded end
  end
  local count = 0
  local total = 0
  for leaseId, lease in pairs(state.leases) do
    if tonumber(lease.expiresAtMs or 0) <= nowMs then state.leases[leaseId] = nil
    else
      count = count + 1
      total = total + math.max(0, tonumber(lease[amountField]) or 0)
    end
  end
  redis.call('HSET', key, id, cjson.encode(state))
  return state, count, total
end

for groupIndex, group in ipairs(pool.groups or {}) do
  for _, credential in ipairs(group.credentials or {}) do
    order = order + 1
    local usageCycle = usageCycles[credential.id]
    local accountId = credential.billingAccountId or credential.id
    local accountKey = usageCycle and accountId .. ':' .. usageCycle.cycleStartAt or ''
    local used = math.max(0, tonumber(redis.call('HGET', KEYS[2], credential.id) or '0'))
    local slotState, activeSlots = cleanState(KEYS[4], credential.id, 'slot')
    local costState = {leases={}}
    local reservedCost = 0
    if usageCycle then costState, _, reservedCost = cleanState(KEYS[6], accountKey, 'costMicroUsd') end
    local cooldownUntil = tonumber(redis.call('HGET', KEYS[11], credential.id) or '0')
    local denied = redis.call('HEXISTS', KEYS[12], credential.id .. ':' .. actorId)
    local exhausted = usageCycle and redis.call('HEXISTS', KEYS[13], accountKey) or 1
    local actorExhausted = 0
    local actorExhaustedRaw = redis.call('HGET', KEYS[14], accountId .. ':' .. actorId)
    if actorExhaustedRaw then
      local markerOk, marker = pcall(cjson.decode, actorExhaustedRaw)
      if markerOk and type(marker) == 'table' and tonumber(marker.maxUsesPerKey or 0) >= maxUses then
        actorExhausted = 1
      end
    end
    if usageCycle and used + activeSlots < maxUses and cooldownUntil <= nowMs and denied == 0 and exhausted == 0 and actorExhausted == 0 then
      local spent = math.max(
        tonumber(redis.call('HGET', KEYS[5], accountKey) or '0'),
        tonumber(usageCycle.observedSpentMicroUsd) or 0
      )
      redis.call('HSET', KEYS[5], accountKey, spent)
      local remainingAfter = math.max(0, maxUses - used - activeSlots - 1)
      local committedAfter = spent + reservedCost + runCost + remainingAfter * runCost
      if committedAfter <= budget then
        table.insert(selected, {
          credential=credential, group=group, groupIndex=groupIndex, order=order,
          accountId=accountId, accountKey=accountKey, usageCycle=usageCycle,
          used=used, activeSlots=activeSlots,
          slotState=slotState, costState=costState, spent=spent,
          reservedCost=reservedCost, remainingAfter=remainingAfter
        })
      end
    end
  end
end

table.sort(selected, function(left, right)
  if left.groupIndex ~= right.groupIndex then return left.groupIndex < right.groupIndex end
  if left.used + left.activeSlots ~= right.used + right.activeSlots then
    return left.used + left.activeSlots < right.used + right.activeSlots
  end
  return left.order < right.order
end)
if #selected < desired or #stars ~= desired then
  return cjson.encode({ok=false, code='SHOPEE_LIFETIME_OR_BUDGET_EXHAUSTED', available=#selected, requested=desired})
end

local result = {ok=true, source='redis-vault-cost-ledger-v4', credentials={}, reservedAt=ARGV[15], maxUsesPerKey=maxUses}
for index = 1, desired do
  local candidate = selected[index]
  local reservationId = requestId .. ':' .. tostring(index)
  local expiresAtMs = nowMs + leaseMs
  candidate.slotState.leases[reservationId] = {slot=1, expiresAtMs=expiresAtMs}
  candidate.costState.leases[reservationId] = {
    costMicroUsd=runCost, plannedReviews=20, itemCostMicroUsd=itemCost,
    startupFeeMicroUsd=startupFee, actorId=actorId,
    pricingVersion=pricingVersion, platform='shopee', expiresAtMs=expiresAtMs
  }
  redis.call('HSET', KEYS[4], candidate.credential.id, cjson.encode(candidate.slotState))
  redis.call('HSET', KEYS[6], candidate.accountKey, cjson.encode(candidate.costState))
  local allocated = {}
  for key, value in pairs(candidate.credential) do allocated[key] = value end
  allocated.star = stars[index]
  allocated.poolStar = candidate.credential.star
  allocated.poolGroupId = candidate.group.id
  allocated.poolGroupLabel = candidate.group.label
  allocated.billingAccountId = candidate.accountId
  allocated.accountCycleId = candidate.accountKey
  allocated.billingCycleStartAt = candidate.usageCycle.cycleStartAt
  allocated.billingCycleEndAt = candidate.usageCycle.cycleEndAt
  allocated.usageCount = candidate.used
  allocated.reservedUsageCount = candidate.activeSlots + 1
  allocated.remainingLifetimeUses = candidate.remainingAfter
  allocated.plannedReviews = 20
  allocated.plannedCostMicroUsd = runCost
  allocated.spentMicroUsd = candidate.spent
  allocated.reservedMicroUsd = candidate.reservedCost + runCost
  allocated.reservationId = reservationId
  allocated.reservationExpiresAtMs = expiresAtMs
  table.insert(result.credentials, allocated)
end
local mixed = false
for index = 2, desired do
  if selected[index].group.id ~= selected[1].group.id then mixed = true end
end
result.groupId = mixed and 'mixed-available-keys' or selected[1].group.id
result.groupLabel = mixed and 'mixed-available-keys' or selected[1].group.label
result.retiresAfterReservation = false
for index = 1, desired do
  if selected[index].remainingAfter == 0 then result.retiresAfterReservation = true end
end
return cjson.encode(result)
`;

const FINALIZE_SHOPEE_COST_SCRIPT = String.raw`
-- SHOPEE_LIFETIME_AND_COST_FINALIZATION_V5
local accountId = ARGV[1]
local credentialId = ARGV[2]
local reservationId = ARGV[3]
local operationId = ARGV[4]
local actualReviews = math.max(0, tonumber(ARGV[5]) or 0)
local statusCode = tonumber(ARGV[6]) or 0
local failureClass = ARGV[7]
local nowMs = tonumber(ARGV[8]) or 0
local retryAfterMs = tonumber(ARGV[9]) or 60000
local label = ARGV[10]
local star = tonumber(ARGV[11]) or 0
local groupId = ARGV[12]
local groupLabel = ARGV[13]
local maxUses = tonumber(ARGV[14]) or 20
local billingAccountId = ARGV[16]
local actorStarted = ARGV[19] == '1'
local freeTierExhausted = ARGV[20] == '1'
local reportedCost = tonumber(ARGV[21])
if redis.call('HEXISTS', KEYS[6], operationId) == 1 then
  return cjson.encode({ok=true, alreadyFinalized=true})
end

local function readState(key, id)
  local state = {leases={}}
  local encoded = redis.call('HGET', key, id)
  if encoded then
    local ok, decoded = pcall(cjson.decode, encoded)
    if ok and type(decoded) == 'table' and type(decoded.leases) == 'table' then state = decoded end
  end
  return state
end
local slotState = readState(KEYS[3], credentialId)
local costState = readState(KEYS[5], accountId)
local lease = costState.leases[reservationId]
if not lease or not slotState.leases[reservationId] then
  return cjson.encode({ok=false, code='RESERVATION_NOT_FOUND'})
end
if failureClass == 'timeout' or failureClass == 'upstream_service_error' or failureClass == 'unknown_error' then
  lease.expiresAtMs = nowMs + 86400000
  costState.leases[reservationId] = lease
  slotState.leases[reservationId].expiresAtMs = nowMs + 86400000
  redis.call('HSET', KEYS[3], credentialId, cjson.encode(slotState))
  redis.call('HSET', KEYS[5], accountId, cjson.encode(costState))
  return cjson.encode({ok=true, pending=true, reservationId=reservationId})
end

slotState.leases[reservationId] = nil
costState.leases[reservationId] = nil
redis.call('HSET', KEYS[3], credentialId, cjson.encode(slotState))
redis.call('HSET', KEYS[5], accountId, cjson.encode(costState))
local usageCount = tonumber(redis.call('HGET', KEYS[1], credentialId) or '0')
local actualCost = 0
local successfulResponse = statusCode >= 200 and statusCode < 300
if actorStarted then
  redis.call('HINCRBY', KEYS[10], credentialId, 1)
end
if successfulResponse and actualReviews == 0 then
  redis.call('HINCRBY', KEYS[11], credentialId, 1)
end
if successfulResponse and actualReviews > 0 then
  usageCount = tonumber(redis.call('HINCRBY', KEYS[1], credentialId, 1))
  actualReviews = math.min(actualReviews, tonumber(lease.plannedReviews) or 20)
  if usageCount >= maxUses then
    redis.call('HSET', KEYS[2], credentialId, cjson.encode({
      id=credentialId, label=label, star=star, groupId=groupId,
      groupLabel=groupLabel, usageCount=usageCount, usedAt=ARGV[15]
    }))
  end
end
if actorStarted then
  if reportedCost and reportedCost >= 0 then
    actualCost = reportedCost
  else
    actualCost = (tonumber(lease.startupFeeMicroUsd) or 0) + actualReviews * (tonumber(lease.itemCostMicroUsd) or 0)
  end
  redis.call('HINCRBY', KEYS[4], accountId, actualCost)
end
if freeTierExhausted then
  redis.call('HSET', KEYS[12], billingAccountId .. ':' .. tostring(lease.actorId), cjson.encode({
    exhaustedAt=nowMs, maxUsesPerKey=maxUses
  }))
end
if failureClass == 'billing_exhausted' then redis.call('HSET', KEYS[7], accountId, nowMs) end
if failureClass == 'actor_access_denied' or failureClass == 'invalid_auth' then
  redis.call('HSET', KEYS[9], credentialId .. ':' .. tostring(lease.actorId), nowMs)
end
if failureClass == 'temporary_throttle' then redis.call('HSET', KEYS[8], credentialId, nowMs + retryAfterMs) end
local entry = {
  operationId=operationId, reservationId=reservationId, platform='shopee',
  credentialId=credentialId, billingAccountId=billingAccountId, accountCycleId=accountId,
  billingCycleStartAt=ARGV[17], billingCycleEndAt=ARGV[18], actorId=lease.actorId,
  pricingVersion=lease.pricingVersion, itemsBilled=actualReviews,
  startupFeeMicroUsd=tonumber(lease.startupFeeMicroUsd) or 0,
  itemCostMicroUsd=tonumber(lease.itemCostMicroUsd) or 0,
  totalCostMicroUsd=actualCost, lifetimeUsageCount=usageCount,
  actorStarted=actorStarted, emptyDataset=successfulResponse and actualReviews == 0,
  freeTierExhausted=freeTierExhausted, statusCode=statusCode,
  failureClass=failureClass, finalizedAt=nowMs
}
redis.call('HSET', KEYS[6], operationId, cjson.encode(entry))
return cjson.encode({ok=true, alreadyFinalized=false, costMicroUsd=actualCost, usageCount=usageCount})
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
local limit = 20
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
local limit = 20
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

function effectiveShopeeMaxUses(value) {
  if (value !== undefined && value !== null) cleanMaxUses(value);
  return DEFAULT_MAX_USES_PER_KEY;
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
  const shopeeStartupFeeMicroUsd = cleanUsageInteger(process.env.SHOPEE_ACTOR_STARTUP_FEE_MICRO_USD, SHOPEE_ACTOR_STARTUP_FEE_MICRO_USD);
  const shopeeRunCostMicroUsd = shopeeStartupFeeMicroUsd + shopeeReviewsPerRun * shopeeCostPerReviewMicroUsd;
  const shopeeReservedUsageMicroUsd = DEFAULT_MAX_USES_PER_KEY * shopeeRunCostMicroUsd;
  const safeTikTokReviewsPerKey = Math.max(0, Math.floor(
    (freeUsageMicroUsd - shopeeReservedUsageMicroUsd) / tiktokCostPerReviewMicroUsd
  ));
  return {
    freeUsageMicroUsd,
    shopeeCostPerReviewMicroUsd,
    tiktokCostPerReviewMicroUsd,
    shopeeReviewsPerRun,
    shopeeStartupFeeMicroUsd,
    shopeeRunCostMicroUsd,
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
      billingAccountId: String(item?.billingAccountId || apifyCredentialId(token)).trim(),
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

function currentShopeeActorExhausted(value, maxUsesPerKey = DEFAULT_MAX_USES_PER_KEY) {
  try {
    const marker = typeof value === 'string' ? JSON.parse(value) : value;
    return Number(marker?.maxUsesPerKey) >= maxUsesPerKey;
  } catch {
    // Legacy markers were written while the lifetime ceiling was 10. They are
    // intentionally ignored so those credentials can be tried again up to 20.
    return false;
  }
}

function publicCredential(credential, counters, maxUsesPerKey, tiktok = {}, shopeeRuntime = {}) {
  const usageCount = Number(counters[credential.id]) || 0;
  const tiktokRunCount = Number(tiktok.runs?.[credential.id]) || 0;
  const tiktokReviewCount = Number(tiktok.reviews?.[credential.id]) || 0;
  const tiktokReservedReviews = activeTikTokReservedReviews(tiktok.reserved?.[credential.id]);
  const usage = apifyUsageConfig();
  const shopeeUses = Math.min(DEFAULT_MAX_USES_PER_KEY, usageCount);
  const shopeeSpentUsageMicroUsd = shopeeUses * usage.shopeeRunCostMicroUsd;
  const shopeeReservedUsageMicroUsd = Math.max(0, DEFAULT_MAX_USES_PER_KEY - shopeeUses)
    * usage.shopeeRunCostMicroUsd;
  const actorStartCount = Number(shopeeRuntime.actorStarts?.[credential.id]) || 0;
  const emptyRunCount = Number(shopeeRuntime.emptyRuns?.[credential.id]) || 0;
  const actorExhausted = currentShopeeActorExhausted(
    shopeeRuntime.actorExhausted?.[`${credential.billingAccountId || credential.id}:${shopeeRuntime.actorId}`],
    maxUsesPerKey
  );
  const tiktokUsageMicroUsd = (tiktokReviewCount + tiktokReservedReviews) * usage.tiktokCostPerReviewMicroUsd;
  const usageRemainingMicroUsd = Math.max(0, usage.freeUsageMicroUsd - shopeeSpentUsageMicroUsd - shopeeReservedUsageMicroUsd - tiktokUsageMicroUsd);
  const effectiveTikTokLimit = usage.safeTikTokReviewsPerKey;
  const shopeeRemainingUses = actorExhausted ? 0 : Math.max(0, maxUsesPerKey - usageCount);
  const shopeeStatus = actorExhausted ? 'actor-exhausted' : usageCount >= maxUsesPerKey ? 'used' : 'available';
  return {
    id: credential.id,
    label: credential.label,
    star: Number(credential.star),
    usageCount,
    remainingUses: shopeeRemainingUses,
    status: shopeeStatus,
    shopee: {
      usageCount,
      dataRunsUsed: usageCount,
      actorStartCount,
      emptyRunCount,
      actorExhausted,
      remainingUses: shopeeRemainingUses,
      status: shopeeStatus
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
      shopee: {
        usedHistory: [],
        accounting: { dataRunsUsed: 0, actorStarts: 0, emptyRuns: 0, actorExhausted: 0 },
        cache: { hits: 0, totalServed: 0, hitRate: 0 }
      },
      tiktok: {
        usedHistory: [],
        accounting: { actorStarts: 0, emptyRuns: 0, billedItems: 0 }
      }
    },
    totals: { groups: 0, active: 0, reserve: 0, used: 0, credentials: 0, pending: 0 }
  };
}

function buildPoolStatus(config, counterReply, usedReply, tiktokReplies = {}, shopeeCache = {}, shopeeRuntime = {}) {
  const counters = parseHashReply(counterReply);
  const tiktok = {
    runs: parseHashReply(tiktokReplies.runs),
    reviews: parseHashReply(tiktokReplies.reviews),
    reserved: parseHashReply(tiktokReplies.reserved),
    actorStarts: parseHashReply(tiktokReplies.actorStarts),
    emptyRuns: parseHashReply(tiktokReplies.emptyRuns),
    billedItems: parseHashReply(tiktokReplies.billedItems),
    maxReviewsPerKey: apifyUsageConfig().safeTikTokReviewsPerKey
  };
  const maxUsesPerKey = effectiveShopeeMaxUses(config.maxUsesPerKey);
  let activeAssigned = false;
  let activeCredentialAssigned = false;
  const groups = (config.groups || []).map((group) => {
    const credentialStatuses = group.credentials.map((credential) => publicCredential(credential, counters, maxUsesPerKey, tiktok, shopeeRuntime));
    const exhausted = credentialStatuses.every((credential) => credential.usageCount >= maxUsesPerKey || credential.shopee.actorExhausted);
    const status = exhausted ? 'used' : activeAssigned ? 'reserve' : 'active';
    if (status === 'active') activeAssigned = true;
    const credentials = credentialStatuses.map((credential) => {
      if (credential.usageCount >= maxUsesPerKey || credential.shopee.actorExhausted) return { ...credential, status: 'used' };
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
  }).filter((entry) => Number(entry?.usageCount) >= maxUsesPerKey)
    .sort((left, right) => String(right.usedAt || '').localeCompare(String(left.usedAt || '')));
  const tiktokUsedHistory = Object.values(parseHashReply(tiktokReplies.used)).flatMap((value) => {
    try { return [typeof value === 'string' ? JSON.parse(value) : value]; } catch { return []; }
  }).filter((entry) => Number(entry?.reviewCount) >= tiktok.maxReviewsPerKey)
    .sort((left, right) => String(right.usedAt || '').localeCompare(String(left.usedAt || '')));
  const pending = (config.pendingCredentials || []).map(({ id, label }) => ({ id, label, status: 'pending' }));
  const cacheHits = Math.max(0, Number(shopeeCache.hits) || 0);
  const shopeeTotalServed = Math.max(0, Number(shopeeCache.totalServed) || 0);
  const shopeeCredentials = groups.flatMap((group) => group.credentials);
  const shopeeStats = shopeeCredentials.reduce((totals, credential) => ({
    dataRunsUsed: totals.dataRunsUsed + credential.shopee.dataRunsUsed,
    actorStarts: totals.actorStarts + credential.shopee.actorStartCount,
    emptyRuns: totals.emptyRuns + credential.shopee.emptyRunCount,
    actorExhausted: totals.actorExhausted + (credential.shopee.actorExhausted ? 1 : 0)
  }), { dataRunsUsed: 0, actorStarts: 0, emptyRuns: 0, actorExhausted: 0 });
  const tiktokStats = shopeeCredentials.reduce((totals, credential) => ({
    actorStarts: totals.actorStarts + (Number(tiktok.actorStarts[credential.id]) || 0),
    emptyRuns: totals.emptyRuns + (Number(tiktok.emptyRuns[credential.id]) || 0),
    billedItems: totals.billedItems + (Number(tiktok.billedItems[credential.id]) || 0)
  }), { actorStarts: 0, emptyRuns: 0, billedItems: 0 });
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
      shopee: {
        maxUsesPerKey,
        usedHistory,
        accounting: shopeeStats,
        cache: {
          hits: cacheHits,
          totalServed: shopeeTotalServed,
          hitRate: shopeeTotalServed ? cacheHits / shopeeTotalServed : 0
        }
      },
      tiktok: {
        maxReviewsPerKey: tiktok.maxReviewsPerKey,
        usedHistory: tiktokUsedHistory,
        accounting: tiktokStats
      }
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
    // Migrate older pools from the previous 10-run limit without rewriting
    // lifetime counters. Credentials at 10 immediately become available again.
    maxUsesPerKey: effectiveShopeeMaxUses(maxUsesPerKey ?? existing?.maxUsesPerKey),
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

export function apifyBillingPeriod(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) throw new Error('Thời điểm chu kỳ Apify không hợp lệ.');
  return date.toISOString().slice(0, 7);
}

export function calculateTikTokCostCapacity({
  budgetMicroUsd = APIFY_FREE_USAGE_MICRO_USD,
  shopeeReservedMicroUsd = DEFAULT_MAX_USES_PER_KEY * (
    SHOPEE_ACTOR_STARTUP_FEE_MICRO_USD + SHOPEE_MAX_REVIEWS_PER_RUN * SHOPEE_USAGE_MICRO_USD_PER_REVIEW
  ),
  spentMicroUsd = 0,
  reservedMicroUsd = 0,
  reviewCostMicroUsd,
  startupFeeMicroUsd = 0
}) {
  const availableMicroUsd = Math.max(0, Number(budgetMicroUsd) - Number(shopeeReservedMicroUsd)
    - Number(spentMicroUsd) - Number(reservedMicroUsd));
  const itemCost = Math.max(1, Number(reviewCostMicroUsd) || 1);
  return {
    availableMicroUsd,
    affordableReviews: Math.max(0, Math.floor((availableMicroUsd - Math.max(0, Number(startupFeeMicroUsd) || 0)) / itemCost))
  };
}

export function calculateApifyCycleBudget({
  budgetMicroUsd = APIFY_FREE_USAGE_MICRO_USD,
  observedSpentMicroUsd = 0,
  locallyTrackedSpentMicroUsd = 0,
  reservedMicroUsd = 0,
  shopeeLifetimeUsed = 0,
  shopeeLifetimeReserved = 0,
  shopeeMaxUses = DEFAULT_MAX_USES_PER_KEY,
  shopeeRunCostMicroUsd = SHOPEE_ACTOR_STARTUP_FEE_MICRO_USD
    + SHOPEE_MAX_REVIEWS_PER_RUN * SHOPEE_USAGE_MICRO_USD_PER_REVIEW
} = {}) {
  const spentMicroUsd = Math.max(0, Number(observedSpentMicroUsd) || 0, Number(locallyTrackedSpentMicroUsd) || 0);
  const remainingShopeeUses = Math.max(0, Number(shopeeMaxUses) - Number(shopeeLifetimeUsed) - Number(shopeeLifetimeReserved));
  const shopeeReservedMicroUsd = remainingShopeeUses * Number(shopeeRunCostMicroUsd);
  const committedMicroUsd = spentMicroUsd + Math.max(0, Number(reservedMicroUsd) || 0) + shopeeReservedMicroUsd;
  return {
    spentMicroUsd,
    remainingShopeeUses,
    shopeeReservedMicroUsd,
    committedMicroUsd,
    availableMicroUsd: Math.max(0, Number(budgetMicroUsd) - committedMicroUsd)
  };
}

function costLedgerKeys(period) {
  return {
    spent: `${APIFY_COST_LEDGER_PREFIX}:spent`,
    reserved: `${APIFY_COST_LEDGER_PREFIX}:reserved`,
    runs: `${APIFY_COST_LEDGER_PREFIX}:runs`,
    ledger: `${APIFY_COST_LEDGER_PREFIX}:ledger`,
    exhausted: `${APIFY_COST_LEDGER_PREFIX}:exhausted`
  };
}

function legacyV3CostSpentKey(period) {
  return `realview:apify:credential-pool:v3:cost:${period}:spent`;
}

function accountCycleId(accountId, cycleStartAt) {
  return `${accountId}:${cycleStartAt}`;
}

async function readApifyUsageSnapshot(credential, options = {}) {
  const response = await (options.usageFetchImpl || fetch)('https://api.apify.com/v2/users/me/usage/monthly', {
    headers: { authorization: `Bearer ${decryptToken(credential)}` },
    signal: AbortSignal.timeout(Math.max(2_000, Number(options.usageTimeoutMs) || 6_000))
  });
  if (!response.ok) throw new Error(`Apify usage trả về HTTP ${response.status}.`);
  const body = await response.json();
  return normalizeApifyUsageSnapshot(body?.data, credential.id, credential.billingAccountId || credential.id);
}

export function normalizeApifyUsageSnapshot(data, credentialId, billingAccountId = credentialId) {
  const startAt = String(data?.usageCycle?.startAt || '');
  const endAt = String(data?.usageCycle?.endAt || '');
  if (!startAt || !endAt || !Number.isFinite(Date.parse(startAt)) || !Number.isFinite(Date.parse(endAt))) {
    throw new Error('Apify không trả về chu kỳ usage hợp lệ.');
  }
  const spentUsd = Number(data?.totalUsageCreditsUsdAfterVolumeDiscount);
  if (!Number.isFinite(spentUsd) || spentUsd < 0) throw new Error('Apify không trả về tổng usage hợp lệ.');
  return {
    credentialId,
    billingAccountId,
    accountCycleId: accountCycleId(billingAccountId, startAt),
    cycleStartAt: startAt,
    cycleEndAt: endAt,
    observedSpentMicroUsd: Math.ceil(spentUsd * 1_000_000)
  };
}

async function apifyUsageCandidates({ count, platform, actorId = '', minimumCostMicroUsd = 0, ...options }) {
  const config = await readPoolConfig(options);
  if (!config) return [];
  const [counterReply, actorExhaustedReply] = await redisTransaction([
    ['HGETALL', APIFY_POOL_COUNTERS_KEY],
    ['HGETALL', APIFY_SHOPEE_ACTOR_EXHAUSTED_KEY]
  ], options);
  const counters = parseHashReply(counterReply);
  const actorExhausted = parseHashReply(actorExhaustedReply);
  const candidates = (config.groups || []).flatMap((group, groupIndex) => group.credentials.map((credential, order) => ({
    credential, groupIndex, order, usageCount: Number(counters[credential.id] || 0)
  }))).filter(({ credential, usageCount }) => platform !== 'shopee' || (
    usageCount < DEFAULT_MAX_USES_PER_KEY
    && !currentShopeeActorExhausted(
      actorExhausted[`${credential.billingAccountId || credential.id}:${actorId}`],
      DEFAULT_MAX_USES_PER_KEY
    )
  ))
    .sort((left, right) => left.groupIndex - right.groupIndex || left.usageCount - right.usageCount || left.order - right.order);
  const usage = apifyUsageConfig();
  const shopeeRunCost = usage.shopeeRunCostMicroUsd;
  const eligible = [];
  const batchSize = Math.max(5, count * 2);
  for (let offset = 0; offset < Math.min(candidates.length, 50) && eligible.length < count; offset += batchSize) {
    const batch = candidates.slice(offset, offset + batchSize);
    const settled = await Promise.allSettled(batch.map(async (candidate) => ({
      candidate,
      snapshot: await readApifyUsageSnapshot(candidate.credential, options)
    })));
    for (const result of settled) {
      if (result.status !== 'fulfilled') continue;
      const { candidate, snapshot } = result.value;
      const remainingShopee = Math.max(0, DEFAULT_MAX_USES_PER_KEY - candidate.usageCount);
      const committed = snapshot.observedSpentMicroUsd + remainingShopee * shopeeRunCost
        + (platform === 'tiktok' ? minimumCostMicroUsd : 0);
      if (committed <= usage.freeUsageMicroUsd) eligible.push(snapshot);
    }
  }
  return eligible;
}

function decryptCostAllocation(allocation, runtime, period) {
  const billingCycles = allocation.credentials.map((credential) => ({
    credentialId: credential.id,
    startAt: credential.billingCycleStartAt || null,
    endAt: credential.billingCycleEndAt || null
  }));
  const distinctCycles = new Set(billingCycles.map(({ startAt, endAt }) => `${startAt}|${endAt}`));
  return {
    source: allocation.source,
    billingPeriod: distinctCycles.size === 1 ? billingCycles[0]?.startAt : null,
    billingCycles,
    runtime,
    credentials: allocation.credentials.map((credential) => ({
      id: credential.id,
      label: credential.label,
      groupId: credential.groupId,
      groupLabel: credential.groupLabel,
      billingAccountId: credential.billingAccountId || credential.id,
      accountCycleId: credential.accountCycleId,
      billingPeriod: credential.billingCycleStartAt || period,
      billingCycleStartAt: credential.billingCycleStartAt || null,
      billingCycleEndAt: credential.billingCycleEndAt || null,
      runCount: Number(credential.runCount),
      plannedReviews: Number(credential.plannedReviews),
      plannedCostMicroUsd: Number(credential.plannedCostMicroUsd),
      spentMicroUsd: Number(credential.spentMicroUsd) || 0,
      reservedMicroUsd: Number(credential.reservedMicroUsd) || 0,
      shopeeReservedMicroUsd: Number(credential.shopeeReservedMicroUsd) || 0,
      reservationId: credential.reservationId,
      reservationExpiresAtMs: Number(credential.reservationExpiresAtMs) || null,
      token: decryptToken(credential)
    }))
  };
}

export async function reserveTikTokCostCredentials({ count = 1, reviewsPerCredential = 100, runtime, ...options } = {}) {
  if (!isRedisConfigured()) throw new Error('Cần cấu hình Upstash Redis để cấp phát Apify key cho TikTok an toàn.');
  if (!process.env.APIFY_TOKEN_VAULT_KEY) throw new Error('Chưa cấu hình APIFY_TOKEN_VAULT_KEY.');
  if (!runtime?.actorId || !runtime?.pricingVersion) throw new Error('Thiếu cấu hình runtime TikTok để đặt chỗ chi phí.');
  const desired = Math.min(5, Math.max(1, Number.parseInt(String(count), 10) || 1));
  const requested = Math.min(100, Math.max(1, Number.parseInt(String(reviewsPerCredential), 10) || 100));
  const now = options.now ? new Date(options.now) : new Date();
  const period = apifyBillingPeriod(now);
  const keys = costLedgerKeys(period);
  const usage = apifyUsageConfig();
  const usageSnapshots = await apifyUsageCandidates({
    count: desired,
    platform: 'tiktok',
    minimumCostMicroUsd: runtime.startupFeeMicroUsd + runtime.reviewCostMicroUsd,
    ...options
  });
  if (usageSnapshots.length < desired) {
    const error = new Error('Không đọc được chu kỳ usage hiện tại của đủ tài khoản Apify cho TikTok.');
    error.code = 'APIFY_USAGE_CYCLE_UNAVAILABLE';
    error.statusCode = 503;
    throw error;
  }
  const usageCycles = Object.fromEntries(usageSnapshots.map((snapshot) => [snapshot.credentialId, snapshot]));
  const raw = await redisCommand([
    'EVAL', RESERVE_TIKTOK_COST_SCRIPT, '13',
    APIFY_POOL_KEY, APIFY_POOL_COUNTERS_KEY, keys.spent, keys.reserved, keys.runs,
    keys.ledger, APIFY_TIKTOK_COOLDOWN_KEY, APIFY_TIKTOK_ACTOR_DENIED_KEY, keys.exhausted, APIFY_TIKTOK_REVIEW_COUNTERS_KEY,
    APIFY_COST_MIGRATION_KEY, APIFY_SHOPEE_LIFETIME_RESERVED_KEY, legacyV3CostSpentKey(period),
    String(desired), String(requested), String(now.getTime()),
    String(Math.max(120_000, Number.parseInt(String(options.reservationLeaseMs || 180_000), 10) || 180_000)),
    String(usage.freeUsageMicroUsd), String(usage.shopeeRunCostMicroUsd),
    String(runtime.reviewCostMicroUsd), String(runtime.startupFeeMicroUsd), runtime.actorId, runtime.pricingVersion,
    '800', randomUUID(), period, String(DEFAULT_MAX_USES_PER_KEY), JSON.stringify(usageCycles)
  ], options);
  const allocation = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!allocation?.ok) {
    const error = new Error(allocation?.code === 'INSUFFICIENT_BUDGET_OR_KEYS'
      ? `Không còn đủ ${desired} tài khoản Apify có ngân sách hoặc đang khả dụng cho actor TikTok này.`
      : 'Chưa cấu hình pool Apify key trong /api/apify-config.');
    error.code = allocation?.code || 'POOL_NOT_CONFIGURED';
    error.available = Number(allocation?.available) || 0;
    error.statusCode = 503;
    throw error;
  }
  return decryptCostAllocation(allocation, runtime, period);
}

export async function finalizeTikTokCostCredential(credential, result = {}, options = {}) {
  if (!credential?.id || !credential?.reservationId) throw new Error('Thiếu reservation để chốt sổ chi phí TikTok.');
  const period = credential.billingPeriod || options.billingPeriod || apifyBillingPeriod(options.now || new Date());
  const keys = costLedgerKeys(period);
  const operationId = String(result.operationId || result.actorRunId || credential.reservationId);
  const now = options.now ? new Date(options.now) : new Date();
  const raw = await redisCommand([
    'EVAL', FINALIZE_TIKTOK_COST_SCRIPT, '9',
    keys.spent, keys.reserved, keys.ledger, keys.exhausted, APIFY_TIKTOK_ACTOR_DENIED_KEY, APIFY_TIKTOK_COOLDOWN_KEY,
    APIFY_TIKTOK_ACTOR_START_COUNTERS_KEY, APIFY_TIKTOK_EMPTY_RUN_COUNTERS_KEY, APIFY_TIKTOK_BILLED_ITEM_COUNTERS_KEY,
    credential.accountCycleId || accountCycleId(credential.billingAccountId || credential.id, credential.billingCycleStartAt || period),
    credential.id, credential.reservationId, operationId,
    String(Math.max(0, Number(result.reviewCount) || 0)), String(Number(result.statusCode) || 0),
    String(result.failureClass || ''), String(now.getTime()), String(Math.max(1_000, Number(result.retryAfterMs) || 60_000)),
    credential.billingAccountId || credential.id, credential.billingCycleStartAt || period, credential.billingCycleEndAt || '',
    result.actorStarted === false ? '0' : '1'
  ], options);
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

function decryptShopeeCostAllocation(allocation) {
  return {
    source: allocation.source,
    groupId: allocation.groupId,
    groupLabel: allocation.groupLabel,
    maxUsesPerKey: Number(allocation.maxUsesPerKey) || DEFAULT_MAX_USES_PER_KEY,
    retiresAfterReservation: Boolean(allocation.retiresAfterReservation),
    reservedAt: allocation.reservedAt,
    credentials: allocation.credentials.map((credential) => ({
      id: credential.id,
      label: credential.label,
      star: Number(credential.star),
      poolStar: Number(credential.poolStar),
      poolGroupId: credential.poolGroupId,
      poolGroupLabel: credential.poolGroupLabel,
      billingAccountId: credential.billingAccountId || credential.id,
      accountCycleId: credential.accountCycleId,
      billingCycleStartAt: credential.billingCycleStartAt,
      billingCycleEndAt: credential.billingCycleEndAt,
      usageCount: Number(credential.usageCount) || 0,
      reservedUsageCount: Number(credential.reservedUsageCount) || 0,
      remainingLifetimeUses: Number(credential.remainingLifetimeUses) || 0,
      plannedReviews: Number(credential.plannedReviews) || SHOPEE_MAX_REVIEWS_PER_RUN,
      plannedCostMicroUsd: Number(credential.plannedCostMicroUsd) || 0,
      spentMicroUsd: Number(credential.spentMicroUsd) || 0,
      reservedMicroUsd: Number(credential.reservedMicroUsd) || 0,
      reservationId: credential.reservationId,
      reservationExpiresAtMs: Number(credential.reservationExpiresAtMs) || null,
      token: decryptToken(credential)
    }))
  };
}

export async function reserveShopeeCostCredentialSet(options = {}) {
  if (!isRedisConfigured()) throw new Error('Cần cấu hình Upstash Redis để cấp phát Apify key cho Shopee an toàn.');
  if (!process.env.APIFY_TOKEN_VAULT_KEY) throw new Error('Chưa cấu hình APIFY_TOKEN_VAULT_KEY.');
  const stars = Array.isArray(options.stars) && options.stars.length
    ? options.stars.map(Number).filter((star) => APIFY_STARS.includes(star))
    : [...APIFY_STARS];
  const desired = Math.min(5, Math.max(1, Number.parseInt(String(options.count ?? stars.length), 10) || stars.length));
  if (stars.length !== desired || new Set(stars).size !== stars.length) throw new Error('Danh sách filter sao không hợp lệ.');
  const actorId = String(options.actorId || process.env.APIFY_ACTOR_ID || 'zen-studio/shopee-product-reviews-scraper');
  const pricingVersion = String(options.pricingVersion || 'zen-studio-2026-09');
  const usage = apifyUsageConfig();
  const runCost = usage.shopeeRunCostMicroUsd;
  const now = options.now ? new Date(options.now) : new Date();
  const usageSnapshots = await apifyUsageCandidates({ count: desired, platform: 'shopee', actorId, ...options });
  if (usageSnapshots.length < desired) {
    const error = new Error('Không đọc được chu kỳ usage hiện tại của đủ tài khoản Apify cho Shopee.');
    error.code = 'APIFY_USAGE_CYCLE_UNAVAILABLE';
    error.statusCode = 503;
    throw error;
  }
  const cycles = Object.fromEntries(usageSnapshots.map((snapshot) => [snapshot.credentialId, snapshot]));
  const keys = costLedgerKeys();
  const raw = await redisCommand([
    'EVAL', RESERVE_SHOPEE_COST_SCRIPT, '14',
    APIFY_POOL_KEY, APIFY_POOL_COUNTERS_KEY, APIFY_POOL_USED_KEY, APIFY_SHOPEE_LIFETIME_RESERVED_KEY,
    keys.spent, keys.reserved, keys.ledger, APIFY_COST_MIGRATION_KEY, APIFY_TIKTOK_REVIEW_COUNTERS_KEY,
    legacyV3CostSpentKey(apifyBillingPeriod(now)), APIFY_TIKTOK_COOLDOWN_KEY, APIFY_TIKTOK_ACTOR_DENIED_KEY, keys.exhausted,
    APIFY_SHOPEE_ACTOR_EXHAUSTED_KEY,
    String(desired), JSON.stringify(stars), String(now.getTime()),
    String(Math.max(120_000, Number.parseInt(String(options.reservationLeaseMs || 180_000), 10) || 180_000)),
    String(usage.freeUsageMicroUsd), String(runCost), String(usage.shopeeCostPerReviewMicroUsd), String(usage.shopeeStartupFeeMicroUsd),
    actorId, pricingVersion, randomUUID(), apifyBillingPeriod(now), String(DEFAULT_MAX_USES_PER_KEY), '800',
    now.toISOString(), JSON.stringify(cycles)
  ], options);
  const allocation = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!allocation?.ok) {
    const error = new Error(allocation?.code === 'SHOPEE_LIFETIME_OR_BUDGET_EXHAUSTED'
      ? `Không còn đủ ${desired} tài khoản có lượt Shopee trọn đời và ngân sách khả dụng.`
      : 'Chưa cấu hình pool Apify key trong /api/apify-config.');
    error.code = allocation?.code || 'POOL_NOT_CONFIGURED';
    error.available = Number(allocation?.available) || 0;
    error.statusCode = 503;
    throw error;
  }
  return decryptShopeeCostAllocation(allocation);
}

export async function finalizeShopeeCostCredential(credential, result = {}, options = {}) {
  if (!credential?.id || !credential?.reservationId || !credential?.accountCycleId) {
    throw new Error('Thiếu reservation hoặc chu kỳ billing để chốt sổ Shopee.');
  }
  const keys = costLedgerKeys();
  const operationId = String(result.operationId || result.actorRunId || credential.reservationId);
  const now = options.now ? new Date(options.now) : new Date();
  const hasReportedCost = result.actualCostMicroUsd !== null && result.actualCostMicroUsd !== undefined
    && result.actualCostMicroUsd !== '' && Number.isFinite(Number(result.actualCostMicroUsd));
  const raw = await redisCommand([
    'EVAL', FINALIZE_SHOPEE_COST_SCRIPT, '12',
    APIFY_POOL_COUNTERS_KEY, APIFY_POOL_USED_KEY, APIFY_SHOPEE_LIFETIME_RESERVED_KEY,
    keys.spent, keys.reserved, keys.ledger, keys.exhausted, APIFY_TIKTOK_COOLDOWN_KEY, APIFY_TIKTOK_ACTOR_DENIED_KEY,
    APIFY_SHOPEE_ACTOR_START_COUNTERS_KEY, APIFY_SHOPEE_EMPTY_RUN_COUNTERS_KEY, APIFY_SHOPEE_ACTOR_EXHAUSTED_KEY,
    credential.accountCycleId, credential.id, credential.reservationId, operationId,
    String(Math.max(0, Number(result.reviewCount) || 0)), String(Number(result.statusCode) || 0),
    String(result.failureClass || ''), String(now.getTime()), String(Math.max(1_000, Number(result.retryAfterMs) || 60_000)),
    credential.label || credential.id, String(credential.poolStar || credential.star || 0),
    credential.poolGroupId || '', credential.poolGroupLabel || '', String(DEFAULT_MAX_USES_PER_KEY), now.toISOString(),
    credential.billingAccountId || credential.id, credential.billingCycleStartAt || '', credential.billingCycleEndAt || '',
    result.actorStarted === false ? '0' : '1', result.freeTierExhausted ? '1' : '0',
    hasReportedCost ? String(Math.max(0, Math.round(Number(result.actualCostMicroUsd)))) : ''
  ], options);
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

export async function reserveTikTokCredentials({ count = 5, reviewsPerCredential = 40, ...options } = {}) {
  if (!isRedisConfigured()) throw new Error('Cần cấu hình Upstash Redis để cấp phát Apify key cho TikTok an toàn.');
  if (!process.env.APIFY_TOKEN_VAULT_KEY) throw new Error('Chưa cấu hình APIFY_TOKEN_VAULT_KEY.');
  const desired = Math.min(5, Math.max(1, Number.parseInt(String(count), 10) || 1));
  const planned = Math.min(200, Math.max(1, Number.parseInt(String(reviewsPerCredential), 10) || 40));
  const usage = apifyUsageConfig();
  const maxReviewsPerKey = usage.safeTikTokReviewsPerKey;
  if (maxReviewsPerKey < 1) {
    const error = new Error(`Usage Apify hiện không đủ để vừa chạy TikTok vừa chừa đủ ${DEFAULT_MAX_USES_PER_KEY} lượt Shopee cho mỗi key.`);
    error.code = 'APIFY_USAGE_RESERVED_FOR_SHOPEE';
    error.statusCode = 503;
    throw error;
  }
  const raw = await redisCommand([
    'EVAL', RESERVE_TIKTOK_CREDENTIALS_SCRIPT, '5',
    APIFY_POOL_KEY, APIFY_TIKTOK_RUN_COUNTERS_KEY, APIFY_TIKTOK_REVIEW_COUNTERS_KEY, APIFY_TIKTOK_RESERVED_REVIEWS_KEY, APIFY_POOL_COUNTERS_KEY,
    String(desired), String(planned), String(maxReviewsPerKey), new Date().toISOString(), String(Date.now()),
    String(usage.freeUsageMicroUsd), String(usage.shopeeRunCostMicroUsd), String(usage.tiktokCostPerReviewMicroUsd),
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
  const [configValue, counters, used, tiktokRuns, tiktokReviews, tiktokReserved, tiktokUsed,
    shopeeCacheHits, shopeeTotalServed, shopeeActorStarts, shopeeEmptyRuns, shopeeActorExhausted,
    tiktokActorStarts, tiktokEmptyRuns, tiktokBilledItems] = await redisTransaction([
    ['GET', APIFY_POOL_KEY],
    ['HGETALL', APIFY_POOL_COUNTERS_KEY],
    ['HGETALL', APIFY_POOL_USED_KEY],
    ['HGETALL', APIFY_TIKTOK_RUN_COUNTERS_KEY],
    ['HGETALL', APIFY_TIKTOK_REVIEW_COUNTERS_KEY],
    ['HGETALL', APIFY_TIKTOK_RESERVED_REVIEWS_KEY],
    ['HGETALL', APIFY_TIKTOK_USED_KEY],
    ['GET', SHOPEE_CACHE_HITS_KEY],
    ['GET', SHOPEE_TOTAL_SERVED_KEY],
    ['HGETALL', APIFY_SHOPEE_ACTOR_START_COUNTERS_KEY],
    ['HGETALL', APIFY_SHOPEE_EMPTY_RUN_COUNTERS_KEY],
    ['HGETALL', APIFY_SHOPEE_ACTOR_EXHAUSTED_KEY],
    ['HGETALL', APIFY_TIKTOK_ACTOR_START_COUNTERS_KEY],
    ['HGETALL', APIFY_TIKTOK_EMPTY_RUN_COUNTERS_KEY],
    ['HGETALL', APIFY_TIKTOK_BILLED_ITEM_COUNTERS_KEY]
  ], options);
  if (!configValue) return emptyPoolStatus('upstash-redis');
  const config = typeof configValue === 'string' ? JSON.parse(configValue) : configValue;
  return buildPoolStatus(config, counters, used, {
    runs: tiktokRuns,
    reviews: tiktokReviews,
    reserved: tiktokReserved,
    used: tiktokUsed,
    actorStarts: tiktokActorStarts,
    emptyRuns: tiktokEmptyRuns,
    billedItems: tiktokBilledItems
  }, {
    hits: shopeeCacheHits,
    totalServed: shopeeTotalServed
  }, {
    actorStarts: parseHashReply(shopeeActorStarts),
    emptyRuns: parseHashReply(shopeeEmptyRuns),
    actorExhausted: parseHashReply(shopeeActorExhausted),
    actorId: process.env.APIFY_ACTOR_ID || 'zen-studio/shopee-product-reviews-scraper'
  });
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, worker));
  return results;
}

async function readApifyActorHistory(credential, actorId, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const token = decryptToken(credential).trim();
  if (!/^[\x20-\x7E]+$/.test(token)) {
    throw new Error('Token chứa ký tự không hợp lệ cho HTTP Authorization header.');
  }
  const headers = { authorization: `Bearer ${token}` };
  const actor = encodeURIComponent(String(actorId).replace('/', '~'));
  const runs = [];
  for (let offset = 0; ; offset += 1000) {
    const response = await fetchImpl(`https://api.apify.com/v2/acts/${actor}/runs?limit=1000&offset=${offset}&desc=0`, {
      headers,
      signal: AbortSignal.timeout(Math.max(5_000, Number(options.timeoutMs) || 30_000))
    });
    if (!response.ok) throw new Error(`Không đọc được lịch sử Actor của ${credential.label}: HTTP ${response.status}.`);
    const body = await response.json();
    const page = Array.isArray(body?.data?.items) ? body.data.items : [];
    runs.push(...page);
    if (page.length < 1000) break;
  }

  const inspected = await mapWithConcurrency(runs, Math.max(1, Math.min(12, Number(options.runConcurrency) || 8)), async (run) => {
    let itemCount = 0;
    let freeTierExhausted = false;
    if (String(run.status).toUpperCase() === 'SUCCEEDED' && run.defaultDatasetId) {
      const datasetResponse = await fetchImpl(`https://api.apify.com/v2/datasets/${encodeURIComponent(run.defaultDatasetId)}`, {
        headers,
        signal: AbortSignal.timeout(Math.max(5_000, Number(options.timeoutMs) || 30_000))
      });
      if (datasetResponse.ok) {
        const dataset = await datasetResponse.json();
        itemCount = Math.max(0, Number(dataset?.data?.itemCount) || 0);
      }
      if (itemCount === 0) {
        const logResponse = await fetchImpl(`https://api.apify.com/v2/logs/${encodeURIComponent(run.id)}`, {
          headers,
          signal: AbortSignal.timeout(Math.max(5_000, Number(options.timeoutMs) || 30_000))
        });
        if (logResponse.ok) freeTierExhausted = /free\s+tier\s+limit\s+reached/i.test(await logResponse.text());
      }
    }
    const reportedCost = Number(run.usageTotalUsd);
    const fallbackCostMicroUsd = typeof options.fallbackCostMicroUsd === 'function'
      ? options.fallbackCostMicroUsd({ run, itemCount })
      : SHOPEE_ACTOR_STARTUP_FEE_MICRO_USD;
    const actualCostMicroUsd = Number.isFinite(reportedCost) && reportedCost >= 0
      ? Math.round(reportedCost * 1_000_000)
      : Math.max(0, Math.round(Number(fallbackCostMicroUsd) || 0));
    return {
      runId: String(run.id),
      status: String(run.status || ''),
      startedAt: run.startedAt || run.createdAt || null,
      finishedAt: run.finishedAt || null,
      itemCount,
      emptyDataset: String(run.status).toUpperCase() === 'SUCCEEDED' && itemCount === 0,
      freeTierExhausted,
      actualCostMicroUsd
    };
  });
  return inspected;
}

// Công cụ bảo trì có chủ đích: đối soát theo runId và chỉ ghi ledger audit.
// Tổng spent theo tháng không được HINCRBY ở đây vì snapshot Apify đã bao gồm
// các khoản lịch sử; cộng lần nữa sẽ làm usage bị nhân đôi.
export async function reconcileShopeeActorHistory({ apply = false, actorId, ...options } = {}) {
  if (!isRedisConfigured()) throw new Error('Chưa cấu hình Upstash Redis.');
  if (!process.env.APIFY_TOKEN_VAULT_KEY) throw new Error('Chưa cấu hình APIFY_TOKEN_VAULT_KEY.');
  const config = await readPoolConfig(options);
  if (!config) throw new Error('Pool Apify chưa được cấu hình.');
  const resolvedActorId = String(actorId || process.env.APIFY_ACTOR_ID || 'zen-studio/shopee-product-reviews-scraper');
  const credentials = (config.groups || []).flatMap((group) => group.credentials.map((credential) => ({
    ...credential,
    groupId: group.id,
    groupLabel: group.label
  })));
  const [previousCountersReply, previousActorStartsReply, previousEmptyRunsReply] = await redisTransaction([
    ['HGETALL', APIFY_POOL_COUNTERS_KEY],
    ['HGETALL', APIFY_SHOPEE_ACTOR_START_COUNTERS_KEY],
    ['HGETALL', APIFY_SHOPEE_EMPTY_RUN_COUNTERS_KEY]
  ], options);
  const previousCounters = parseHashReply(previousCountersReply);
  const previousActorStarts = parseHashReply(previousActorStartsReply);
  const previousEmptyRuns = parseHashReply(previousEmptyRunsReply);
  const reconciled = await mapWithConcurrency(credentials,
    Math.max(1, Math.min(8, Number(options.accountConcurrency) || 4)),
    async (credential) => {
      try {
        const runs = await readApifyActorHistory(credential, resolvedActorId, options);
        const dataRunsUsed = runs.filter((run) => run.status === 'SUCCEEDED' && run.itemCount > 0).length;
        const emptyRuns = runs.filter((run) => run.emptyDataset).length;
        const actorStarts = runs.length;
        const exhaustedRun = runs.find((run) => run.freeTierExhausted);
        return {
          credential,
          runs,
          dataRunsUsed,
          emptyRuns,
          actorStarts,
          actorExhausted: Boolean(exhaustedRun),
          actorExhaustedAt: exhaustedRun?.finishedAt || exhaustedRun?.startedAt || null,
          historicalCostMicroUsd: runs.reduce((sum, run) => sum + run.actualCostMicroUsd, 0)
        };
      } catch (error) {
        return {
          credential,
          runs: [],
          dataRunsUsed: 0,
          emptyRuns: 0,
          actorStarts: 0,
          actorExhausted: false,
          actorExhaustedAt: null,
          historicalCostMicroUsd: 0,
          error: error?.message || 'Không đọc được lịch sử Actor.'
        };
      }
    });

  const failed = reconciled.filter((item) => item.error);

  if (apply) {
    const ledgerKey = costLedgerKeys().ledger;
    const commands = [];
    for (const item of reconciled) {
      if (item.error) continue;
      const credential = item.credential;
      commands.push(['HSET', APIFY_POOL_COUNTERS_KEY, credential.id, String(item.dataRunsUsed)]);
      commands.push(['HSET', APIFY_SHOPEE_ACTOR_START_COUNTERS_KEY, credential.id, String(item.actorStarts)]);
      commands.push(['HSET', APIFY_SHOPEE_EMPTY_RUN_COUNTERS_KEY, credential.id, String(item.emptyRuns)]);
      const exhaustedKey = `${credential.billingAccountId || credential.id}:${resolvedActorId}`;
      if (item.actorExhausted) commands.push(['HSET', APIFY_SHOPEE_ACTOR_EXHAUSTED_KEY, exhaustedKey, JSON.stringify({
        exhaustedAt: item.actorExhaustedAt || new Date().toISOString(),
        maxUsesPerKey: DEFAULT_MAX_USES_PER_KEY
      })]);
      else commands.push(['HDEL', APIFY_SHOPEE_ACTOR_EXHAUSTED_KEY, exhaustedKey]);
      if (item.dataRunsUsed >= DEFAULT_MAX_USES_PER_KEY || item.actorExhausted) {
        commands.push(['HSET', APIFY_POOL_USED_KEY, credential.id, JSON.stringify({
          id: credential.id,
          label: credential.label,
          star: credential.star,
          groupId: credential.groupId,
          groupLabel: credential.groupLabel,
          usageCount: item.dataRunsUsed,
          actorExhausted: item.actorExhausted,
          usedAt: item.actorExhaustedAt || new Date().toISOString(),
          reconciled: true
        })]);
      } else {
        commands.push(['HDEL', APIFY_POOL_USED_KEY, credential.id]);
      }
      for (const run of item.runs) {
        commands.push(['HSETNX', ledgerKey, run.runId, JSON.stringify({
          operationId: run.runId,
          platform: 'shopee',
          credentialId: credential.id,
          billingAccountId: credential.billingAccountId || credential.id,
          actorId: resolvedActorId,
          status: run.status,
          itemsBilled: run.itemCount,
          actorStarted: true,
          emptyDataset: run.emptyDataset,
          freeTierExhausted: run.freeTierExhausted,
          startupFeeMicroUsd: SHOPEE_ACTOR_STARTUP_FEE_MICRO_USD,
          totalCostMicroUsd: run.actualCostMicroUsd,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          reconciledHistorical: true
        })]);
      }
    }
    for (let offset = 0; offset < commands.length; offset += 100) {
      await redisTransaction(commands.slice(offset, offset + 100), options);
    }
  }

  const previousTotals = credentials.reduce((totals, credential) => ({
    dataRunsUsed: totals.dataRunsUsed + (Number(previousCounters[credential.id]) || 0),
    actorStarts: totals.actorStarts + (Number(previousActorStarts[credential.id]) || 0),
    emptyRuns: totals.emptyRuns + (Number(previousEmptyRuns[credential.id]) || 0)
  }), { dataRunsUsed: 0, actorStarts: 0, emptyRuns: 0 });
  const resultingTotals = reconciled.reduce((totals, item) => ({
    dataRunsUsed: totals.dataRunsUsed + (item.error
      ? Number(previousCounters[item.credential.id]) || 0
      : item.dataRunsUsed),
    actorStarts: totals.actorStarts + (item.error
      ? Number(previousActorStarts[item.credential.id]) || 0
      : item.actorStarts),
    emptyRuns: totals.emptyRuns + (item.error
      ? Number(previousEmptyRuns[item.credential.id]) || 0
      : item.emptyRuns)
  }), { dataRunsUsed: 0, actorStarts: 0, emptyRuns: 0 });

  return {
    applied: Boolean(apply),
    actorId: resolvedActorId,
    totals: {
      credentials: reconciled.length,
      reconciledCredentials: reconciled.length - failed.length,
      preservedFailedCredentials: failed.length,
      actorStarts: reconciled.reduce((sum, item) => sum + item.actorStarts, 0),
      dataRunsUsed: reconciled.reduce((sum, item) => sum + item.dataRunsUsed, 0),
      emptyRuns: reconciled.reduce((sum, item) => sum + item.emptyRuns, 0),
      actorExhausted: reconciled.filter((item) => item.actorExhausted).length,
      failedCredentials: failed.length,
      previousAccounting: previousTotals,
      resultingAccounting: resultingTotals,
      historicalCostMicroUsd: reconciled.reduce((sum, item) => sum + item.historicalCostMicroUsd, 0)
    },
    credentials: reconciled.map((item) => ({
      id: item.credential.id,
      label: item.credential.label,
      previousDataRunsUsed: Number(previousCounters[item.credential.id]) || 0,
      previousActorStarts: Number(previousActorStarts[item.credential.id]) || 0,
      previousEmptyRuns: Number(previousEmptyRuns[item.credential.id]) || 0,
      actorStarts: item.actorStarts,
      dataRunsUsed: item.dataRunsUsed,
      emptyRuns: item.emptyRuns,
      actorExhausted: item.actorExhausted,
      historicalCostMicroUsd: item.historicalCostMicroUsd,
      error: item.error || null
    }))
  };
}

export async function reconcileTikTokActorHistory({ apply = false, actorConfigs, ...options } = {}) {
  if (!isRedisConfigured()) throw new Error('Chưa cấu hình Upstash Redis.');
  if (!process.env.APIFY_TOKEN_VAULT_KEY) throw new Error('Chưa cấu hình APIFY_TOKEN_VAULT_KEY.');
  const config = await readPoolConfig(options);
  if (!config) throw new Error('Pool Apify chưa được cấu hình.');
  const configuredActors = Array.isArray(actorConfigs) && actorConfigs.length ? actorConfigs : [
    {
      actorId: process.env.APIFY_TIKTOK_ACTOR_ID || TIKTOK_DEFAULT_ACTOR_ID,
      pricingVersion: 'web-wanderer-2026-08',
      startupFeeMicroUsd: Number(process.env.TIKTOK_DEFAULT_STARTUP_FEE_MICRO_USD) || 0,
      itemCostMicroUsd: Number(process.env.TIKTOK_DEFAULT_USAGE_MICRO_USD_PER_REVIEW)
        || TIKTOK_DEFAULT_USAGE_MICRO_USD_PER_REVIEW
    },
    {
      actorId: process.env.APIFY_TIKTOK_TEMPORARY_ACTOR_ID || TIKTOK_TEMPORARY_ACTOR_ID,
      pricingVersion: 'vistics-pay-per-event-2026-09',
      startupFeeMicroUsd: Number(process.env.TIKTOK_TEMPORARY_STARTUP_FEE_MICRO_USD)
        || TIKTOK_TEMPORARY_STARTUP_FEE_MICRO_USD,
      itemCostMicroUsd: Number(process.env.TIKTOK_TEMPORARY_USAGE_MICRO_USD_PER_REVIEW)
        || TIKTOK_TEMPORARY_USAGE_MICRO_USD_PER_REVIEW
    }
  ];
  const actors = [...new Map(configuredActors.map((actor) => [String(actor.actorId), {
    actorId: String(actor.actorId),
    pricingVersion: String(actor.pricingVersion || 'historical'),
    startupFeeMicroUsd: Math.max(0, Number(actor.startupFeeMicroUsd) || 0),
    itemCostMicroUsd: Math.max(0, Number(actor.itemCostMicroUsd) || 0)
  }])).values()];
  const credentials = (config.groups || []).flatMap((group) => group.credentials.map((credential) => ({
    ...credential,
    groupId: group.id,
    groupLabel: group.label
  })));
  const [previousStartsReply, previousEmptyReply, previousItemsReply] = await redisTransaction([
    ['HGETALL', APIFY_TIKTOK_ACTOR_START_COUNTERS_KEY],
    ['HGETALL', APIFY_TIKTOK_EMPTY_RUN_COUNTERS_KEY],
    ['HGETALL', APIFY_TIKTOK_BILLED_ITEM_COUNTERS_KEY]
  ], options);
  const previousStarts = parseHashReply(previousStartsReply);
  const previousEmpty = parseHashReply(previousEmptyReply);
  const previousItems = parseHashReply(previousItemsReply);
  const reconciled = await mapWithConcurrency(credentials,
    Math.max(1, Math.min(8, Number(options.accountConcurrency) || 4)),
    async (credential) => {
      try {
        const histories = await Promise.all(actors.map(async (actor) => ({
          actor,
          runs: await readApifyActorHistory(credential, actor.actorId, {
            ...options,
            fallbackCostMicroUsd: ({ itemCount }) => actor.startupFeeMicroUsd + itemCount * actor.itemCostMicroUsd
          })
        })));
        const runs = histories.flatMap(({ actor, runs: actorRuns }) => actorRuns.map((run) => ({ ...run, actor })));
        return {
          credential,
          runs,
          actorStarts: runs.length,
          emptyRuns: runs.filter((run) => run.emptyDataset).length,
          billedItems: runs.reduce((sum, run) => sum + run.itemCount, 0),
          historicalCostMicroUsd: runs.reduce((sum, run) => sum + run.actualCostMicroUsd, 0),
          actors: histories.map(({ actor, runs: actorRuns }) => ({
            actorId: actor.actorId,
            actorStarts: actorRuns.length,
            emptyRuns: actorRuns.filter((run) => run.emptyDataset).length,
            billedItems: actorRuns.reduce((sum, run) => sum + run.itemCount, 0),
            historicalCostMicroUsd: actorRuns.reduce((sum, run) => sum + run.actualCostMicroUsd, 0)
          }))
        };
      } catch (error) {
        return {
          credential,
          runs: [],
          actorStarts: 0,
          emptyRuns: 0,
          billedItems: 0,
          historicalCostMicroUsd: 0,
          actors: [],
          error: error?.message || 'Không đọc được lịch sử TikTok Actor.'
        };
      }
    });
  const failed = reconciled.filter((item) => item.error);

  if (apply) {
    const ledgerKey = costLedgerKeys().ledger;
    const commands = [];
    for (const item of reconciled) {
      if (item.error) continue;
      const credential = item.credential;
      commands.push(['HSET', APIFY_TIKTOK_ACTOR_START_COUNTERS_KEY, credential.id, String(item.actorStarts)]);
      commands.push(['HSET', APIFY_TIKTOK_EMPTY_RUN_COUNTERS_KEY, credential.id, String(item.emptyRuns)]);
      commands.push(['HSET', APIFY_TIKTOK_BILLED_ITEM_COUNTERS_KEY, credential.id, String(item.billedItems)]);
      for (const run of item.runs) {
        commands.push(['HSETNX', ledgerKey, run.runId, JSON.stringify({
          operationId: run.runId,
          platform: 'tiktok',
          credentialId: credential.id,
          billingAccountId: credential.billingAccountId || credential.id,
          actorId: run.actor.actorId,
          pricingVersion: run.actor.pricingVersion,
          status: run.status,
          itemsBilled: run.itemCount,
          actorStarted: true,
          emptyDataset: run.emptyDataset,
          startupFeeMicroUsd: run.actor.startupFeeMicroUsd,
          itemCostMicroUsd: run.actor.itemCostMicroUsd,
          totalCostMicroUsd: run.actualCostMicroUsd,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          reconciledHistorical: true
        })]);
      }
    }
    for (let offset = 0; offset < commands.length; offset += 100) {
      await redisTransaction(commands.slice(offset, offset + 100), options);
    }
  }

  const previousAccounting = credentials.reduce((totals, credential) => ({
    actorStarts: totals.actorStarts + (Number(previousStarts[credential.id]) || 0),
    emptyRuns: totals.emptyRuns + (Number(previousEmpty[credential.id]) || 0),
    billedItems: totals.billedItems + (Number(previousItems[credential.id]) || 0)
  }), { actorStarts: 0, emptyRuns: 0, billedItems: 0 });
  const resultingAccounting = reconciled.reduce((totals, item) => ({
    actorStarts: totals.actorStarts + (item.error ? Number(previousStarts[item.credential.id]) || 0 : item.actorStarts),
    emptyRuns: totals.emptyRuns + (item.error ? Number(previousEmpty[item.credential.id]) || 0 : item.emptyRuns),
    billedItems: totals.billedItems + (item.error ? Number(previousItems[item.credential.id]) || 0 : item.billedItems)
  }), { actorStarts: 0, emptyRuns: 0, billedItems: 0 });
  const actorTotals = actors.map((actor) => reconciled.reduce((totals, item) => {
    const values = item.actors.find((entry) => entry.actorId === actor.actorId);
    return {
      actorId: actor.actorId,
      actorStarts: totals.actorStarts + (values?.actorStarts || 0),
      emptyRuns: totals.emptyRuns + (values?.emptyRuns || 0),
      billedItems: totals.billedItems + (values?.billedItems || 0),
      historicalCostMicroUsd: totals.historicalCostMicroUsd + (values?.historicalCostMicroUsd || 0)
    };
  }, { actorId: actor.actorId, actorStarts: 0, emptyRuns: 0, billedItems: 0, historicalCostMicroUsd: 0 }));

  return {
    applied: Boolean(apply),
    actorIds: actors.map((actor) => actor.actorId),
    totals: {
      credentials: reconciled.length,
      reconciledCredentials: reconciled.length - failed.length,
      preservedFailedCredentials: failed.length,
      actorStarts: reconciled.reduce((sum, item) => sum + item.actorStarts, 0),
      emptyRuns: reconciled.reduce((sum, item) => sum + item.emptyRuns, 0),
      billedItems: reconciled.reduce((sum, item) => sum + item.billedItems, 0),
      failedCredentials: failed.length,
      previousAccounting,
      resultingAccounting,
      historicalCostMicroUsd: reconciled.reduce((sum, item) => sum + item.historicalCostMicroUsd, 0)
    },
    actors: actorTotals,
    credentials: reconciled.map((item) => ({
      id: item.credential.id,
      label: item.credential.label,
      actorStarts: item.actorStarts,
      emptyRuns: item.emptyRuns,
      billedItems: item.billedItems,
      historicalCostMicroUsd: item.historicalCostMicroUsd,
      actors: item.actors,
      error: item.error || null
    }))
  };
}

async function runShopeeLifetimeProbe(credential, actorId, productUrl, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const token = decryptToken(credential).trim();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const actor = encodeURIComponent(String(actorId).replace('/', '~'));
  const timeoutMs = Math.max(15_000, Number(options.timeoutMs) || 90_000);
  try {
    const startResponse = await fetchImpl(`https://api.apify.com/v2/acts/${actor}/runs?waitForFinish=60`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        startUrls: [{ url: productUrl }],
        contentFilter: 'with comments',
        maxReviewsPerProduct: 1
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!startResponse.ok) {
      return {
        accepted: false,
        httpStatus: startResponse.status,
        error: (await startResponse.text()).replace(/\s+/g, ' ').trim().slice(0, 300)
      };
    }
    const startBody = await startResponse.json();
    let run = startBody?.data && typeof startBody.data === 'object' ? startBody.data : startBody;
    const runId = String(run?.id || '');
    if (!runId) return { accepted: true, httpStatus: startResponse.status, error: 'Apify không trả về runId.' };
    const deadline = Date.now() + timeoutMs;
    while (!new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']).has(String(run.status || '').toUpperCase())) {
      if (Date.now() >= deadline) return { accepted: true, runId, status: 'WAIT_TIMEOUT' };
      const statusResponse = await fetchImpl(`https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}?waitForFinish=20`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(Math.max(5_000, deadline - Date.now()))
      });
      if (!statusResponse.ok) return { accepted: true, runId, status: 'STATUS_READ_FAILED', httpStatus: statusResponse.status };
      const statusBody = await statusResponse.json();
      run = statusBody?.data && typeof statusBody.data === 'object' ? statusBody.data : statusBody;
    }
    let itemCount = 0;
    let freeTierExhausted = false;
    if (run.defaultDatasetId) {
      const datasetResponse = await fetchImpl(`https://api.apify.com/v2/datasets/${encodeURIComponent(run.defaultDatasetId)}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20_000)
      });
      if (datasetResponse.ok) itemCount = Math.max(0, Number((await datasetResponse.json())?.data?.itemCount) || 0);
    }
    if (itemCount === 0) {
      const logResponse = await fetchImpl(`https://api.apify.com/v2/logs/${encodeURIComponent(runId)}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20_000)
      });
      if (logResponse.ok) freeTierExhausted = /free\s+tier\s+limit\s+reached/i.test(await logResponse.text());
    }
    return {
      accepted: true,
      httpStatus: startResponse.status,
      runId,
      status: String(run.status || ''),
      itemCount,
      freeTierExhausted,
      actualCostMicroUsd: Number.isFinite(Number(run.usageTotalUsd))
        ? Math.round(Number(run.usageTotalUsd) * 1_000_000)
        : null
    };
  } catch (error) {
    return { accepted: false, error: error?.message || 'Không chạy được phép thử Shopee.' };
  }
}

export async function testShopeeActorLifetimeLimit({ productUrl, actorId, count = 2, execute = true, ...options } = {}) {
  if (!isRedisConfigured()) throw new Error('Chưa cấu hình Upstash Redis.');
  if (!process.env.APIFY_TOKEN_VAULT_KEY) throw new Error('Chưa cấu hình APIFY_TOKEN_VAULT_KEY.');
  const url = String(productUrl || '').trim();
  if (!/^https:\/\/(?:[^/]+\.)?shopee\.vn\//i.test(url)) throw new Error('URL Shopee thử nghiệm không hợp lệ.');
  const config = await readPoolConfig(options);
  if (!config) throw new Error('Pool Apify chưa được cấu hình.');
  const resolvedActorId = String(actorId || process.env.APIFY_ACTOR_ID || 'zen-studio/shopee-product-reviews-scraper');
  const credentials = (config.groups || []).flatMap((group, groupIndex) => group.credentials.map((credential, credentialIndex) => ({
    ...credential,
    groupId: group.id,
    groupLabel: group.label,
    poolOrder: groupIndex * APIFY_STARS.length + credentialIndex
  })));
  const histories = await mapWithConcurrency(credentials, 8, async (credential) => {
    try {
      const runs = await readApifyActorHistory(credential, resolvedActorId, options);
      const chronological = [...runs].sort((left, right) => Date.parse(left.startedAt || '') - Date.parse(right.startedAt || ''));
      return {
        credential,
        actorStarts: runs.length,
        dataRunsUsed: runs.filter((run) => run.status === 'SUCCEEDED' && run.itemCount > 0).length,
        tenthRunAt: chronological[9]?.startedAt || null,
        latestRunAt: chronological.at(-1)?.startedAt || null
      };
    } catch (error) {
      return { credential, error: error?.message || 'Không đọc được lịch sử Actor.' };
    }
  });
  const requested = Math.max(1, Math.min(2, Number(count) || 2));
  const eligible = histories.filter((item) => !item.error && item.dataRunsUsed >= 10);
  const exactTen = eligible.filter((item) => item.dataRunsUsed === 10);
  const candidates = (exactTen.length >= requested ? exactTen : eligible)
    .sort((left, right) => right.credential.poolOrder - left.credential.poolOrder)
    .slice(0, requested);
  if (candidates.length < requested) throw new Error(`Chỉ tìm thấy ${candidates.length} credential đã đạt ít nhất 10 lần chạy.`);
  const probes = await Promise.all(candidates.map(async (candidate) => ({
    id: candidate.credential.id,
    label: candidate.credential.label,
    previousActorStarts: candidate.actorStarts,
    previousDataRunsUsed: candidate.dataRunsUsed,
    attemptedActorRunNumber: candidate.actorStarts + 1,
    attemptedLifetimeUseNumber: candidate.dataRunsUsed + 1,
    tenthRunAt: candidate.tenthRunAt,
    result: execute ? await runShopeeLifetimeProbe(candidate.credential, resolvedActorId, url, options) : null
  })));
  return { executed: Boolean(execute), actorId: resolvedActorId, productUrl: url, probes };
}

export async function inspectShopeeCredentialHistory({ credentialIds, credentialLabels, actorId, ...options } = {}) {
  const ids = new Set((Array.isArray(credentialIds) ? credentialIds : []).map(String));
  const labels = new Set((Array.isArray(credentialLabels) ? credentialLabels : []).map(String));
  const requested = ids.size + labels.size;
  if (!requested || requested > 2) throw new Error('Cần cung cấp từ một đến hai credential để kiểm tra.');
  const config = await readPoolConfig(options);
  if (!config) throw new Error('Pool Apify chưa được cấu hình.');
  const resolvedActorId = String(actorId || process.env.APIFY_ACTOR_ID || 'zen-studio/shopee-product-reviews-scraper');
  const credentials = (config.groups || []).flatMap((group) => group.credentials)
    .filter((credential) => ids.has(credential.id) || labels.has(credential.label));
  if (credentials.length < requested) throw new Error('Không tìm thấy đủ credential cần kiểm tra trong pool.');
  const results = await Promise.all(credentials.map(async (credential) => {
    const runs = await readApifyActorHistory(credential, resolvedActorId, options);
    const ordered = [...runs].sort((left, right) => Date.parse(right.startedAt || '') - Date.parse(left.startedAt || ''));
    return {
      id: credential.id,
      label: credential.label,
      actorStarts: runs.length,
      dataRunsUsed: runs.filter((run) => run.status === 'SUCCEEDED' && run.itemCount > 0).length,
      latestRuns: ordered.slice(0, 3)
    };
  }));
  return { actorId: resolvedActorId, credentials: results };
}
