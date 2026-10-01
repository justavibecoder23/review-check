import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { OAuth2Client } from 'google-auth-library';
import { redisLuaMock } from './helpers/redis-lua.mjs';
import { googleAuthConfig, verifyGoogleCredential } from '../src/google-identity.mjs';
import {
  beginGoogleLogin, readGoogleChallenge, consumeGoogleChallenge, resolveGoogleIdentity,
  createGooglePending, readGooglePending, createGoogleEmailCode, verifyGoogleEmailCode,
  verifyGoogleLinkPassword, commitGoogleAccount, googleAuthStoreInternals as store
} from '../src/google-auth-store.mjs';
import {
  registerAccount, authenticateAccount, createAccountSession, getAccountFromSession, createPasswordReset,
  resetAccountPassword, acceptEmailMarketingConsent, saveAccountHistory, listAccountHistory,
  accountStoreInternals as accounts
} from '../src/account-store.mjs';
import { createGoogleAuthHandler } from '../src/google-auth-route.mjs';
import { resolveBlogRole } from '../src/blog-admin-auth.mjs';

const clientId = '154335934284-1fupk8riad0u56jughvv73pep358hdft.apps.googleusercontent.com';
const env = { GOOGLE_CLIENT_ID: clientId };
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const client = new OAuth2Client();
// Exercise the real library's signature/claim verification using an offline
// test certificate provider. Production uses Google's rotating certificate URL.
client.getFederatedSignonCertsAsync = async () => ({ certs: { local: publicKey.export({ type: 'spki', format: 'pem' }) } });
const identity = (subject = '100001', email = 'buyer@gmail.com') => ({ subject, email, name: 'Người mua', authoritativeEmail: email.endsWith('@gmail.com') });

function token(nonce, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'local' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'https://accounts.google.com', aud: clientId, sub: '100001',
    iat: now, exp: now + 300, nonce, email: 'buyer@gmail.com', email_verified: true, name: 'Người mua',
    ...overrides
  })).toString('base64url');
  const data = `${header}.${payload}`;
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`;
}

let previous;
beforeEach(() => {
  previous = [process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN];
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test';
});
afterEach(() => {
  for (const [i, name] of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'].entries()) {
    if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i];
  }
});

function setup(overrides = {}) {
  const mock = redisLuaMock();
  const options = {
    fetchImpl: mock.fetchImpl, env, client,
    discardGuestHistory: async () => {}, claimGuestHistory: async () => 0,
    sendWelcome: async () => ({ delivered: false }), sendCode: async () => ({ delivered: true }),
    ...overrides
  };
  return { mock, options, handler: createGoogleAuthHandler(options) };
}

async function request(handler, body, { method = 'POST', cookie = '', headers = {} } = {}) {
  const response = {
    headers: {}, statusCode: 0,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  await handler({ method, body, headers: { origin: 'https://www.realview.com.vn', host: 'www.realview.com.vn', 'x-forwarded-proto': 'https', cookie, ...headers } }, response);
  return response;
}

async function loginStart(handler, cookie = '') {
  const response = await request(handler, { action: 'begin' }, { cookie });
  assert.equal(response.statusCode, 200);
  return { response, cookie: response.headers['set-cookie'].split(';')[0] };
}

test('Google config is opt-in through Client ID, with a kill switch', () => {
  assert.deepEqual(googleAuthConfig({}), { enabled: false, clientId: null });
  assert.equal(googleAuthConfig(env).enabled, true);
  assert.equal(googleAuthConfig({ ...env, GOOGLE_LOGIN_ENABLED: 'false' }).enabled, false);
});

test('real Google library verifies an RSA-signed token and nonce', async () => {
  const verified = await verifyGoogleCredential(token('nonce'), 'nonce', { env, client });
  assert.deepEqual(verified, identity());
});

for (const [name, overrides] of [
  ['wrong audience', { aud: 'different.apps.googleusercontent.com' }],
  ['wrong issuer', { iss: 'https://attacker.test' }],
  ['expired token', { exp: Math.floor(Date.now() / 1000) - 1 }],
  ['future-issued token', { iat: Math.floor(Date.now() / 1000) + 300 }],
  ['wrong nonce', { nonce: 'other' }],
  ['missing nonce', { nonce: undefined }],
  ['invalid subject', { sub: 'not:a:subject' }],
  ['unverified email', { email_verified: false }]
]) {
  test(`token rejection: ${name}`, async () => {
    await assert.rejects(verifyGoogleCredential(token('nonce', overrides), 'nonce', { env, client }), (e) => e.statusCode === 401);
  });
}

test('tampered signature, malformed token, and oversized credential are rejected without leaking token', async () => {
  const good = token('nonce');
  const parts = good.split('.');
  parts[1] = Buffer.from(JSON.stringify({ sub: 'attacker' })).toString('base64url');
  for (const credential of [parts.join('.'), 'bad', `${'a'.repeat(20_000)}.b.c`]) {
    await assert.rejects(verifyGoogleCredential(credential, 'nonce', { env, client }), (e) => e.code === 'INVALID_GOOGLE_TOKEN' && !e.message.includes(credential));
  }
});

test('third-party email requires mailbox proof; Workspace email is authoritative', async () => {
  const third = await verifyGoogleCredential(token('nonce', { email: 'buyer@example.com' }), 'nonce', { env, client });
  assert.equal(third.authoritativeEmail, false);
  const workspace = await verifyGoogleCredential(token('nonce', { email: 'buyer@example.com', hd: 'example.com' }), 'nonce', { env, client });
  assert.equal(workspace.authoritativeEmail, true);
});

test('challenge is browser-bound, expiring, and consumed only once', async () => {
  const { options, mock } = setup();
  const a = await beginGoogleLogin('', clientId, options);
  await assert.rejects(readGoogleChallenge(a.challengeId, 'x'.repeat(43), options), { code: 'INVALID_GOOGLE_REQUEST' });
  const challenge = await readGoogleChallenge(a.challengeId, a.browserToken, options);
  const results = await Promise.allSettled([consumeGoogleChallenge(a.challengeId, challenge.raw, options), consumeGoogleChallenge(a.challengeId, challenge.raw, options)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const b = await beginGoogleLogin('', clientId, options);
  mock.expiry.set(store.key('challenge', b.challengeId), Date.now() - 1);
  await assert.rejects(readGoogleChallenge(b.challengeId, b.browserToken, options), { code: 'INVALID_GOOGLE_REQUEST' });
});

test('concurrent first sign-ins create exactly one Google-only account and do not expose credentials', async () => {
  const { options, mock } = setup();
  const results = await Promise.all(Array.from({ length: 8 }, () => commitGoogleAccount(identity(), {}, options)));
  assert.equal(new Set(results.map((r) => r.user.id)).size, 1);
  assert.equal(results.filter((r) => r.created).length, 1);
  assert.equal(results[0].user.hasPassword, false);
  assert.deepEqual(results[0].user.authProviders, ['google']);
  assert.equal(results[0].user.emailMarketingConsent.status, 'not_subscribed');
  assert.equal('googleSubject' in results[0].user, false);
  assert.equal('passwordHash' in results[0].user, false);
  assert.equal(JSON.parse(mock.strings.get(accounts.userKey(results[0].user.id))).passwordHash, null);
});

test('same email across different Google subjects cannot automatically merge accounts', async () => {
  const { options } = setup();
  await commitGoogleAccount(identity(), {}, options);
  await assert.rejects(commitGoogleAccount(identity('100002'), {}, options), { code: 'LINK_CONFIRMATION_REQUIRED' });
  await assert.rejects(resolveGoogleIdentity(identity('100002'), options), { code: 'GOOGLE_ACCOUNT_CONFLICT' });
});

test('linking requires correct legacy password, retains user ID/history/consent, and consumes proof atomically', async () => {
  const { options } = setup();
  const existing = await registerAccount({ username: 'buyer', email: 'buyer@gmail.com', password: 'password-safe', emailMarketingConsent: true }, options);
  await saveAccountHistory(existing.id, { id: 'report', analyzedAt: new Date().toISOString(), fullReport: { product: { title: 'Test' } } }, options);
  assert.equal((await resolveGoogleIdentity(identity(), options)).kind, 'link_required');
  await assert.rejects(commitGoogleAccount(identity(), {}, options), { code: 'LINK_CONFIRMATION_REQUIRED' });
  const browser = 'b'.repeat(43);
  const { pendingId } = await createGooglePending(identity(), existing.id, browser, options);
  const pending = await readGooglePending(pendingId, browser, options);
  await assert.rejects(verifyGoogleLinkPassword(pendingId, pending, 'wrong', options), { code: 'INVALID_CREDENTIALS' });
  const passwordHash = await verifyGoogleLinkPassword(pendingId, pending, 'password-safe', options);
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => commitGoogleAccount(identity(), { pendingId, pending, passwordHash }, options)));
  const success = results.filter((r) => r.status === 'fulfilled');
  assert.equal(success.length, 1);
  assert.equal(success[0].value.user.id, existing.id);
  assert.equal(success[0].value.user.emailMarketingConsent.status, 'subscribed');
  assert.deepEqual(success[0].value.user.authProviders, ['password', 'google']);
  assert.equal((await listAccountHistory(existing.id, options))[0].id, 'report');
});

test('password changes between confirmation and link reject stale proof', async () => {
  const { options } = setup();
  const existing = await registerAccount({ username: 'buyer', email: 'buyer@gmail.com', password: 'password-safe' }, options);
  const browser = 'b'.repeat(43);
  const { pendingId } = await createGooglePending(identity(), existing.id, browser, options);
  const pending = await readGooglePending(pendingId, browser, options);
  const passwordHash = await verifyGoogleLinkPassword(pendingId, pending, 'password-safe', options);
  const reset = await createPasswordReset(existing.email, options);
  await resetAccountPassword({ requestId: reset.requestId, code: reset.code, password: 'new-password' }, options);
  await assert.rejects(commitGoogleAccount(identity(), { pendingId, pending, passwordHash }, options), { code: 'GOOGLE_REQUEST_CHANGED' });
});

test('third-party signup requires correct OTP; OTP and pending cannot be replayed', async () => {
  const { options } = setup();
  const claims = identity('100003', 'buyer@example.com');
  await assert.rejects(commitGoogleAccount(claims, {}, options), { code: 'EMAIL_CONFIRMATION_REQUIRED' });
  const browser = 'b'.repeat(43);
  const { pendingId } = await createGooglePending(claims, '', browser, options);
  const { code } = await createGoogleEmailCode(pendingId, browser, options);
  await assert.rejects(verifyGoogleEmailCode(pendingId, browser, '000000', options), { code: 'INVALID_EMAIL_CODE' });
  const pending = await verifyGoogleEmailCode(pendingId, browser, code, options);
  const result = await commitGoogleAccount(claims, { pendingId, pending }, options);
  assert.equal(result.created, true);
  await assert.rejects(commitGoogleAccount(claims, { pendingId, pending }, options), { code: 'GOOGLE_REQUEST_USED' });
});

test('OTP attempts do not reset after reaching the limit', async () => {
  const { options } = setup();
  const browser = 'b'.repeat(43);
  const { pendingId } = await createGooglePending(identity('123', 'buyer@example.com'), '', browser, options);
  const { code } = await createGoogleEmailCode(pendingId, browser, options);
  for (let i = 0; i < 5; i++) await assert.rejects(verifyGoogleEmailCode(pendingId, browser, '000000', options), { code: 'INVALID_EMAIL_CODE' });
  await assert.rejects(verifyGoogleEmailCode(pendingId, browser, code, options), { code: 'RATE_LIMITED' });
});

test('a previously verified pending flow does not accept a wrong OTP on retry', async () => {
  const { options } = setup();
  const browser = 'b'.repeat(43);
  const { pendingId } = await createGooglePending(identity('123', 'buyer@example.com'), '', browser, options);
  const { code } = await createGoogleEmailCode(pendingId, browser, options);
  await verifyGoogleEmailCode(pendingId, browser, code, options);
  await assert.rejects(verifyGoogleEmailCode(pendingId, browser, '000000', options), { code: 'INVALID_EMAIL_CODE' });
});

test('a legacy registration owning the email during Google creation is never overwritten', async () => {
  const { options, mock } = setup();
  mock.strings.set(accounts.emailKey('buyer@gmail.com'), 'legacy-registration-in-flight');
  await assert.rejects(commitGoogleAccount(identity(), {}, options), { code: 'LINK_CONFIRMATION_REQUIRED' });
  await assert.rejects(resolveGoogleIdentity(identity(), options), { code: 'ACCOUNT_BUSY' });
  assert.equal(mock.strings.get(accounts.emailKey('buyer@gmail.com')), 'legacy-registration-in-flight');
  assert.equal(mock.strings.has(store.subjectKey('100001')), false);
});

test('linking an existing account to two Google subjects concurrently succeeds only once', async () => {
  const { options } = setup();
  const existing = await registerAccount({ username: 'buyer', email: 'buyer@gmail.com', password: 'password-safe' }, options);
  const browser = 'b'.repeat(43);
  const requests = await Promise.all(['100001', '100002'].map(async (subject) => {
    const claims = identity(subject);
    const { pendingId } = await createGooglePending(claims, existing.id, browser, options);
    const pending = await readGooglePending(pendingId, browser, options);
    const passwordHash = await verifyGoogleLinkPassword(pendingId, pending, 'password-safe', options);
    return { claims, pendingId, pending, passwordHash };
  }));
  const outcomes = await Promise.allSettled(requests.map(({ claims, ...proof }) => commitGoogleAccount(claims, proof, options)));
  assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find((r) => r.status === 'rejected').reason.code, 'GOOGLE_ACCOUNT_CONFLICT');
});

test('link password attempts cannot exceed the pending budget', async () => {
  const { options } = setup();
  const existing = await registerAccount({ username: 'buyer', email: 'buyer@gmail.com', password: 'password-safe' }, options);
  const browser = 'b'.repeat(43);
  const { pendingId } = await createGooglePending(identity(), existing.id, browser, options);
  const pending = await readGooglePending(pendingId, browser, options);
  for (let i = 0; i < 5; i++) await assert.rejects(verifyGoogleLinkPassword(pendingId, pending, 'wrong', options), { code: 'INVALID_CREDENTIALS' });
  await assert.rejects(verifyGoogleLinkPassword(pendingId, pending, 'password-safe', options), { code: 'RATE_LIMITED' });
});

test('verified email recovery adds a first password without replacing the Google account', async () => {
  const { options, mock } = setup();
  const { user } = await commitGoogleAccount(identity(), {}, options);
  const reset = await createPasswordReset(user.email, options);
  assert.equal(reset.user.id, user.id);
  assert.equal(reset.user.hasPassword, false);
  const oldSession = await createAccountSession(user, options);
  await saveAccountHistory(user.id, { id: 'before-password', analyzedAt: new Date().toISOString(), fullReport: { product: { title: 'Same account' } } }, options);
  const updated = await resetAccountPassword({ requestId: reset.requestId, code: reset.code, password: 'password-new' }, options);
  assert.equal(updated.id, user.id);
  assert.equal(updated.hasPassword, true);
  assert.deepEqual(updated.authProviders, ['password', 'google']);
  assert.equal((await authenticateAccount({ identifier: user.email.toUpperCase(), password: 'password-new' }, options)).id, user.id);
  assert.equal((await resolveGoogleIdentity(identity(), options)).user.id, user.id);
  assert.equal((await listAccountHistory(user.id, options))[0].id, 'before-password');
  assert.equal(await getAccountFromSession(oldSession.token, options), null);
  const forged = { userId: user.id, expiresAt: Date.now() + 60_000, salt: 'test', codeHash: store.digest('test:123456') };
  mock.strings.set(accounts.passwordResetKey('old-reset'), JSON.stringify(forged));
  await assert.rejects(resetAccountPassword({ requestId: 'old-reset', code: '123456', password: 'password-new' }, options), { code: 'INVALID_RESET_CODE' });
});

test('consent and password reset preserve provider fields after linking', async () => {
  const { options, mock } = setup();
  const existing = await registerAccount({ username: 'buyer', email: 'buyer@gmail.com', password: 'password-safe' }, options);
  const browser = 'b'.repeat(43);
  const { pendingId } = await createGooglePending(identity(), existing.id, browser, options);
  const pending = await readGooglePending(pendingId, browser, options);
  const passwordHash = await verifyGoogleLinkPassword(pendingId, pending, 'password-safe', options);
  await commitGoogleAccount(identity(), { pendingId, pending, passwordHash }, options);
  const reset = await createPasswordReset(existing.email, options);
  await Promise.all([
    acceptEmailMarketingConsent(existing.id, options),
    resetAccountPassword({ requestId: reset.requestId, code: reset.code, password: 'password-new' }, options)
  ]);
  const stored = JSON.parse(mock.strings.get(accounts.userKey(existing.id)));
  assert.equal(stored.googleSubject, '100001');
  assert.equal(stored.emailMarketingConsent.status, 'subscribed');
});

test('Google email change does not change stored email or admin permissions', async () => {
  const { options } = setup();
  const created = await commitGoogleAccount(identity(), {}, options);
  const returned = await resolveGoogleIdentity(identity('100001', 'admin@gmail.com'), options);
  assert.equal(returned.user.id, created.user.id);
  assert.equal(returned.user.email, 'buyer@gmail.com');
  assert.equal(resolveBlogRole(returned.user, { BLOG_ADMIN_EMAILS: 'admin@gmail.com' }), null);
});

test('API signs in, rotates the existing session, rejects replay, and returns compatible public user', async () => {
  const { handler, options } = setup();
  const { response, cookie } = await loginStart(handler);
  const body = { action: 'authenticate', challengeId: response.body.challengeId, credential: token(response.body.nonce) };
  const logged = await request(handler, body, { cookie });
  assert.equal(logged.statusCode, 201);
  assert.equal(logged.body.status, 'signed_in');
  assert.equal(logged.body.user.hasPassword, false);
  assert.deepEqual(logged.body.user.authProviders, ['google']);
  assert.match(logged.headers['set-cookie'], /HttpOnly; SameSite=Lax; Secure/);
  const sessionToken = logged.headers['set-cookie'].match(/realview_session=([^;]+)/)[1];
  assert.equal((await getAccountFromSession(sessionToken, options)).id, logged.body.user.id);
  assert.equal((await request(handler, body, { cookie })).statusCode, 401);
  const next = await loginStart(handler, cookie);
  const again = await request(handler, { action: 'authenticate', challengeId: next.response.body.challengeId, credential: token(next.response.body.nonce) }, { cookie: `${cookie}; realview_session=${sessionToken}` });
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.user.id, logged.body.user.id);
  assert.equal(again.body.user.hasPassword, false);
  assert.equal(await getAccountFromSession(sessionToken, options), null);
});

test('API requires same-origin and browser binding and fails closed on bad bodies', async () => {
  const { handler } = setup();
  for (const headers of [{ origin: '' }, { origin: 'https://attacker.test' }, { origin: 'http://www.realview.com.vn' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await request(handler, { action: 'begin' }, { headers })).statusCode, 403);
  }
  for (const body of ['{bad', null, [], { action: 'unknown' }, { action: 'begin', extra: 'x'.repeat(21_000) }]) {
    assert.ok((await request(handler, body)).statusCode >= 400);
  }
  const { response } = await loginStart(handler);
  const result = await request(handler, { action: 'authenticate', challengeId: response.body.challengeId, credential: token(response.body.nonce) });
  assert.equal(result.statusCode, 401);
});

test('disabled config, unsupported methods, infrastructure errors, and rate limiting are handled', async () => {
  const disabled = createGoogleAuthHandler({ env: {} });
  assert.deepEqual((await request(disabled, null, { method: 'GET' })).body, { enabled: false, clientId: null });
  assert.equal((await request(disabled, { action: 'begin' })).statusCode, 503);
  assert.equal((await request(disabled, null, { method: 'DELETE' })).statusCode, 405);
  const broken = createGoogleAuthHandler({ env, fetchImpl: async () => { throw new Error('secret redis credential'); } });
  const failed = await request(broken, { action: 'begin' });
  assert.equal(failed.statusCode, 503);
  assert.doesNotMatch(failed.body.error, /secret/);
  const { handler } = setup();
  for (let i = 0; i < 20; i++) assert.equal((await request(handler, { action: 'begin' })).statusCode, 200);
  assert.equal((await request(handler, { action: 'begin' })).statusCode, 429);
});

test('API asks for linking without creating a session, then accepts only verified password', async () => {
  const { options, handler } = setup();
  const existing = await registerAccount({ username: 'buyer', email: 'buyer@gmail.com', password: 'password-safe' }, options);
  const { response, cookie } = await loginStart(handler);
  const auth = await request(handler, { action: 'authenticate', challengeId: response.body.challengeId, credential: token(response.body.nonce) }, { cookie });
  assert.equal(auth.body.status, 'link_required');
  assert.equal(auth.headers['set-cookie'], undefined);
  const bad = await request(handler, { action: 'link_account', pendingId: auth.body.pendingId, password: 'wrong' }, { cookie });
  assert.equal(bad.statusCode, 401);
  const linked = await request(handler, { action: 'link_account', pendingId: auth.body.pendingId, password: 'password-safe' }, { cookie });
  assert.equal(linked.statusCode, 200);
  assert.equal(linked.body.user.id, existing.id);
});

test('API sends OTP only by mail, denies cross-browser use, and supports explicit guest history consent', async () => {
  let emailCode; let transferred = 0;
  const { handler } = setup({
    sendCode: async (email, code, purpose) => { assert.equal(purpose, 'google_login'); emailCode = code; return { delivered: true }; },
    claimGuestHistory: async () => { transferred++; return 2; }
  });
  const { response, cookie } = await loginStart(handler);
  const auth = await request(handler, { action: 'authenticate', challengeId: response.body.challengeId, credential: token(response.body.nonce, { email: 'buyer@example.com' }) }, { cookie });
  assert.equal(auth.body.status, 'email_required');
  const sent = await request(handler, { action: 'request_email_verification', pendingId: auth.body.pendingId }, { cookie });
  assert.equal(sent.statusCode, 200);
  assert.equal('code' in sent.body, false);
  assert.equal((await request(handler, { action: 'verify_email', pendingId: auth.body.pendingId, code: emailCode })).statusCode, 401);
  const verified = await request(handler, { action: 'verify_email', pendingId: auth.body.pendingId, code: emailCode, claimGuestHistory: true }, { cookie });
  assert.equal(verified.statusCode, 201);
  assert.equal(verified.body.claimedGuestHistory, 2);
  assert.equal(transferred, 1);
});

test('Google backend is routed locally and on Vercel without adding frontend scripts', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.equal(config.functions['api/auth.mjs'].maxDuration, 30);
  assert.equal(config.functions['api/auth-google.mjs'], undefined);
  assert.ok(config.rewrites.some((r) => r.source === '/api/auth-google' && r.destination === '/api/auth.mjs?authProvider=google'));
  const server = await readFile(new URL('../tools/local-server.mjs', import.meta.url), 'utf8');
  assert.match(server, /apiPath === '\/api\/auth-google'/);
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /accounts\.google\.com\/gsi\/client/);
});

test('OTP delivery failure does not sign in and resend invalidates the previous code', async () => {
  const failedSetup = setup({ sendCode: async () => ({ delivered: false }) });
  const { handler, options } = failedSetup;
  const browser = 'b'.repeat(43);
  const { pendingId } = await createGooglePending(identity('123', 'buyer@example.com'), '', browser, options);
  const cookie = `realview_google_browser=${browser}`;
  const failed = await request(handler, { action: 'request_email_verification', pendingId }, { cookie });
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.headers['set-cookie'], undefined);
  const first = await createGoogleEmailCode(pendingId, browser, options);
  const second = await createGoogleEmailCode(pendingId, browser, options);
  if (first.code !== second.code) await assert.rejects(verifyGoogleEmailCode(pendingId, browser, first.code, options), { code: 'INVALID_EMAIL_CODE' });
  assert.equal((await verifyGoogleEmailCode(pendingId, browser, second.code, options)).record.otp.verified, true);
});

test('local origins are allowed only for local execution, preview origins must be configured', async () => {
  const local = setup().handler;
  const localHeaders = { origin: 'http://localhost:3137', host: 'localhost:3137', 'x-forwarded-proto': 'http' };
  assert.equal((await request(local, { action: 'begin' }, { headers: localHeaders })).statusCode, 200);
  const prod = setup({ env: { ...env, VERCEL: '1' } }).handler;
  assert.equal((await request(prod, { action: 'begin' }, { headers: localHeaders })).statusCode, 403);
  const previewHeaders = { origin: 'https://preview.example.com', host: 'preview.example.com' };
  assert.equal((await request(local, { action: 'begin' }, { headers: previewHeaders })).statusCode, 403);
  const preview = setup({ env: { ...env, GOOGLE_AUTH_ALLOWED_ORIGINS: 'https://preview.example.com' } }).handler;
  assert.equal((await request(preview, { action: 'begin' }, { headers: previewHeaders })).statusCode, 200);
});
