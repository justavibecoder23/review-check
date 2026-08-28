import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APIFY_POOL_COUNTERS_KEY,
  APIFY_POOL_KEY,
  APIFY_POOL_USED_KEY,
  getApifyCredentialPoolStatus,
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
      const selected = config.groups.find((group) => group.credentials.every((credential) => Number(counters[credential.id] || 0) < config.maxUsesPerKey));
      if (!selected) return JSON.stringify({ ok: false, code: 'POOL_EXHAUSTED' });
      const credentials = selected.credentials.map((credential) => {
        const usageCount = Number(counters[credential.id] || 0) + 1;
        counters[credential.id] = String(usageCount);
        return { ...credential, usageCount };
      });
      const retiresAfterReservation = credentials.some((credential) => credential.usageCount >= config.maxUsesPerKey);
      if (retiresAfterReservation) {
        for (const credential of credentials) {
          used[credential.id] = JSON.stringify({
            id: credential.id,
            label: credential.label,
            star: credential.star,
            groupId: selected.id,
            groupLabel: selected.label,
            usageCount: credential.usageCount,
            usedAt: command.at(-1)
          });
        }
      }
      return JSON.stringify({
        ok: true,
        source: 'redis-vault',
        groupId: selected.id,
        groupLabel: selected.label,
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
