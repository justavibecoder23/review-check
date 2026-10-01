import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { redisLuaMock } from './helpers/redis-lua.mjs';
import { registerAccount, authenticateAccount, createPasswordReset, resetAccountPassword, createAccountSession, getAccountFromSession, accountStoreInternals as keys } from '../src/account-store.mjs';

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
const input = { username: 'Buyer_03', email: 'buyer@example.com', password: 'original-password' };
function setup() { const mock = redisLuaMock(); return { mock, options: { fetchImpl: mock.fetchImpl } }; }
const wrongCode = code => code === '000000' ? '000001' : '000000';

test('email and username resolve the same ID; public password capability is explicit', async () => {
  const { options } = setup(); const user = await registerAccount(input, options);
  assert.equal(user.hasPassword, true); assert.deepEqual(user.authProviders, ['password']);
  for (const identifier of ['BUYER_03', ' BUYER@EXAMPLE.COM ']) {
    assert.equal((await authenticateAccount({ identifier, password: input.password }, options)).id, user.id);
  }
  await assert.rejects(authenticateAccount({ identifier: input.email, password: 'x'.repeat(129) }, options));
});

test('parallel wrong guesses cannot reset or bypass the five-attempt budget', async () => {
  const { mock, options } = setup(); await registerAccount(input, options);
  const reset = await createPasswordReset(input.email, options);
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => resetAccountPassword({ requestId: reset.requestId, code: wrongCode(reset.code), password: 'new-password' }, options)));
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.equal(mock.strings.has(keys.passwordResetKey(reset.requestId)), false);
  await assert.rejects(resetAccountPassword({ requestId: reset.requestId, code: reset.code, password: 'new-password' }, options));
});

test('one correct proof wins concurrent requests and revokes old and legacy sessions', async () => {
  const { mock, options } = setup(); const user = await registerAccount(input, options);
  const old = await createAccountSession(user, options);
  const legacy = 'legacy-token'; mock.strings.set(keys.sessionKey(legacy), user.id);
  assert.equal((await getAccountFromSession(legacy, options)).id, user.id);
  const reset = await createPasswordReset(input.email, options);
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => resetAccountPassword({ requestId: reset.requestId, code: reset.code, password: 'new-password' }, options)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(await getAccountFromSession(old.token, options), null);
  assert.equal(await getAccountFromSession(legacy, options), null);
  await assert.rejects(createAccountSession(user, options), { code: 'SESSION_CHANGED' });
  const authenticated = await authenticateAccount({ identifier: user.email, password: 'new-password' }, options);
  const fresh = await createAccountSession(authenticated, options);
  assert.equal((await getAccountFromSession(fresh.token, options)).id, user.id);
});

test('resending invalidates old proof and imposes a per-email cooldown/send limit', async () => {
  const { mock, options } = setup(); await registerAccount(input, options);
  const first = await createPasswordReset(input.email, options);
  await assert.rejects(createPasswordReset(input.email, options), { code: 'RATE_LIMITED' });
  const digest = createHash('sha256').update(input.email).digest('hex');
  const cooldown = `realview:account:v1:password-reset-cooldown:${digest}`;
  mock.strings.delete(cooldown);
  const second = await createPasswordReset(input.email, options);
  await assert.rejects(resetAccountPassword({ requestId: first.requestId, code: first.code, password: 'new-password' }, options));
  assert.ok(mock.strings.has(keys.passwordResetKey(second.requestId)));
  for (let i = 0; i < 3; i++) { mock.strings.delete(cooldown); await createPasswordReset(input.email, options); }
  mock.strings.delete(cooldown);
  await assert.rejects(createPasswordReset(input.email, options), { code: 'RATE_LIMITED' });
});

test('expired, unknown-email and changed-account proofs cannot set a password', async () => {
  const { mock, options } = setup(); const user = await registerAccount(input, options);
  const unknown = await createPasswordReset('unknown@example.com', options);
  assert.equal(unknown.user, null); assert.equal(unknown.code, null);
  const reset = await createPasswordReset(input.email, options);
  const key = keys.userKey(user.id);
  const record = JSON.parse(mock.strings.get(key)); record.email = 'changed@example.com'; mock.strings.set(key, JSON.stringify(record));
  await assert.rejects(resetAccountPassword({ requestId: reset.requestId, code: reset.code, password: 'new-password' }, options));
  assert.equal(JSON.parse(mock.strings.get(key)).passwordHash, record.passwordHash);
  // Explicit expiry is checked even if a storage TTL is delayed.
  const expired = { ...JSON.parse(mock.strings.get(keys.passwordResetKey(unknown.requestId))), expiresAt: 1 };
  mock.strings.set(keys.passwordResetKey(unknown.requestId), JSON.stringify(expired));
  await assert.rejects(resetAccountPassword({ requestId: unknown.requestId, code: '123456', password: 'new-password' }, options));
});
