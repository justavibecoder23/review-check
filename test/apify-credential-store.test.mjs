import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APIFY_POOL_COUNTERS_KEY,
  APIFY_POOL_KEY,
  APIFY_POOL_USED_KEY,
  APIFY_COST_LEDGER_PREFIX,
  APIFY_SHOPEE_ACTOR_START_COUNTERS_KEY,
  APIFY_SHOPEE_EMPTY_RUN_COUNTERS_KEY,
  APIFY_SHOPEE_ACTOR_EXHAUSTED_KEY,
  APIFY_TIKTOK_REVIEW_COUNTERS_KEY,
  APIFY_TIKTOK_ACTOR_START_COUNTERS_KEY,
  APIFY_TIKTOK_EMPTY_RUN_COUNTERS_KEY,
  APIFY_TIKTOK_BILLED_ITEM_COUNTERS_KEY,
  APIFY_TIKTOK_RESERVED_REVIEWS_KEY,
  APIFY_TIKTOK_RUN_COUNTERS_KEY,
  APIFY_TIKTOK_FINALIZED_RESERVATIONS_KEY,
  APIFY_TIKTOK_USED_KEY,
  DEFAULT_MAX_USES_PER_KEY,
  finalizeShopeeCostCredential,
  finalizeTikTokCredential,
  getApifyCredentialPoolStatus,
  reserveApifyCredential,
  reserveApifyCredentialSet,
  reserveShopeeCostCredentialSet,
  reserveTikTokCostCredentials,
  reserveTikTokCredentials,
  finalizeTikTokCostCredential,
  saveApifyCredentialPool
} from '../src/apify-credential-store.mjs';
import { SHOPEE_CACHE_HITS_KEY, SHOPEE_TOTAL_SERVED_KEY } from '../src/product-cache.mjs';

function flattenHash(hash) {
  return Object.entries(hash).flat();
}

function createRedisFake() {
  const values = new Map();
  const hashes = new Map();
  let evalCalls = 0;
  function hash(key) {
    if (!hashes.has(key)) hashes.set(key, {});
    return hashes.get(key);
  }
  function reservationState(raw, nowMs = Date.now()) {
    let state = { leases: {} };
    try {
      const parsed = JSON.parse(raw || '');
      if (parsed?.leases) state = parsed;
    } catch {
      const legacy = Math.max(0, Number(raw) || 0);
      if (legacy) state.leases.legacy = { amount: legacy, expiresAtMs: nowMs + 180_000 };
    }
    for (const [id, lease] of Object.entries(state.leases)) {
      if (Number(lease.expiresAtMs) <= nowMs) delete state.leases[id];
    }
    return state;
  }
  function reservedTotal(state) {
    return Object.values(state.leases).reduce((sum, lease) => sum + Math.max(0, Number(lease.amount) || 0), 0);
  }
  function execute(command) {
    if (command[0] === 'GET') return values.get(command[1]) ?? null;
    if (command[0] === 'SET') {
      values.set(command[1], command[2]);
      return 'OK';
    }
    if (command[0] === 'HGETALL') return flattenHash(hash(command[1]));
    if (command[0] === 'EVAL') {
      evalCalls += 1;
      const config = JSON.parse(values.get(APIFY_POOL_KEY));
      const maxUsesPerKey = DEFAULT_MAX_USES_PER_KEY;
      const counters = hash(APIFY_POOL_COUNTERS_KEY);
      const used = hash(APIFY_POOL_USED_KEY);
      if (String(command[1]).includes('TIKTOK_COST_FINALIZATION_V4')) {
        const spent = hash(command[3]);
        const reserved = hash(command[4]);
        const ledger = hash(command[5]);
        const actorStarts = hash(APIFY_TIKTOK_ACTOR_START_COUNTERS_KEY);
        const emptyRuns = hash(APIFY_TIKTOK_EMPTY_RUN_COUNTERS_KEY);
        const billedItems = hash(APIFY_TIKTOK_BILLED_ITEM_COUNTERS_KEY);
        const accountCycleId = command[12];
        const credentialId = command[13];
        const reservationId = command[14];
        const operationId = command[15];
        if (ledger[operationId]) return JSON.stringify({ ok: true, alreadyFinalized: true });
        const reviews = Number(command[16]);
        const statusCode = Number(command[17]);
        const actorStarted = command[24] === '1';
        const state = JSON.parse(reserved[accountCycleId] || '{"leases":{}}');
        const lease = state.leases[reservationId];
        delete state.leases[reservationId];
        reserved[accountCycleId] = JSON.stringify(state);
        const costMicroUsd = statusCode >= 200 && statusCode < 300
          ? Number(lease.startupFeeMicroUsd) + reviews * Number(lease.itemCostMicroUsd)
          : 0;
        spent[accountCycleId] = String(Number(spent[accountCycleId] || 0) + costMicroUsd);
        if (actorStarted) actorStarts[credentialId] = String(Number(actorStarts[credentialId] || 0) + 1);
        if (actorStarted && statusCode >= 200 && statusCode < 300 && reviews === 0) {
          emptyRuns[credentialId] = String(Number(emptyRuns[credentialId] || 0) + 1);
        }
        if (statusCode >= 200 && statusCode < 300 && reviews > 0) {
          billedItems[credentialId] = String(Number(billedItems[credentialId] || 0) + reviews);
        }
        ledger[operationId] = JSON.stringify({ accountCycleId, costMicroUsd });
        return JSON.stringify({ ok: true, alreadyFinalized: false, costMicroUsd });
      }
      if (String(command[1]).includes('TIKTOK_COST_RESERVATION_V4')) {
        const desired = Number(command[16]);
        const requested = Number(command[17]);
        const nowMs = Number(command[18]);
        const leaseMs = Number(command[19]);
        const shopeeRunCost = Number(command[21]);
        const itemCost = Number(command[22]);
        const startupFee = Number(command[23]);
        const actorId = command[24];
        const pricingVersion = command[25];
        const requestId = command[27];
        const maxShopeeUses = Number(command[29]);
        const cycles = JSON.parse(command[30]);
        const spent = hash(command[5]);
        const reserved = hash(command[6]);
        const candidates = config.groups.flatMap((group) => group.credentials.map((credential) => ({ credential, group })))
          .filter(({ credential }) => cycles[credential.id])
          .slice(0, desired);
        if (candidates.length < desired) return JSON.stringify({ ok: false, code: 'INSUFFICIENT_BUDGET_OR_KEYS' });
        return JSON.stringify({
          ok: true,
          source: 'redis-vault-cost-ledger-v4',
          credentials: candidates.map(({ credential, group }, index) => {
            const cycle = cycles[credential.id];
            const reservationId = `${requestId}:${index + 1}`;
            const plannedCostMicroUsd = startupFee + requested * itemCost;
            const state = JSON.parse(reserved[cycle.accountCycleId] || '{"leases":{}}');
            state.leases[reservationId] = { costMicroUsd: plannedCostMicroUsd, startupFeeMicroUsd: startupFee, itemCostMicroUsd: itemCost, actorId, pricingVersion, expiresAtMs: nowMs + leaseMs };
            reserved[cycle.accountCycleId] = JSON.stringify(state);
            spent[cycle.accountCycleId] = String(cycle.observedSpentMicroUsd);
            return {
              ...credential,
              groupId: group.id,
              groupLabel: group.label,
              billingAccountId: cycle.billingAccountId,
              accountCycleId: cycle.accountCycleId,
              billingCycleStartAt: cycle.cycleStartAt,
              billingCycleEndAt: cycle.cycleEndAt,
              runCount: 1,
              plannedReviews: requested,
              plannedCostMicroUsd,
              spentMicroUsd: cycle.observedSpentMicroUsd,
              reservedMicroUsd: plannedCostMicroUsd,
              shopeeReservedMicroUsd: Math.max(0, maxShopeeUses - Number(counters[credential.id] || 0)) * shopeeRunCost,
              reservationId,
              reservationExpiresAtMs: nowMs + leaseMs
            };
          })
        });
      }
      if (String(command[1]).includes('SHOPEE_LIFETIME_AND_COST_FINALIZATION_V5')) {
        const spent = hash(command[6]);
        const reserved = hash(command[7]);
        const ledger = hash(command[8]);
        const actorStarts = hash(APIFY_SHOPEE_ACTOR_START_COUNTERS_KEY);
        const emptyRuns = hash(APIFY_SHOPEE_EMPTY_RUN_COUNTERS_KEY);
        const actorExhausted = hash(APIFY_SHOPEE_ACTOR_EXHAUSTED_KEY);
        const accountCycleId = command[15];
        const credentialId = command[16];
        const reservationId = command[17];
        const operationId = command[18];
        if (ledger[operationId]) return JSON.stringify({ ok: true, alreadyFinalized: true });
        const statusCode = Number(command[20]);
        const reviewCount = Number(command[19]);
        const billingAccountId = command[30];
        const actorStarted = command[33] === '1';
        const freeTierExhausted = command[34] === '1';
        const reportedCost = command[35] === '' ? null : Number(command[35]);
        const state = JSON.parse(reserved[accountCycleId] || '{"leases":{}}');
        const lease = state.leases[reservationId];
        delete state.leases[reservationId];
        reserved[accountCycleId] = JSON.stringify(state);
        let usageCount = Number(counters[credentialId] || 0);
        let costMicroUsd = 0;
        if (actorStarted) actorStarts[credentialId] = String(Number(actorStarts[credentialId] || 0) + 1);
        if (statusCode >= 200 && statusCode < 300 && reviewCount === 0) {
          emptyRuns[credentialId] = String(Number(emptyRuns[credentialId] || 0) + 1);
        }
        if (statusCode >= 200 && statusCode < 300 && reviewCount > 0) {
          usageCount += 1;
          counters[credentialId] = String(usageCount);
        }
        if (actorStarted) {
          costMicroUsd = reportedCost ?? (Number(lease.startupFeeMicroUsd || 0) + Math.min(reviewCount, 20) * Number(lease.itemCostMicroUsd));
          spent[accountCycleId] = String(Number(spent[accountCycleId] || 0) + costMicroUsd);
        }
        if (freeTierExhausted) actorExhausted[`${billingAccountId}:${lease.actorId}`] = JSON.stringify({
          exhaustedAt: Date.now(),
          maxUsesPerKey: DEFAULT_MAX_USES_PER_KEY
        });
        ledger[operationId] = JSON.stringify({ credentialId, accountCycleId, usageCount, costMicroUsd });
        return JSON.stringify({ ok: true, alreadyFinalized: false, usageCount, costMicroUsd });
      }
      if (String(command[1]).includes('SHOPEE_LIFETIME_AND_COST_RESERVATION_V4')) {
        const desired = Number(command[17]);
        const stars = JSON.parse(command[18]);
        const nowMs = Number(command[19]);
        const leaseMs = Number(command[20]);
        const runCost = Number(command[22]);
        const itemCost = Number(command[23]);
        const startupFee = Number(command[24]);
        const actorId = command[25];
        const pricingVersion = command[26];
        const requestId = command[27];
        const maxUses = Number(command[29]);
        const cycles = JSON.parse(command[32]);
        const reserved = hash(command[8]);
        const spent = hash(command[7]);
        const exhausted = hash(`${APIFY_COST_LEDGER_PREFIX}:exhausted`);
        const candidates = config.groups.flatMap((group) => group.credentials.map((credential) => ({ credential, group })))
          .filter(({ credential }) => cycles[credential.id]
            && !exhausted[cycles[credential.id].accountCycleId]
            && Number(counters[credential.id] || 0) < maxUses)
          .slice(0, desired);
        if (candidates.length < desired) return JSON.stringify({
          ok: false,
          code: 'SHOPEE_LIFETIME_OR_BUDGET_EXHAUSTED',
          available: candidates.length,
          requested: desired
        });
        return JSON.stringify({
          ok: true,
          source: 'redis-vault-cost-ledger-v4',
          groupId: candidates[0].group.id,
          groupLabel: candidates[0].group.label,
          maxUsesPerKey: maxUses,
          reservedAt: command[31],
          credentials: candidates.map(({ credential, group }, index) => {
            const cycle = cycles[credential.id];
            const cycleId = cycle.accountCycleId;
            const reservationId = `${requestId}:${index + 1}`;
            const state = JSON.parse(reserved[cycleId] || '{"leases":{}}');
            state.leases[reservationId] = { costMicroUsd: runCost, startupFeeMicroUsd: startupFee, itemCostMicroUsd: itemCost, plannedReviews: 20, actorId, pricingVersion, expiresAtMs: nowMs + leaseMs };
            reserved[cycleId] = JSON.stringify(state);
            spent[cycleId] = String(cycle.observedSpentMicroUsd);
            return {
              ...credential,
              star: stars[index],
              poolStar: credential.star,
              poolGroupId: group.id,
              poolGroupLabel: group.label,
              billingAccountId: cycle.billingAccountId,
              accountCycleId: cycleId,
              billingCycleStartAt: cycle.cycleStartAt,
              billingCycleEndAt: cycle.cycleEndAt,
              usageCount: Number(counters[credential.id] || 0),
              reservedUsageCount: 1,
              remainingLifetimeUses: maxUses - Number(counters[credential.id] || 0) - 1,
              plannedReviews: 20,
              plannedCostMicroUsd: runCost,
              spentMicroUsd: cycle.observedSpentMicroUsd,
              reservedMicroUsd: runCost,
              reservationId,
              reservationExpiresAtMs: nowMs + leaseMs
            };
          })
        });
      }
      if (String(command[1]).includes('TIKTOK_CREDENTIAL_FINALIZATION')) {
        const reviews = hash(APIFY_TIKTOK_REVIEW_COUNTERS_KEY);
        const reserved = hash(APIFY_TIKTOK_RESERVED_REVIEWS_KEY);
        const tiktokUsed = hash(APIFY_TIKTOK_USED_KEY);
        const finalized = hash(APIFY_TIKTOK_FINALIZED_RESERVATIONS_KEY);
        const planned = Number(command[7]);
        const actual = Number(command[8]);
        const maxReviews = Number(command[9]);
        const exhausted = command[10] === '1';
        const id = command[11];
        const reservationId = command[14];
        const nowMs = Number(command[15]);
        if (reservationId && finalized[reservationId]) {
          const reviewCount = Number(reviews[id] || 0);
          return JSON.stringify({ ok: true, reviewCount, exhausted: reviewCount >= maxReviews, alreadyFinalized: true });
        }
        const state = reservationState(reserved[id], nowMs);
        if (reservationId) delete state.leases[reservationId];
        reserved[id] = JSON.stringify(state);
        let reviewCount = Number(reviews[id] || 0) + actual;
        if (exhausted) reviewCount = maxReviews;
        reviews[id] = String(reviewCount);
        if (reviewCount >= maxReviews) {
          tiktokUsed[id] = JSON.stringify({ id, label: command[12], reviewCount, maxReviewsPerKey: maxReviews, usedAt: command[13] });
        }
        if (reservationId) finalized[reservationId] = command[13];
        return JSON.stringify({ ok: true, reviewCount, exhausted: reviewCount >= maxReviews, alreadyFinalized: false });
      }
      if (String(command[1]).includes('TIKTOK_CREDENTIAL_RESERVATION')) {
        const runs = hash(APIFY_TIKTOK_RUN_COUNTERS_KEY);
        const reviews = hash(APIFY_TIKTOK_REVIEW_COUNTERS_KEY);
        const reserved = hash(APIFY_TIKTOK_RESERVED_REVIEWS_KEY);
        const shopeeCounters = hash(APIFY_POOL_COUNTERS_KEY);
        const desired = Number(command[8]);
        const requestedPerKey = Number(command[9]);
        const maxReviews = Number(command[10]);
        const nowMs = Number(command[12]);
        const freeUsage = Number(command[13]);
        const shopeeRunCost = Number(command[14]);
        const tiktokCostPerReview = Number(command[15]);
        const shopeeMaxUses = Number(command[16]);
        const shopeeReviewsPerRun = Number(command[17]);
        const leaseMs = Number(command[18]);
        const candidates = config.groups.flatMap((group) => group.credentials.map((credential) => ({ credential, group })))
          .filter(({ credential }) => {
            const state = reservationState(reserved[credential.id], nowMs);
            reserved[credential.id] = JSON.stringify(state);
            const completed = Number(reviews[credential.id] || 0);
            const held = reservedTotal(state);
            const shopeeUses = Math.min(shopeeMaxUses, Number(shopeeCounters[credential.id] || 0));
            const shopeeBudget = shopeeMaxUses * shopeeRunCost;
            const usageCapacity = Math.floor((freeUsage - shopeeBudget - (completed + held) * tiktokCostPerReview) / tiktokCostPerReview);
            return completed + held < maxReviews && usageCapacity > 0;
          })
          .slice(0, desired);
        if (candidates.length < desired) return JSON.stringify({ ok: false, code: 'INSUFFICIENT_KEYS', available: candidates.length, requested: desired });
        return JSON.stringify({
          ok: true,
          source: 'redis-vault',
          maxReviewsPerKey: maxReviews,
          reservedAt: command[11],
          credentials: candidates.map(({ credential, group }) => {
            const currentReviews = Number(reviews[credential.id] || 0);
            const state = reservationState(reserved[credential.id], nowMs);
            const held = reservedTotal(state);
            const shopeeUses = Math.min(shopeeMaxUses, Number(shopeeCounters[credential.id] || 0));
            const shopeeReservedUsageMicroUsd = Math.max(0, shopeeMaxUses - shopeeUses) * shopeeRunCost;
            const plannedReviews = Math.min(requestedPerKey, maxReviews - currentReviews - held);
            runs[credential.id] = String(Number(runs[credential.id] || 0) + 1);
            const reservationId = `${credential.id}:${runs[credential.id]}:${nowMs}`;
            state.leases[reservationId] = { amount: plannedReviews, expiresAtMs: nowMs + leaseMs };
            reserved[credential.id] = JSON.stringify(state);
            return {
              ...credential,
              groupId: group.id,
              groupLabel: group.label,
              runCount: Number(runs[credential.id]),
              reviewCount: currentReviews,
              plannedReviews,
              reservedReviews: held + plannedReviews,
              shopeeUses,
              shopeeReservedUsageMicroUsd,
              reservationId,
              reservationExpiresAtMs: nowMs + leaseMs
            };
          })
        });
      }
      if (String(command[1]).includes('SINGLE_CREDENTIAL_RESERVATION')) {
        let selected;
        let credential;
        for (const group of config.groups) {
          credential = group.credentials.find((item) => Number(counters[item.id] || 0) < maxUsesPerKey);
          if (credential) {
            selected = group;
            break;
          }
        }
        if (!credential) return JSON.stringify({ ok: false, code: 'POOL_EXHAUSTED' });
        const usageCount = Number(counters[credential.id] || 0) + 1;
        counters[credential.id] = String(usageCount);
        const allocated = { ...credential, usageCount };
        const retiresAfterReservation = usageCount >= maxUsesPerKey;
        if (retiresAfterReservation) {
          used[credential.id] = JSON.stringify({
            id: credential.id,
            label: credential.label,
            star: credential.star,
            groupId: selected.id,
            groupLabel: selected.label,
            usageCount,
            usedAt: command.at(-1)
          });
        }
        return JSON.stringify({
          ok: true,
          source: 'redis-vault',
          groupId: selected.id,
          groupLabel: selected.label,
          maxUsesPerKey,
          credential: allocated,
          retiresAfterReservation,
          reservedAt: command.at(-1)
        });
      }
      const desired = Number(command[7]) || 5;
      const stars = JSON.parse(command[8] || '[5,4,3,2,1]');
      const activeGroupIndex = config.groups.findIndex((group) => group.credentials.some((credential) => Number(counters[credential.id] || 0) < maxUsesPerKey));
      if (activeGroupIndex < 0) return JSON.stringify({ ok: false, code: 'POOL_EXHAUSTED' });
      const activeGroup = config.groups[activeGroupIndex];
      const selected = activeGroup.credentials
        .filter((credential) => Number(counters[credential.id] || 0) < maxUsesPerKey)
        .map((credential, index) => ({ credential, group: activeGroup, count: Number(counters[credential.id] || 0), order: index }))
        .sort((left, right) => left.count - right.count || left.order - right.order)
        .slice(0, desired);
      const reserveCandidates = config.groups.slice(activeGroupIndex + 1).flatMap((group, groupOffset) => group.credentials
        .filter((credential) => Number(counters[credential.id] || 0) < maxUsesPerKey)
        .map((credential, credentialIndex) => ({
          credential,
          group,
          count: Number(counters[credential.id] || 0),
          order: (groupOffset + 1) * 5 + credentialIndex
        })))
        .sort((left, right) => left.count - right.count || left.order - right.order);
      while (selected.length < desired && reserveCandidates.length) selected.push(reserveCandidates.shift());
      if (selected.length < desired) return JSON.stringify({ ok: false, code: 'POOL_EXHAUSTED' });
      const credentials = selected.map(({ credential, group }, index) => {
        const usageCount = Number(counters[credential.id] || 0) + 1;
        counters[credential.id] = String(usageCount);
        return {
          ...credential,
          poolStar: credential.star,
          star: stars[index],
          poolGroupId: group.id,
          poolGroupLabel: group.label,
          usageCount
        };
      });
      const retiresAfterReservation = credentials.some((credential) => credential.usageCount >= maxUsesPerKey);
      if (retiresAfterReservation) {
        for (const credential of credentials) {
          if (credential.usageCount < maxUsesPerKey) continue;
          used[credential.id] = JSON.stringify({
            id: credential.id,
            label: credential.label,
            star: credential.star,
            poolStar: credential.poolStar,
            groupId: credential.poolGroupId,
            groupLabel: credential.poolGroupLabel,
            usageCount: credential.usageCount,
            usedAt: command[6]
          });
        }
      }
      const mixedGroups = new Set(selected.map(({ group }) => group.id)).size > 1;
      return JSON.stringify({
        ok: true,
        source: 'redis-vault',
        groupId: mixedGroups ? 'mixed-available-keys' : activeGroup.id,
        groupLabel: mixedGroups ? 'mixed-available-keys' : activeGroup.label,
        maxUsesPerKey,
        credentials,
        retiresAfterReservation,
        reservedAt: command[6]
      });
    }
    throw new Error(`Redis fake không hỗ trợ ${command[0]}`);
  }
  return {
    values,
    hashes,
    get evalCalls() { return evalCalls; },
    async fetchImpl(url, init) {
      const payload = JSON.parse(init.body);
      if (url.endsWith('/multi-exec')) {
        return { ok: true, async json() { return payload.map((command) => ({ result: execute(command) })); } };
      }
      return { ok: true, async json() { return { result: execute(payload) }; } };
    }
  };
}

function group(label, prefix) {
  return {
    label,
    credentials: [5, 4, 3, 2, 1].map((star) => ({
      star,
      label: `${label}-${star}-star`,
      token: `apify_api_${prefix}_${star}_super_secret_token`
    }))
  };
}

test('pool mã hóa token, đếm nguyên tử và tự chuyển nhóm sau lượt thứ 20', async () => {
  const previous = {
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
    vault: process.env.APIFY_TOKEN_VAULT_KEY
  };
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-test-token';
  process.env.APIFY_TOKEN_VAULT_KEY = Buffer.alloc(32, 7).toString('base64');
  const redis = createRedisFake();
  try {
    const initial = await saveApifyCredentialPool({
      maxUsesPerKey: 20,
      groups: [group('primary', 'primary'), group('backup', 'backup')],
      pendingCredentials: [
        { label: 'pending-one', token: 'apify_api_pending_1_super_secret_token' },
        { label: 'pending-two', token: 'apify_api_pending_2_super_secret_token' }
      ]
    }, { fetchImpl: redis.fetchImpl });
    assert.equal(initial.active.label, 'primary');
    assert.equal(initial.reserve[0].label, 'backup');
    assert.equal(initial.pendingCount, 2);
    assert.equal(initial.neededForNextGroup, 3);
    const stored = redis.values.get(APIFY_POOL_KEY);
    assert.ok(stored);
    assert.equal(stored.includes('super_secret_token'), false);

    const completedPending = await saveApifyCredentialPool({
      maxUsesPerKey: 20,
      mode: 'append',
      groups: [],
      pendingCredentials: [
        { label: 'pending-three', token: 'apify_api_pending_3_super_secret_token' },
        { label: 'pending-four', token: 'apify_api_pending_4_super_secret_token' },
        { label: 'pending-five', token: 'apify_api_pending_5_super_secret_token' }
      ]
    }, { fetchImpl: redis.fetchImpl });
    assert.equal(completedPending.pendingCount, 0);
    assert.equal(completedPending.totals.groups, 3);
    assert.equal(completedPending.reserve.length, 2);

    let allocation;
    for (let use = 1; use <= 20; use += 1) {
      allocation = await reserveApifyCredentialSet({ fetchImpl: redis.fetchImpl });
      assert.equal(allocation.groupLabel, 'primary');
      assert.ok(allocation.credentials.every((credential) => credential.usageCount === use));
      assert.ok(allocation.credentials.every((credential) => credential.token.includes('primary')));
    }
    assert.equal(allocation.retiresAfterReservation, true);

    const rotated = await reserveApifyCredentialSet({ fetchImpl: redis.fetchImpl });
    assert.equal(rotated.groupLabel, 'backup');
    assert.ok(rotated.credentials.every((credential) => credential.usageCount === 1));
    assert.equal(redis.evalCalls, 21);

    redis.values.set(SHOPEE_CACHE_HITS_KEY, '7');
    redis.values.set(SHOPEE_TOTAL_SERVED_KEY, '10');
    const status = await getApifyCredentialPoolStatus({ fetchImpl: redis.fetchImpl });
    assert.equal(status.active.label, 'backup');
    assert.equal(status.used[0].label, 'primary');
    assert.equal(status.usedHistory.length, 5);
    assert.ok(status.used[0].credentials.every((credential) => credential.usageCount === 20));
    assert.deepEqual(status.platforms.shopee.cache, { hits: 7, totalServed: 10, hitRate: 0.7 });
    assert.equal(JSON.stringify(status).includes('super_secret_token'), false);

    await assert.rejects(
      saveApifyCredentialPool({
        maxUsesPerKey: 20,
        mode: 'replace',
        groups: [group('primary-reloaded', 'primary')]
      }, { fetchImpl: redis.fetchImpl }),
      /đã có lịch sử sử dụng/
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      const envKey = { url: 'UPSTASH_REDIS_REST_URL', token: 'UPSTASH_REDIS_REST_TOKEN', vault: 'APIFY_TOKEN_VAULT_KEY' }[key];
      if (value === undefined) delete process.env[envKey];
      else process.env[envKey] = value;
    }
  }
});

test('TikTok dùng chung token nhưng có bộ đếm review riêng, không trừ lượt Shopee', async () => {
  const previous = {
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
    vault: process.env.APIFY_TOKEN_VAULT_KEY
  };
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-test-token';
  process.env.APIFY_TOKEN_VAULT_KEY = Buffer.alloc(32, 7).toString('base64');
  const redis = createRedisFake();
  try {
    await saveApifyCredentialPool({ maxUsesPerKey: 10, groups: [group('primary', 'primary')] }, { fetchImpl: redis.fetchImpl });
    const allocation = await reserveTikTokCredentials({ count: 5, reviewsPerCredential: 40, fetchImpl: redis.fetchImpl });
    assert.equal(allocation.credentials.length, 5);
    assert.ok(allocation.credentials.every((credential) => credential.runCount === 1 && credential.plannedReviews === 40));
    await Promise.all(allocation.credentials.map((credential) => finalizeTikTokCredential(
      credential,
      { reviewCount: 40 },
      { fetchImpl: redis.fetchImpl }
    )));

    const status = await getApifyCredentialPoolStatus({ fetchImpl: redis.fetchImpl });
    assert.ok(status.active.credentials.every((credential) => credential.shopee.usageCount === 0));
    assert.ok(status.active.credentials.every((credential) => credential.tiktok.runCount === 1));
    assert.ok(status.active.credentials.every((credential) => credential.tiktok.reviewCount === 40));
    assert.ok(status.active.credentials.every((credential) => credential.tiktok.remainingReviews === 8_070));
    assert.equal(status.platforms.shopee.usedHistory.length, 0);
    assert.equal(status.platforms.tiktok.usedHistory.length, 0);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      const envKey = {
        url: 'UPSTASH_REDIS_REST_URL', token: 'UPSTASH_REDIS_REST_TOKEN',
        vault: 'APIFY_TOKEN_VAULT_KEY'
      }[key];
      if (value === undefined) delete process.env[envKey];
      else process.env[envKey] = value;
    }
  }
});

test('Shopee v4 lấy billing cycle từ Apify, giữ lượt trọn đời và finalize idempotent', async () => {
  const names = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'APIFY_TOKEN_VAULT_KEY'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-test-token';
  process.env.APIFY_TOKEN_VAULT_KEY = Buffer.alloc(32, 7).toString('base64');
  const redis = createRedisFake();
  try {
    await saveApifyCredentialPool({ maxUsesPerKey: 10, groups: [group('primary', 'primary')] }, { fetchImpl: redis.fetchImpl });
    const legacyPool = JSON.parse(redis.values.get(APIFY_POOL_KEY));
    redis.hashes.set(APIFY_SHOPEE_ACTOR_EXHAUSTED_KEY, Object.fromEntries(
      legacyPool.groups[0].credentials.map((credential) => [
        `${credential.billingAccountId}:zen-studio/shopee-product-reviews-scraper`,
        '2026-09-01T00:00:00.000Z'
      ])
    ));
    const allocation = await reserveShopeeCostCredentialSet({
      fetchImpl: redis.fetchImpl,
      usageFetchImpl: async () => ({
        ok: true,
        async json() {
          return { data: {
            usageCycle: { startAt: '2026-09-14T00:00:00.000Z', endAt: '2026-10-13T23:59:59.999Z' },
            totalUsageCreditsUsdAfterVolumeDiscount: 0.5
          } };
        }
      })
    });
    assert.equal(allocation.credentials.length, 5);
    assert.ok(allocation.credentials.every((item) => item.usageCount === 0));
    assert.ok(allocation.credentials.every((item) => item.billingCycleStartAt === '2026-09-14T00:00:00.000Z'));

    const credential = allocation.credentials[0];
    const first = await finalizeShopeeCostCredential(credential, {
      reviewCount: 20, statusCode: 200, operationId: 'shopee-run-1'
    }, { fetchImpl: redis.fetchImpl });
    const repeated = await finalizeShopeeCostCredential(credential, {
      reviewCount: 20, statusCode: 200, operationId: 'shopee-run-1'
    }, { fetchImpl: redis.fetchImpl });
    assert.equal(first.usageCount, 1);
    assert.equal(first.costMicroUsd, 87_800);
    assert.equal(repeated.alreadyFinalized, true);
    assert.equal(Number(redis.hashes.get(APIFY_POOL_COUNTERS_KEY)[credential.id]), 1);

    const emptyCredential = allocation.credentials[1];
    const empty = await finalizeShopeeCostCredential(emptyCredential, {
      reviewCount: 0,
      statusCode: 201,
      operationId: 'shopee-empty-run',
      actorStarted: true,
      actualCostMicroUsd: 8_000
    }, { fetchImpl: redis.fetchImpl });
    assert.equal(empty.usageCount, 0, 'dataset rỗng không được trừ lượt dữ liệu trọn đời');
    assert.equal(empty.costMicroUsd, 8_000, 'dataset rỗng vẫn hạch toán phí Actor start');
    assert.equal(Number(redis.hashes.get(APIFY_POOL_COUNTERS_KEY)[emptyCredential.id] || 0), 0);
    assert.equal(Number(redis.hashes.get(APIFY_SHOPEE_ACTOR_START_COUNTERS_KEY)[emptyCredential.id]), 1);
    assert.equal(Number(redis.hashes.get(APIFY_SHOPEE_EMPTY_RUN_COUNTERS_KEY)[emptyCredential.id]), 1);

    const exhaustedCredential = allocation.credentials[2];
    await finalizeShopeeCostCredential(exhaustedCredential, {
      reviewCount: 0,
      statusCode: 201,
      operationId: 'shopee-free-tier-run',
      actorStarted: true,
      freeTierExhausted: true,
      actualCostMicroUsd: 8_000
    }, { fetchImpl: redis.fetchImpl });
    assert.ok(redis.hashes.get(APIFY_SHOPEE_ACTOR_EXHAUSTED_KEY)[`${exhaustedCredential.billingAccountId}:zen-studio/shopee-product-reviews-scraper`]);

    const status = await getApifyCredentialPoolStatus({ fetchImpl: redis.fetchImpl });
    const emptyStatus = status.active.credentials.find((item) => item.id === emptyCredential.id);
    assert.equal(emptyStatus.shopee.dataRunsUsed, 0);
    assert.equal(emptyStatus.shopee.actorStartCount, 1);
    assert.equal(emptyStatus.shopee.emptyRunCount, 1);
    assert.equal(status.platforms.shopee.accounting.actorStarts, 3);
    assert.equal(status.platforms.shopee.accounting.emptyRuns, 2);
    assert.equal(status.platforms.shopee.accounting.actorExhausted, 1);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('Shopee tiếp tục quét pool khi batch usage đầu bị Redis loại', async () => {
  const names = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'APIFY_TOKEN_VAULT_KEY'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-test-token';
  process.env.APIFY_TOKEN_VAULT_KEY = Buffer.alloc(32, 7).toString('base64');
  const redis = createRedisFake();
  const cycleStartAt = '2026-09-14T00:00:00.000Z';
  let usageCalls = 0;
  try {
    await saveApifyCredentialPool({
      maxUsesPerKey: 20,
      groups: [group('primary', 'primary'), group('backup-a', 'backup-a'), group('backup-b', 'backup-b')]
    }, { fetchImpl: redis.fetchImpl });
    const config = JSON.parse(redis.values.get(APIFY_POOL_KEY));
    const orderedCredentials = config.groups.flatMap((item) => item.credentials);
    redis.hashes.set(`${APIFY_COST_LEDGER_PREFIX}:exhausted`, Object.fromEntries(
      orderedCredentials.slice(0, 6).map((credential) => [
        `${credential.billingAccountId}:${cycleStartAt}`,
        String(Date.parse(cycleStartAt))
      ])
    ));

    const allocation = await reserveShopeeCostCredentialSet({
      fetchImpl: redis.fetchImpl,
      usageFetchImpl: async () => {
        usageCalls += 1;
        return {
          ok: true,
          async json() {
            return { data: {
              usageCycle: { startAt: cycleStartAt, endAt: '2026-10-13T23:59:59.999Z' },
              totalUsageCreditsUsdAfterVolumeDiscount: 0.5
            } };
          }
        };
      }
    });

    const rejectedIds = new Set(orderedCredentials.slice(0, 6).map((credential) => credential.id));
    assert.equal(allocation.credentials.length, 5);
    assert.ok(allocation.credentials.every((credential) => !rejectedIds.has(credential.id)));
    assert.equal(usageCalls, 15, 'batch đầu 10 key, fallback chỉ đọc thêm 5 key còn lại');
    assert.equal(redis.evalCalls, 2, 'lần đầu thiếu key và lần hai giữ chỗ thành công');
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('Shopee chỉ báo hết sau khi đã quét toàn bộ ứng viên', async () => {
  const names = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'APIFY_TOKEN_VAULT_KEY'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-test-token';
  process.env.APIFY_TOKEN_VAULT_KEY = Buffer.alloc(32, 7).toString('base64');
  const redis = createRedisFake();
  const cycleStartAt = '2026-09-14T00:00:00.000Z';
  try {
    await saveApifyCredentialPool({
      maxUsesPerKey: 20,
      groups: [group('primary', 'primary'), group('backup', 'backup')]
    }, { fetchImpl: redis.fetchImpl });
    const config = JSON.parse(redis.values.get(APIFY_POOL_KEY));
    const credentials = config.groups.flatMap((item) => item.credentials);
    redis.hashes.set(`${APIFY_COST_LEDGER_PREFIX}:exhausted`, Object.fromEntries(
      credentials.map((credential) => [
        `${credential.billingAccountId}:${cycleStartAt}`,
        String(Date.parse(cycleStartAt))
      ])
    ));

    await assert.rejects(
      reserveShopeeCostCredentialSet({
        fetchImpl: redis.fetchImpl,
        usageFetchImpl: async () => ({
          ok: true,
          async json() {
            return { data: {
              usageCycle: { startAt: cycleStartAt, endAt: '2026-10-13T23:59:59.999Z' },
              totalUsageCreditsUsdAfterVolumeDiscount: 0.5
            } };
          }
        })
      }),
      (error) => {
        assert.equal(error.code, 'SHOPEE_LIFETIME_OR_BUDGET_EXHAUSTED');
        assert.equal(error.available, 0);
        assert.deepEqual(error.diagnostics, {
          candidates: 10,
          scanned: 10,
          eligible: 10,
          usageFailures: 0,
          budgetRejected: 0
        });
        return true;
      }
    );
    assert.equal(redis.evalCalls, 1);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('TikTok v4 đặt chỗ 200 review cho actor tạm, dùng đúng billing cycle và finalize idempotent', async () => {
  const names = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'APIFY_TOKEN_VAULT_KEY'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-test-token';
  process.env.APIFY_TOKEN_VAULT_KEY = Buffer.alloc(32, 7).toString('base64');
  const redis = createRedisFake();
  try {
    await saveApifyCredentialPool({ maxUsesPerKey: 10, groups: [group('primary', 'primary')] }, { fetchImpl: redis.fetchImpl });
    const allocation = await reserveTikTokCostCredentials({
      count: 1,
      reviewsPerCredential: 200,
      runtime: {
        actorId: 'H2sSMaN2TZaXG8fye',
        pricingVersion: 'pay-per-event-v1',
        reviewLimit: 200,
        reviewCostMicroUsd: 3_000,
        startupFeeMicroUsd: 5_000
      },
      fetchImpl: redis.fetchImpl,
      usageFetchImpl: async () => ({
        ok: true,
        async json() {
          return { data: {
            usageCycle: { startAt: '2026-09-20T00:00:00.000Z', endAt: '2026-10-19T23:59:59.999Z' },
            totalUsageCreditsUsdAfterVolumeDiscount: 0.25
          } };
        }
      })
    });

    assert.equal(allocation.source, 'redis-vault-cost-ledger-v4');
    assert.equal(allocation.credentials.length, 1);
    const credential = allocation.credentials[0];
    assert.equal(credential.billingCycleStartAt, '2026-09-20T00:00:00.000Z');
    assert.equal(credential.spentMicroUsd, 250_000);
    assert.equal(credential.plannedReviews, 200);
    assert.equal(credential.plannedCostMicroUsd, 605_000);

    const first = await finalizeTikTokCostCredential(credential, {
      reviewCount: 200, statusCode: 200, operationId: 'tiktok-run-1'
    }, { fetchImpl: redis.fetchImpl });
    const repeated = await finalizeTikTokCostCredential(credential, {
      reviewCount: 200, statusCode: 200, operationId: 'tiktok-run-1'
    }, { fetchImpl: redis.fetchImpl });
    assert.equal(first.costMicroUsd, 605_000);
    assert.equal(repeated.alreadyFinalized, true);

    const emptyAllocation = await reserveTikTokCostCredentials({
      count: 1,
      reviewsPerCredential: 200,
      runtime: allocation.runtime,
      fetchImpl: redis.fetchImpl,
      usageFetchImpl: async () => ({
        ok: true,
        async json() {
          return { data: {
            usageCycle: { startAt: '2026-09-20T00:00:00.000Z', endAt: '2026-10-19T23:59:59.999Z' },
            totalUsageCreditsUsdAfterVolumeDiscount: 0.25
          } };
        }
      })
    });
    const emptyResult = await finalizeTikTokCostCredential(emptyAllocation.credentials[0], {
      reviewCount: 0, statusCode: 200, operationId: 'tiktok-run-empty', actorStarted: true
    }, { fetchImpl: redis.fetchImpl });
    assert.equal(emptyResult.costMicroUsd, 5_000);
    const status = await getApifyCredentialPoolStatus({ fetchImpl: redis.fetchImpl });
    assert.deepEqual(status.platforms.tiktok.accounting, {
      actorStarts: 2,
      emptyRuns: 1,
      billedItems: 200
    });
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('TikTok tạm dừng để chừa 10 lượt Shopee còn lại và tự dùng lại key khi Apify sang cycle mới', async () => {
  const names = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'APIFY_TOKEN_VAULT_KEY'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-test-token';
  process.env.APIFY_TOKEN_VAULT_KEY = Buffer.alloc(32, 7).toString('base64');
  const redis = createRedisFake();
  const runtime = {
    actorId: 'H2sSMaN2TZaXG8fye',
    pricingVersion: 'pay-per-event-v1',
    reviewCostMicroUsd: 3_000,
    startupFeeMicroUsd: 5_000
  };
  let currentCycle = {
    startAt: '2026-09-20T00:00:00.000Z',
    endAt: '2026-10-19T23:59:59.999Z',
    spentUsd: 4.122
  };
  const usageFetchImpl = async () => ({
    ok: true,
    async json() {
      return { data: {
        usageCycle: { startAt: currentCycle.startAt, endAt: currentCycle.endAt },
        totalUsageCreditsUsdAfterVolumeDiscount: currentCycle.spentUsd
      } };
    }
  });
  try {
    await saveApifyCredentialPool({ maxUsesPerKey: 10, groups: [group('primary', 'primary')] }, { fetchImpl: redis.fetchImpl });
    assert.equal(JSON.parse(redis.values.get(APIFY_POOL_KEY)).maxUsesPerKey, DEFAULT_MAX_USES_PER_KEY);
    const config = JSON.parse(redis.values.get(APIFY_POOL_KEY));
    const shopeeCounters = {};
    for (const credential of config.groups[0].credentials) shopeeCounters[credential.id] = '10';
    redis.hashes.set(APIFY_POOL_COUNTERS_KEY, shopeeCounters);

    await assert.rejects(
      reserveTikTokCostCredentials({
        count: 1,
        reviewsPerCredential: 100,
        runtime,
        fetchImpl: redis.fetchImpl,
        usageFetchImpl
      }),
      (error) => error.code === 'APIFY_USAGE_CYCLE_UNAVAILABLE'
    );

    currentCycle = {
      startAt: '2026-10-20T00:00:00.000Z',
      endAt: '2026-11-19T23:59:59.999Z',
      spentUsd: 0
    };
    const allocation = await reserveTikTokCostCredentials({
      count: 1,
      reviewsPerCredential: 100,
      runtime,
      fetchImpl: redis.fetchImpl,
      usageFetchImpl
    });
    assert.equal(allocation.credentials[0].billingCycleStartAt, currentCycle.startAt);
    assert.equal(allocation.credentials[0].shopeeReservedMicroUsd, 878_000);
    assert.equal(Number(redis.hashes.get(APIFY_POOL_COUNTERS_KEY)[allocation.credentials[0].id]), 10);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('key từng khóa ở 10 nhưng TikTok đã tiêu gần hết tháng phải chờ cycle mới trước khi cấp lại Shopee và TikTok', async () => {
  const names = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'APIFY_TOKEN_VAULT_KEY'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-test-token';
  process.env.APIFY_TOKEN_VAULT_KEY = Buffer.alloc(32, 7).toString('base64');
  const redis = createRedisFake();
  const runtime = {
    actorId: 'H2sSMaN2TZaXG8fye',
    pricingVersion: 'pay-per-event-v1',
    reviewCostMicroUsd: 3_000,
    startupFeeMicroUsd: 5_000
  };
  let currentCycle = {
    startAt: '2026-09-20T00:00:00.000Z',
    endAt: '2026-10-19T23:59:59.999Z',
    spentUsd: 4.9
  };
  const usageFetchImpl = async () => ({
    ok: true,
    async json() {
      return { data: {
        usageCycle: { startAt: currentCycle.startAt, endAt: currentCycle.endAt },
        totalUsageCreditsUsdAfterVolumeDiscount: currentCycle.spentUsd
      } };
    }
  });
  try {
    await saveApifyCredentialPool({ maxUsesPerKey: 10, groups: [group('primary', 'primary')] }, { fetchImpl: redis.fetchImpl });
    const config = JSON.parse(redis.values.get(APIFY_POOL_KEY));
    const shopeeCounters = Object.fromEntries(config.groups[0].credentials.map((credential) => [credential.id, '10']));
    redis.hashes.set(APIFY_POOL_COUNTERS_KEY, shopeeCounters);
    redis.hashes.set(APIFY_POOL_USED_KEY, Object.fromEntries(config.groups[0].credentials.map((credential) => [
      credential.id,
      JSON.stringify({ id: credential.id, usageCount: 10, usedAt: '2026-09-01T00:00:00.000Z' })
    ])));

    await assert.rejects(
      reserveShopeeCostCredentialSet({ count: 1, stars: [5], fetchImpl: redis.fetchImpl, usageFetchImpl }),
      (error) => error.code === 'APIFY_USAGE_CYCLE_UNAVAILABLE'
    );
    await assert.rejects(
      reserveTikTokCostCredentials({ count: 1, reviewsPerCredential: 100, runtime, fetchImpl: redis.fetchImpl, usageFetchImpl }),
      (error) => error.code === 'APIFY_USAGE_CYCLE_UNAVAILABLE'
    );

    currentCycle = {
      startAt: '2026-10-20T00:00:00.000Z',
      endAt: '2026-11-19T23:59:59.999Z',
      spentUsd: 0
    };
    const shopeeAllocation = await reserveShopeeCostCredentialSet({
      count: 1,
      stars: [5],
      fetchImpl: redis.fetchImpl,
      usageFetchImpl
    });
    assert.equal(shopeeAllocation.credentials[0].usageCount, 10);
    assert.equal(shopeeAllocation.credentials[0].billingCycleStartAt, currentCycle.startAt);

    const tiktokAllocation = await reserveTikTokCostCredentials({
      count: 1,
      reviewsPerCredential: 100,
      runtime,
      fetchImpl: redis.fetchImpl,
      usageFetchImpl
    });
    assert.equal(tiktokAllocation.credentials[0].billingCycleStartAt, currentCycle.startAt);
    assert.equal(Number(redis.hashes.get(APIFY_POOL_COUNTERS_KEY)[tiktokAllocation.credentials[0].id]), 10);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('key đã dùng 10 lượt Shopee được mở lại và TikTok vẫn chừa đủ 10 lượt còn lại', async () => {
  const names = [
    'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'APIFY_TOKEN_VAULT_KEY',
    'APIFY_FREE_USAGE_MICRO_USD',
    'SHOPEE_USAGE_MICRO_USD_PER_REVIEW', 'TIKTOK_USAGE_MICRO_USD_PER_REVIEW'
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-test-token';
  process.env.APIFY_TOKEN_VAULT_KEY = Buffer.alloc(32, 7).toString('base64');
  delete process.env.APIFY_FREE_USAGE_MICRO_USD;
  delete process.env.SHOPEE_USAGE_MICRO_USD_PER_REVIEW;
  delete process.env.TIKTOK_USAGE_MICRO_USD_PER_REVIEW;
  const redis = createRedisFake();
  try {
    await saveApifyCredentialPool({ maxUsesPerKey: 10, groups: [group('primary', 'primary')] }, { fetchImpl: redis.fetchImpl });
    const legacyConfig = JSON.parse(redis.values.get(APIFY_POOL_KEY));
    legacyConfig.maxUsesPerKey = 10;
    redis.values.set(APIFY_POOL_KEY, JSON.stringify(legacyConfig));
    const legacyCredentialId = legacyConfig.groups[0].credentials[0].id;
    redis.hashes.set(APIFY_POOL_USED_KEY, {
      [legacyCredentialId]: JSON.stringify({ id: legacyCredentialId, usageCount: 10, usedAt: '2026-09-01T00:00:00.000Z' })
    });
    for (let use = 0; use < 10; use += 1) await reserveApifyCredential({ fetchImpl: redis.fetchImpl });

    const migratedStatus = await getApifyCredentialPoolStatus({ fetchImpl: redis.fetchImpl });
    assert.equal(migratedStatus.maxUsesPerKey, 20);
    assert.equal(migratedStatus.active.credentials[0].shopee.remainingUses, 10);
    assert.equal(migratedStatus.usedHistory.length, 0, 'dấu used cũ ở mốc 10 không còn được báo là đã hết');

    const allocation = await reserveTikTokCredentials({ count: 1, reviewsPerCredential: 100, fetchImpl: redis.fetchImpl });
    assert.equal(allocation.credentials[0].label, 'primary-5-star');
    assert.equal(allocation.maxReviewsPerKey, 8_110);
    assert.equal(allocation.credentials[0].shopeeReservedUsageMicroUsd, 878_000);

    const first = await finalizeTikTokCredential(allocation.credentials[0], { reviewCount: 100 }, { fetchImpl: redis.fetchImpl });
    const repeated = await finalizeTikTokCredential(allocation.credentials[0], { reviewCount: 100 }, { fetchImpl: redis.fetchImpl });
    assert.equal(first.reviewCount, 100);
    assert.equal(repeated.reviewCount, 100, 'finalize retry không được cộng usage TikTok lần thứ hai');
    assert.equal(repeated.alreadyFinalized, true);

    const status = await getApifyCredentialPoolStatus({ fetchImpl: redis.fetchImpl });
    const key = status.active.credentials[0];
    assert.equal(key.shopee.status, 'available');
    assert.equal(key.shopee.remainingUses, 10);
    assert.equal(key.tiktok.status, 'available');
    assert.equal(key.tiktok.reviewCount, 100);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('chế độ test chỉ tăng một key và giữ bốn key còn lại làm backup', async () => {
  const previous = {
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
    vault: process.env.APIFY_TOKEN_VAULT_KEY
  };
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-test-token';
  process.env.APIFY_TOKEN_VAULT_KEY = Buffer.alloc(32, 7).toString('base64');
  const redis = createRedisFake();
  try {
    await saveApifyCredentialPool({
      maxUsesPerKey: 10,
      groups: [group('primary', 'primary'), group('backup', 'backup')]
    }, { fetchImpl: redis.fetchImpl });

    let allocation;
    for (let use = 1; use <= 20; use += 1) {
      allocation = await reserveApifyCredential({ fetchImpl: redis.fetchImpl });
      assert.equal(allocation.groupLabel, 'primary');
      assert.equal(allocation.credential.label, 'primary-5-star');
      assert.equal(allocation.credential.usageCount, use);
    }
    assert.equal(allocation.retiresAfterReservation, true);

    const rotated = await reserveApifyCredential({ fetchImpl: redis.fetchImpl });
    assert.equal(rotated.credential.label, 'primary-4-star');
    assert.equal(rotated.credential.usageCount, 1);

    const status = await getApifyCredentialPoolStatus({ fetchImpl: redis.fetchImpl });
    assert.equal(status.active.label, 'primary');
    assert.equal(status.active.credentials[0].status, 'used');
    assert.equal(status.active.credentials[1].status, 'active');
    assert.ok(status.active.credentials.slice(2).every((credential) => credential.status === 'reserve'));
    assert.equal(status.usedHistory.length, 1);
    assert.equal(status.reserve[0].label, 'backup');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      const envKey = { url: 'UPSTASH_REDIS_REST_URL', token: 'UPSTASH_REDIS_REST_TOKEN', vault: 'APIFY_TOKEN_VAULT_KEY' }[key];
      if (value === undefined) delete process.env[envKey];
      else process.env[envKey] = value;
    }
  }
});

test('Shopee production cấp đủ 5 key cho các tầng 5★, 4★, 3★, 2★ và 1★', async () => {
  const previous = {
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
    vault: process.env.APIFY_TOKEN_VAULT_KEY
  };
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-test-token';
  process.env.APIFY_TOKEN_VAULT_KEY = Buffer.alloc(32, 7).toString('base64');
  const redis = createRedisFake();
  try {
    await saveApifyCredentialPool({ maxUsesPerKey: 10, groups: [group('primary', 'primary')] }, { fetchImpl: redis.fetchImpl });
    const allocation = await reserveApifyCredentialSet({
      count: 5,
      stars: [5, 4, 3, 2, 1],
      fetchImpl: redis.fetchImpl
    });
    assert.equal(allocation.credentials.length, 5);
    assert.deepEqual(allocation.credentials.map((credential) => credential.star), [5, 4, 3, 2, 1]);
    const status = await getApifyCredentialPoolStatus({ fetchImpl: redis.fetchImpl });
    assert.equal(status.active.credentials.filter((credential) => credential.shopee.usageCount === 1).length, 5);
    assert.equal(status.active.credentials.filter((credential) => credential.shopee.usageCount === 0).length, 0);
    assert.ok(status.active.credentials.every((credential) => credential.tiktok.runCount === 0));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      const envKey = { url: 'UPSTASH_REDIS_REST_URL', token: 'UPSTASH_REDIS_REST_TOKEN', vault: 'APIFY_TOKEN_VAULT_KEY' }[key];
      if (value === undefined) delete process.env[envKey];
      else process.env[envKey] = value;
    }
  }
});

test('chế độ 5 key tận dụng key còn lượt xuyên nhóm mà không sửa cấu hình pool hay reset bộ đếm', async () => {
  const previous = {
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
    vault: process.env.APIFY_TOKEN_VAULT_KEY
  };
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-test-token';
  process.env.APIFY_TOKEN_VAULT_KEY = Buffer.alloc(32, 7).toString('base64');
  const redis = createRedisFake();
  try {
    await saveApifyCredentialPool({
      maxUsesPerKey: 10,
      groups: [group('primary', 'primary'), group('backup', 'backup')],
      pendingCredentials: [
        { label: 'pending-one', token: 'apify_api_pending_1_super_secret_token' },
        { label: 'pending-two', token: 'apify_api_pending_2_super_secret_token' }
      ]
    }, { fetchImpl: redis.fetchImpl });
    const storedPoolBefore = redis.values.get(APIFY_POOL_KEY);

    for (let use = 1; use <= 20; use += 1) {
      await reserveApifyCredential({ fetchImpl: redis.fetchImpl });
    }

    let mixedAllocation;
    for (let use = 1; use <= 20; use += 1) {
      mixedAllocation = await reserveApifyCredentialSet({ fetchImpl: redis.fetchImpl });
      assert.equal(mixedAllocation.groupLabel, 'mixed-available-keys');
      assert.deepEqual(mixedAllocation.credentials.map((credential) => credential.star), [5, 4, 3, 2, 1]);
      assert.equal(mixedAllocation.credentials.filter((credential) => credential.label.startsWith('primary-')).length, 4);
      assert.equal(mixedAllocation.credentials.filter((credential) => credential.label.startsWith('backup-')).length, 1);
    }

    const status = await getApifyCredentialPoolStatus({ fetchImpl: redis.fetchImpl });
    assert.equal(status.used[0].label, 'primary');
    assert.ok(status.used[0].credentials.every((credential) => credential.usageCount === 20));
    assert.equal(status.active.label, 'backup');
    assert.ok(status.active.credentials.every((credential) => credential.usageCount === 4));
    assert.equal(status.pendingCount, 2);
    assert.equal(redis.values.get(APIFY_POOL_KEY), storedPoolBefore, 'cấu trúc active/reserve/pending trong pool không bị ghi lại');

    const backupAllocation = await reserveApifyCredentialSet({ fetchImpl: redis.fetchImpl });
    assert.equal(backupAllocation.groupLabel, 'backup');
    assert.ok(backupAllocation.credentials.every((credential) => credential.usageCount === 5));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      const envKey = { url: 'UPSTASH_REDIS_REST_URL', token: 'UPSTASH_REDIS_REST_TOKEN', vault: 'APIFY_TOKEN_VAULT_KEY' }[key];
      if (value === undefined) delete process.env[envKey];
      else process.env[envKey] = value;
    }
  }
});
