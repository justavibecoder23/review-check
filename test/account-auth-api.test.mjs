import test from 'node:test';
import assert from 'node:assert/strict';
import { redisLuaMock } from './helpers/redis-lua.mjs';
import { createAccountAuthHandler } from '../api/auth.mjs';
import { commitGoogleAccount, resolveGoogleIdentity } from '../src/google-auth-store.mjs';
import { registerAccount, createAccountSession, getAccountFromSession, saveAccountHistory, listAccountHistory } from '../src/account-store.mjs';
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
function setup() {
  const mock = redisLuaMock(); const emails = [];
  const options = { fetchImpl: mock.fetchImpl, sendReset: async (user, code) => { emails.push({ email: user.email, code }); return { delivered: true }; } };
  return { mock, emails, options, handler: createAccountAuthHandler(options) };
}
async function call(handler, body, { cookie = '', origin = 'https://www.realview.com.vn', method = 'POST' } = {}) {
  const result = { headers: {} };
  await handler({ method, body, headers: { origin, host: 'www.realview.com.vn', 'x-forwarded-proto': 'https', cookie }, socket: { remoteAddress: 'test' } }, {
    setHeader: (key, value) => { result.headers[key.toLowerCase()] = value; },
    status(code) { result.status = code; return this; }, json(payload) { result.body = payload; }
  });
  return result;
}
const cookieOf = response => response.headers['set-cookie'].split(';')[0];
const identity = { subject: 'api-test-subject', email: 'buyer@gmail.com', name: 'Buyer', authoritativeEmail: true };

test('Google-only → email OTP → first local password → both methods keep ID/history', async () => {
  const { handler, options, emails } = setup();
  const { user } = await commitGoogleAccount(identity, {}, options);
  await saveAccountHistory(user.id, { id: 'saved', analyzedAt: new Date().toISOString(), fullReport: { product: { title: 'Preserved' } } }, options);
  const oldSession = await createAccountSession(user, options);
  const requested = await call(handler, { action: 'request_password_reset', email: user.email });
  assert.equal(requested.status, 200); assert.equal('code' in requested.body, false);
  const reset = await call(handler, { action: 'reset_password', requestId: requested.body.resetId, code: emails[0].code, password: 'new-password-safe' });
  assert.equal(reset.status, 200); assert.equal(reset.body.user.id, user.id);
  assert.deepEqual(reset.body.user.authProviders, ['password', 'google']);
  assert.equal(reset.body.user.emailMarketingConsent.status, 'not_subscribed');
  assert.match(reset.headers['set-cookie'], /HttpOnly; SameSite=Lax; Secure/);
  assert.equal(await getAccountFromSession(oldSession.token, options), null);
  const login = await call(handler, { action: 'login', identifier: 'BUYER@GMAIL.COM', password: 'new-password-safe' }, { cookie: cookieOf(reset) });
  assert.equal(login.status, 200); assert.equal(login.body.user.id, user.id);
  assert.equal((await resolveGoogleIdentity(identity, options)).user.id, user.id);
  assert.equal((await listAccountHistory(user.id, options))[0].id, 'saved');
  assert.equal((await call(handler, { action: 'reset_password', requestId: requested.body.resetId, code: emails[0].code, password: 'other-password' })).status, 400);
});

test('settings verification chooses server-side account email, not posted target', async () => {
  const { handler, options, emails } = setup();
  const user = await registerAccount({ username: 'buyer', email: 'buyer@example.com', password: 'safe-password' }, options);
  const session = await createAccountSession(user, options);
  const result = await call(handler, { action: 'request_password_change', email: 'attacker@example.com' }, { cookie: `realview_session=${session.token}` });
  assert.equal(result.status, 200); assert.equal(emails[0].email, user.email);
  assert.equal((await call(handler, { action: 'request_password_change', email: user.email })).status, 401);
});

test('password mutations reject missing/cross-site Origin and conceal account existence', async () => {
  const { handler, options } = setup(); await commitGoogleAccount(identity, {}, options);
  for (const origin of ['', 'https://attacker.invalid', 'http://www.realview.com.vn']) {
    assert.equal((await call(handler, { action: 'request_password_reset', email: identity.email }, { origin })).status, 403);
  }
  const known = await call(handler, { action: 'request_password_reset', email: identity.email });
  const unknown = await call(handler, { action: 'request_password_reset', email: 'unknown@gmail.com' });
  assert.equal(known.status, unknown.status);
  assert.equal(known.body.message, unknown.body.message);
  assert.deepEqual(Object.keys(known.body).sort(), Object.keys(unknown.body).sort());
});
