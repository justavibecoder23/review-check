import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APIFY_POOL_COUNTERS_KEY,
  APIFY_POOL_KEY,
  APIFY_POOL_USED_KEY,
  getApifyCredentialPoolStatus,
  reserveApifyCredential,
  reserveApifyCredentialSet,
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
      const activeGroupIndex = config.groups.findIndex((group) => group.credentials.some((credential) => Number(counters[credential.id] || 0) < config.maxUsesPerKey));
      if (activeGroupIndex < 0) return JSON.stringify({ ok: false, code: 'POOL_EXHAUSTED' });
      const activeGroup = config.groups[activeGroupIndex];
      const selected = activeGroup.credentials
        .filter((credential) => Number(counters[credential.id] || 0) < config.maxUsesPerKey)
        .map((credential, index) => ({ credential, group: activeGroup, order: index }));
      const reserveCandidates = config.groups.slice(activeGroupIndex + 1).flatMap((group, groupOffset) => group.credentials
        .filter((credential) => Number(counters[credential.id] || 0) < config.maxUsesPerKey)
        .map((credential, credentialIndex) => ({
          credential,
          group,
          count: Number(counters[credential.id] || 0),
          order: (groupOffset + 1) * 5 + credentialIndex
        })))
        .sort((left, right) => left.count - right.count || left.order - right.order);
      while (selected.length < 5 && reserveCandidates.length) selected.push(reserveCandidates.shift());
      if (selected.length < 5) return JSON.stringify({ ok: false, code: 'POOL_EXHAUSTED' });
      const stars = [5, 4, 3, 2, 1];
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
            usedAt: command.at(-1)
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
        reservedAt: command.at(-1)
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
