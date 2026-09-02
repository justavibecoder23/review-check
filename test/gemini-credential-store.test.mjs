import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GEMINI_MODELS,
  GEMINI_POOL_KEY,
  GEMINI_POOL_STATES_KEY,
  getGeminiCredentialPoolStatus,
  listAvailableGeminiCredentials,
  markGeminiModelExhausted,
  nextPacificResetAt,
  reserveGeminiCredential,
  saveGeminiCredentialPool
} from '../src/gemini-credential-store.mjs';

function flattenHash(value) {
  return Object.entries(value).flat();
}

function createRedisFake() {
  const values = new Map();
  const hashes = new Map();
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
    if (command[0] !== 'EVAL') throw new Error(`Redis fake không hỗ trợ ${command[0]}`);
    const configRaw = values.get(GEMINI_POOL_KEY);
    if (!configRaw) return JSON.stringify({ ok: false, code: 'POOL_NOT_CONFIGURED' });
    const config = JSON.parse(configRaw);
    const states = hash(GEMINI_POOL_STATES_KEY);
    if (String(command[1]).includes('GEMINI_CREDENTIAL_RESERVATION')) {
      const nowMs = Number(command[5]);
      const excludedIds = new Set(JSON.parse(command[7] || '[]'));
      for (const credential of config.credentials) {
        if (excludedIds.has(credential.id)) continue;
        let state = states[credential.id] ? JSON.parse(states[credential.id]) : null;
        if (state && Number(state.resetAtMs) <= nowMs) {
          delete states[credential.id];
          state = null;
        }
        const exhausted = state?.models || {};
        if (config.models.some((model) => !exhausted[model])) {
          return JSON.stringify({
            ok: true, source: 'redis-vault', credential,
            exhaustedModels: exhausted, models: config.models,
            resetAt: state?.resetAt || command[6]
          });
        }
      }
      return JSON.stringify({
        ok: false,
        code: excludedIds.size ? 'POOL_RETRY_EXHAUSTED' : 'POOL_EXHAUSTED',
        resetAt: command[6]
      });
    }
    if (String(command[1]).includes('GEMINI_MODEL_EXHAUSTION')) {
      const id = command[5];
      const model = command[6];
      const nowIso = command[7];
      const nowMs = Number(command[8]);
      const resetAt = command[9];
      const resetAtMs = Number(command[10]);
      let state = states[id] ? JSON.parse(states[id]) : null;
      if (!state || Number(state.resetAtMs) <= nowMs) state = { id, models: {} };
      state.models[model] = nowIso;
      state.updatedAt = nowIso;
      state.resetAt = resetAt;
      state.resetAtMs = resetAtMs;
      state.exhaustedCount = config.models.filter((requiredModel) => state.models[requiredModel]).length;
      state.used = state.exhaustedCount >= config.models.length;
      if (state.used) state.usedAt ||= nowIso;
      states[id] = JSON.stringify(state);
      return JSON.stringify({ ok: true, exhaustedCount: state.exhaustedCount, used: state.used, resetAt });
    }
    throw new Error('Lua script không được hỗ trợ.');
  }
  return {
    values,
    hashes,
    async fetchImpl(url, init) {
      const payload = JSON.parse(init.body);
      if (url.endsWith('/multi-exec')) {
        return { ok: true, async json() { return payload.map((command) => ({ result: execute(command) })); } };
      }
      return { ok: true, async json() { return { result: execute(payload) }; } };
    }
  };
}

test('Gemini pool mã hóa key, dùng đủ bốn model rồi chuyển key và reset lúc nửa đêm Pacific', async () => {
  const previous = {
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
    vault: process.env.GEMINI_API_KEY_VAULT_KEY
  };
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-secret';
  process.env.GEMINI_API_KEY_VAULT_KEY = Buffer.alloc(32, 7).toString('base64');
  const redis = createRedisFake();
  const now = '2026-09-01T12:00:00.000Z';
  try {
    await saveGeminiCredentialPool({
      mode: 'replace',
      credentials: [
        { label: 'project-one', apiKey: 'AIza-first-project-secret-key' },
        { label: 'project-two', apiKey: 'AIza-second-project-secret-key' }
      ]
    }, { fetchImpl: redis.fetchImpl, now });
    assert.doesNotMatch(redis.values.get(GEMINI_POOL_KEY), /AIza-/);

    const available = await listAvailableGeminiCredentials({ fetchImpl: redis.fetchImpl, now });
    assert.deepEqual(available.map((credential) => credential.label), ['project-one', 'project-two']);
    assert.equal(available[1].apiKey, 'AIza-second-project-secret-key');

    const first = await reserveGeminiCredential({ fetchImpl: redis.fetchImpl, now });
    assert.equal(first.label, 'project-one');
    assert.equal(first.apiKey, 'AIza-first-project-secret-key');
    for (const [index, model] of DEFAULT_GEMINI_MODELS.entries()) {
      const state = await markGeminiModelExhausted(first, model, { fetchImpl: redis.fetchImpl, now });
      assert.equal(state.used, index === DEFAULT_GEMINI_MODELS.length - 1);
    }
    const second = await reserveGeminiCredential({ fetchImpl: redis.fetchImpl, now });
    assert.equal(second.label, 'project-two');
    const status = await getGeminiCredentialPoolStatus({ fetchImpl: redis.fetchImpl, now });
    assert.equal(status.totals.used, 1);
    assert.equal(status.active.label, 'project-two');

    const afterReset = await reserveGeminiCredential({ fetchImpl: redis.fetchImpl, now: '2026-09-02T08:00:00.000Z' });
    assert.equal(afterReset.label, 'project-one');
    assert.deepEqual(afterReset.exhaustedModels, []);
  } finally {
    if (previous.url) process.env.UPSTASH_REDIS_REST_URL = previous.url; else delete process.env.UPSTASH_REDIS_REST_URL;
    if (previous.token) process.env.UPSTASH_REDIS_REST_TOKEN = previous.token; else delete process.env.UPSTASH_REDIS_REST_TOKEN;
    if (previous.vault) process.env.GEMINI_API_KEY_VAULT_KEY = previous.vault; else delete process.env.GEMINI_API_KEY_VAULT_KEY;
  }
});

test('mốc reset Gemini là 00:00 America/Los_Angeles kể cả khi DST', () => {
  assert.equal(nextPacificResetAt('2026-09-01T12:00:00.000Z'), '2026-09-02T07:00:00.000Z');
  assert.equal(nextPacificResetAt('2026-12-01T12:00:00.000Z'), '2026-12-02T08:00:00.000Z');
});

test('reserve retry bỏ qua credential vừa timeout mà không đánh dấu used', async () => {
  const redis = createRedisFake();
  const now = '2026-09-01T12:00:00.000Z';
  const previousRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const previousRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const previousVault = process.env.GEMINI_API_KEY_VAULT_KEY;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  process.env.GEMINI_API_KEY_VAULT_KEY = Buffer.alloc(32, 7).toString('base64');
  try {
    await saveGeminiCredentialPool({
      mode: 'replace',
      credentials: [
        { label: 'first-key', apiKey: 'gemini-secret-key-number-one' },
        { label: 'second-key', apiKey: 'gemini-secret-key-number-two' }
      ]
    }, { fetchImpl: redis.fetchImpl });
    const first = await reserveGeminiCredential({ fetchImpl: redis.fetchImpl, now });
    const second = await reserveGeminiCredential({
      fetchImpl: redis.fetchImpl,
      now,
      excludeCredentialIds: [first.id]
    });
    assert.notEqual(second.id, first.id);
    assert.equal(second.label, 'second-key');
    const status = await getGeminiCredentialPoolStatus({ fetchImpl: redis.fetchImpl, now });
    assert.equal(status.totals.used, 0);
  } finally {
    if (previousRedisUrl) process.env.UPSTASH_REDIS_REST_URL = previousRedisUrl;
    else delete process.env.UPSTASH_REDIS_REST_URL;
    if (previousRedisToken) process.env.UPSTASH_REDIS_REST_TOKEN = previousRedisToken;
    else delete process.env.UPSTASH_REDIS_REST_TOKEN;
    if (previousVault) process.env.GEMINI_API_KEY_VAULT_KEY = previousVault;
    else delete process.env.GEMINI_API_KEY_VAULT_KEY;
  }
});
