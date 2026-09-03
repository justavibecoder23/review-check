import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APIFY_POOL_COUNTERS_KEY,
  APIFY_POOL_KEY,
  APIFY_POOL_USED_KEY,
  APIFY_TIKTOK_REVIEW_COUNTERS_KEY,
  APIFY_TIKTOK_RESERVED_REVIEWS_KEY,
  APIFY_TIKTOK_RUN_COUNTERS_KEY,
  APIFY_TIKTOK_FINALIZED_RESERVATIONS_KEY,
  APIFY_TIKTOK_USED_KEY,
  finalizeTikTokCredential,
  getApifyCredentialPoolStatus,
  reserveApifyCredential,
  reserveApifyCredentialSet,
  reserveTikTokCredentials,
  saveApifyCredentialPool
} from '../src/apify-credential-store.mjs';

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
      const counters = hash(APIFY_POOL_COUNTERS_KEY);
      const used = hash(APIFY_POOL_USED_KEY);
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
        const shopeeCostPerReview = Number(command[14]);
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
            const shopeeBudget = shopeeMaxUses * shopeeReviewsPerRun * shopeeCostPerReview;
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
          credential = group.credentials.find((item) => Number(counters[item.id] || 0) < config.maxUsesPerKey);
          if (credential) {
            selected = group;
            break;
          }
        }
        if (!credential) return JSON.stringify({ ok: false, code: 'POOL_EXHAUSTED' });
        const usageCount = Number(counters[credential.id] || 0) + 1;
        counters[credential.id] = String(usageCount);
        const allocated = { ...credential, usageCount };
        const retiresAfterReservation = usageCount >= config.maxUsesPerKey;
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
          maxUsesPerKey: config.maxUsesPerKey,
          credential: allocated,
          retiresAfterReservation,
          reservedAt: command.at(-1)
        });
      }
      const desired = Number(command[7]) || 5;
      const stars = JSON.parse(command[8] || '[5,4,3,2,1]');
      const activeGroupIndex = config.groups.findIndex((group) => group.credentials.some((credential) => Number(counters[credential.id] || 0) < config.maxUsesPerKey));
      if (activeGroupIndex < 0) return JSON.stringify({ ok: false, code: 'POOL_EXHAUSTED' });
      const activeGroup = config.groups[activeGroupIndex];
      const selected = activeGroup.credentials
        .filter((credential) => Number(counters[credential.id] || 0) < config.maxUsesPerKey)
        .map((credential, index) => ({ credential, group: activeGroup, count: Number(counters[credential.id] || 0), order: index }))
        .sort((left, right) => left.count - right.count || left.order - right.order)
        .slice(0, desired);
      const reserveCandidates = config.groups.slice(activeGroupIndex + 1).flatMap((group, groupOffset) => group.credentials
        .filter((credential) => Number(counters[credential.id] || 0) < config.maxUsesPerKey)
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
      const retiresAfterReservation = credentials.some((credential) => credential.usageCount >= config.maxUsesPerKey);
      if (retiresAfterReservation) {
        for (const credential of credentials) {
          if (credential.usageCount < config.maxUsesPerKey) continue;
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
        maxUsesPerKey: config.maxUsesPerKey,
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

test('pool mã hóa token, đếm nguyên tử và tự chuyển nhóm sau lượt thứ 10', async () => {
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
      maxUsesPerKey: 10,
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
      maxUsesPerKey: 10,
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
    for (let use = 1; use <= 10; use += 1) {
      allocation = await reserveApifyCredentialSet({ fetchImpl: redis.fetchImpl });
      assert.equal(allocation.groupLabel, 'primary');
      assert.ok(allocation.credentials.every((credential) => credential.usageCount === use));
      assert.ok(allocation.credentials.every((credential) => credential.token.includes('primary')));
    }
    assert.equal(allocation.retiresAfterReservation, true);

    const rotated = await reserveApifyCredentialSet({ fetchImpl: redis.fetchImpl });
    assert.equal(rotated.groupLabel, 'backup');
    assert.ok(rotated.credentials.every((credential) => credential.usageCount === 1));
    assert.equal(redis.evalCalls, 11);

    const status = await getApifyCredentialPoolStatus({ fetchImpl: redis.fetchImpl });
    assert.equal(status.active.label, 'backup');
    assert.equal(status.used[0].label, 'primary');
    assert.equal(status.usedHistory.length, 5);
    assert.ok(status.used[0].credentials.every((credential) => credential.usageCount === 10));
    assert.equal(JSON.stringify(status).includes('super_secret_token'), false);

    await assert.rejects(
      saveApifyCredentialPool({
        maxUsesPerKey: 10,
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
    assert.ok(status.active.credentials.every((credential) => credential.tiktok.remainingReviews === 10_465));
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

test('TikTok vẫn dùng key đã hết 10 lượt Shopee và luôn chừa ngân sách Shopee', async () => {
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
    for (let use = 0; use < 10; use += 1) await reserveApifyCredential({ fetchImpl: redis.fetchImpl });

    const allocation = await reserveTikTokCredentials({ count: 1, reviewsPerCredential: 100, fetchImpl: redis.fetchImpl });
    assert.equal(allocation.credentials[0].label, 'primary-5-star');
    assert.equal(allocation.maxReviewsPerKey, 10_505);
    assert.equal(allocation.credentials[0].shopeeReservedUsageMicroUsd, 0);

    const first = await finalizeTikTokCredential(allocation.credentials[0], { reviewCount: 100 }, { fetchImpl: redis.fetchImpl });
    const repeated = await finalizeTikTokCredential(allocation.credentials[0], { reviewCount: 100 }, { fetchImpl: redis.fetchImpl });
    assert.equal(first.reviewCount, 100);
    assert.equal(repeated.reviewCount, 100, 'finalize retry không được cộng usage TikTok lần thứ hai');
    assert.equal(repeated.alreadyFinalized, true);

    const status = await getApifyCredentialPoolStatus({ fetchImpl: redis.fetchImpl });
    const key = status.active.credentials[0];
    assert.equal(key.shopee.status, 'used');
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
    for (let use = 1; use <= 10; use += 1) {
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

test('Shopee production-60 chỉ cấp 3 key cho các tầng 5★, 3★ và 1★', async () => {
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
      count: 3,
      stars: [5, 3, 1],
      fetchImpl: redis.fetchImpl
    });
    assert.equal(allocation.credentials.length, 3);
    assert.deepEqual(allocation.credentials.map((credential) => credential.star), [5, 3, 1]);
    const status = await getApifyCredentialPoolStatus({ fetchImpl: redis.fetchImpl });
    assert.equal(status.active.credentials.filter((credential) => credential.shopee.usageCount === 1).length, 3);
    assert.equal(status.active.credentials.filter((credential) => credential.shopee.usageCount === 0).length, 2);
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

    for (let use = 1; use <= 10; use += 1) {
      await reserveApifyCredential({ fetchImpl: redis.fetchImpl });
    }

    let mixedAllocation;
    for (let use = 1; use <= 10; use += 1) {
      mixedAllocation = await reserveApifyCredentialSet({ fetchImpl: redis.fetchImpl });
      assert.equal(mixedAllocation.groupLabel, 'mixed-available-keys');
      assert.deepEqual(mixedAllocation.credentials.map((credential) => credential.star), [5, 4, 3, 2, 1]);
      assert.equal(mixedAllocation.credentials.filter((credential) => credential.label.startsWith('primary-')).length, 4);
      assert.equal(mixedAllocation.credentials.filter((credential) => credential.label.startsWith('backup-')).length, 1);
    }

    const status = await getApifyCredentialPoolStatus({ fetchImpl: redis.fetchImpl });
    assert.equal(status.used[0].label, 'primary');
    assert.ok(status.used[0].credentials.every((credential) => credential.usageCount === 10));
    assert.equal(status.active.label, 'backup');
    assert.ok(status.active.credentials.every((credential) => credential.usageCount === 2));
    assert.equal(status.pendingCount, 2);
    assert.equal(redis.values.get(APIFY_POOL_KEY), storedPoolBefore, 'cấu trúc active/reserve/pending trong pool không bị ghi lại');

    const backupAllocation = await reserveApifyCredentialSet({ fetchImpl: redis.fetchImpl });
    assert.equal(backupAllocation.groupLabel, 'backup');
    assert.ok(backupAllocation.credentials.every((credential) => credential.usageCount === 3));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      const envKey = { url: 'UPSTASH_REDIS_REST_URL', token: 'UPSTASH_REDIS_REST_TOKEN', vault: 'APIFY_TOKEN_VAULT_KEY' }[key];
      if (value === undefined) delete process.env[envKey];
      else process.env[envKey] = value;
    }
  }
});
