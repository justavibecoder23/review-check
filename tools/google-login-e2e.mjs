// Local-only integration harness. Never served by the production application.
// Real Google verification + real Redis REST; all Redis keys are namespaced.
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { createGoogleAuthHandler } from '../src/google-auth-route.mjs';
import { readSessionToken, sessionCookie } from '../api/auth.mjs';
import * as accounts from '../src/account-store.mjs';
import * as googleStore from '../src/google-auth-store.mjs';
import { redisCommand } from '../src/redis-rest.mjs';

if (process.argv.includes('--vercel-redis')) {
  // Only these two selected environment values enter process memory.
  const project = 'prj_JgsU3RUeOG2pQ543INoVpslfrleE';
  const team = 'team_qC5riAr1mMNGxndFQ0NLe60H';
  for (const [name, id] of [['KV_REST_API_URL', 'DxF60A4h442O7smI'], ['KV_REST_API_TOKEN', '8JlztFZEbUsSo9C2']]) {
    try {
      const raw = execFileSync('/opt/homebrew/bin/vercel', ['api', `/v1/projects/${project}/env/${id}?teamId=${team}`, '--raw'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
      });
      const value = JSON.parse(raw);
      assert.equal(value.key, name);
      assert.equal(typeof value.value, 'string');
      process.env[name] = value.value;
    } catch { throw new Error(`Cannot read selected Redis variable: ${name}`); }
  }
}
process.env.GOOGLE_CLIENT_ID ||= '154335934284-1fupk8riad0u56jughvv73pep358hdft.apps.googleusercontent.com';
const namespace = `realview:e2e:${randomUUID()}`;
const env = { GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID };
const checks = [];
let redisRequests = 0;
let signedInAccount = null;
const check = (name, condition) => { assert.ok(condition, name); checks.push({ name, passed: true }); };
const prefixes = ['realview:account:v1', 'realview:google-auth:v1'];
const fetchImpl = async (url, init) => {
  const map = (v) => Array.isArray(v) ? v.map(map) : typeof v === 'string'
    ? prefixes.reduce((s, p, i) => s.startsWith(p) ? namespace + (i ? ':google-auth' : ':account') + s.slice(p.length) : s, v) : v;
  const body = map(JSON.parse(init.body));
  redisRequests++;
  return fetch(url, { ...init, body: JSON.stringify(body) });
};
const options = { fetchImpl, env, timeoutMs: 10000 };
const ownedKeys = async () => {
  let cursor = '0';
  const keys = [];
  do {
    const result = await redisCommand(['SCAN', cursor, 'MATCH', namespace + ':*', 'COUNT', 100], { timeoutMs: 10000 });
    cursor = String(result[0]);
    for (const key of result[1]) { assert.ok(key.startsWith(namespace + ':')); keys.push(key); }
  } while (cursor !== '0');
  return [...new Set(keys)];
};
const expireOwnedKeys = async () => {
  for (const key of await ownedKeys()) await redisCommand(['EXPIRE', key, 1800], { timeoutMs: 10000 });
};
const cleanup = async () => {
  const keys = await ownedKeys();
  if (keys.length) await redisCommand(['DEL', ...keys], { timeoutMs: 10000 });
  check('cleanup: isolated test keys removed', (await ownedKeys()).length === 0);
};

async function redisIntegration() {
  check('real Redis REST responds to PING', await redisCommand(['PING'], options) === 'PONG');
  const browser = randomBytes(32).toString('base64url');
  const challenge = await googleStore.beginGoogleLogin(browser, env.GOOGLE_CLIENT_ID, options);
  const stored = await googleStore.readGoogleChallenge(challenge.challengeId, browser, options);
  check('challenge stored and read from real Redis', stored.record.nonce === challenge.nonce);
  check('challenge has Redis expiration', await redisCommand(['TTL', googleStore.googleAuthStoreInternals.key('challenge', challenge.challengeId)], options) > 0);
  await assert.rejects(() => googleStore.readGoogleChallenge(challenge.challengeId, randomBytes(32).toString('base64url'), options));
  checks.push({ name: 'challenge rejects another browser', passed: true });
  const attempts = await Promise.allSettled([1, 2].map(() => googleStore.consumeGoogleChallenge(challenge.challengeId, stored.raw, options)));
  check('real Lua: concurrent consumption permits exactly one request', attempts.filter(r => r.status === 'fulfilled').length === 1);
  const identity = { subject: `e2e_${randomUUID()}`, email: `e2e.${randomUUID()}@gmail.com`, name: 'Disposable Redis test', authoritativeEmail: true };
  const commits = await Promise.all([1, 2].map(() => googleStore.commitGoogleAccount(identity, {}, options)));
  check('real Lua: concurrent account creation has one account ID', commits[0].user.id === commits[1].user.id);
  check('Google account does not opt into marketing', commits[0].user.emailMarketingConsent.status === 'not_subscribed');
  const session = await accounts.createAccountSession(commits[0].user, options);
  check('session authenticates against real Redis', (await accounts.getAccountFromSession(session.token, options)).id === commits[0].user.id);
  await accounts.deleteAccountSession(session.token, options);
  check('logout invalidates Redis session', await accounts.getAccountFromSession(session.token, options) === null);
  // Store-level cases use disposable identities, not simulated Google tokens.
  const legacyIdentity = { ...identity, subject: `e2e_${randomUUID()}`, email: `e2e.${randomUUID()}@gmail.com` };
  const password = 'Disposable.E2E.Password.123';
  const legacy = await accounts.registerAccount({ username: `e2e_${randomBytes(8).toString('hex')}`, email: legacyIdentity.email, password }, options);
  await accounts.saveAccountHistory(legacy.id, { id:'e2e-history', analyzedAt:new Date().toISOString(), fullReport:{product:{name:'Disposable test'}} }, options);
  check('same-email legacy account requires explicit linking', (await googleStore.resolveGoogleIdentity(legacyIdentity, options)).kind === 'link_required');
  const link = await googleStore.createGooglePending(legacyIdentity, legacy.id, browser, options);
  const pending = await googleStore.readGooglePending(link.pendingId, browser, options);
  await assert.rejects(() => googleStore.verifyGoogleLinkPassword(link.pendingId, pending, 'incorrect', options), { code:'INVALID_CREDENTIALS' });
  check('real Redis linking rejects wrong password', true);
  const passwordHash = await googleStore.verifyGoogleLinkPassword(link.pendingId, pending, password, options);
  const linked = await googleStore.commitGoogleAccount(legacyIdentity, { pendingId:link.pendingId, pending, passwordHash }, options);
  check('real Lua linking preserves legacy ID and password provider', linked.user.id === legacy.id && linked.user.authProviders.includes('password') && linked.user.authProviders.includes('google'));
  check('linking preserves existing history in real Redis', (await accounts.listAccountHistory(legacy.id, options))[0].id === 'e2e-history');
  await assert.rejects(() => googleStore.readGooglePending(link.pendingId, browser, options));
  check('linked pending proof is consumed', true);
  const thirdParty = { ...identity, subject:`e2e_${randomUUID()}`, email:`e2e.${randomUUID()}@example.invalid`, authoritativeEmail:false };
  await assert.rejects(() => googleStore.commitGoogleAccount(thirdParty, {}, options), { code:'EMAIL_CONFIRMATION_REQUIRED' });
  check('third-party email cannot create account without mailbox proof', true);
  const emailPending = await googleStore.createGooglePending(thirdParty, '', browser, options);
  const code = await googleStore.createGoogleEmailCode(emailPending.pendingId, browser, options);
  await assert.rejects(() => googleStore.verifyGoogleEmailCode(emailPending.pendingId, browser, '000000', options), { code:'INVALID_EMAIL_CODE' });
  check('real Lua email verification rejects wrong OTP', true);
  const verified = await googleStore.verifyGoogleEmailCode(emailPending.pendingId, browser, code.code, options);
  const emailKey = googleStore.googleAuthStoreInternals.key('pending', emailPending.pendingId);
  check('real Redis KEEPTTL preserves OTP expiry', await redisCommand(['TTL', emailKey], options) > 0);
  const thirdAccount = await googleStore.commitGoogleAccount(thirdParty, {pendingId:emailPending.pendingId, pending:verified}, options);
  check('verified OTP commits account atomically', thirdAccount.created && thirdAccount.user.hasPassword === false);
  await assert.rejects(() => googleStore.commitGoogleAccount(thirdParty, {pendingId:emailPending.pendingId, pending:verified}, options), {code:'GOOGLE_REQUEST_USED'});
  check('real Lua OTP proof cannot be replayed', true);
  const consent = await accounts.acceptEmailMarketingConsent(linked.user.id, options);
  check('real Lua consent update preserves Google linkage', consent.emailMarketingConsent.status === 'subscribed' && consent.authProviders.includes('google'));
  await expireOwnedKeys();
  console.log(JSON.stringify({ phase: 'real-redis-integration', checks, namespace, redisRequests }));
}

const handler = createGoogleAuthHandler({ ...options,
  // Do not send real welcome mail or touch production guest-history data.
  sendWelcome: async () => {}, discardGuestHistory: async () => {}, claimGuestHistory: async () => 0
});
const port = Number(process.env.GOOGLE_E2E_PORT || 3000);
const origin = `http://localhost:${port}`;
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
  try {
    if (req.url === '/' && req.method === 'GET') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(await readFile(new URL('./google-login-e2e.html', import.meta.url)));
    }
    const mutating = req.method === 'POST';
    if (mutating && (req.headers.host !== `localhost:${port}` || req.headers.origin !== origin)) return res.status(403).json({ error: 'Local E2E origin required' });
    if (mutating) {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 20000) throw new Error('Body too large'); }
      req.body = body;
    }
    if (req.url === '/api/auth-google') {
      // Record only non-sensitive assertions, never tokens or Google claims.
      const send = res.json;
      res.json = (data) => {
        if (data.status === 'signed_in') {
          check('actual Google credential verified by official library', true);
          if (signedInAccount) check('returning Google login keeps account ID', signedInAccount === data.user.id);
          signedInAccount = data.user.id;
          check('session cookie is HttpOnly + SameSite=Lax', /HttpOnly/.test(res.getHeader('Set-Cookie')) && /SameSite=Lax/.test(res.getHeader('Set-Cookie')));
          console.log(JSON.stringify({ phase: 'actual-google-login', created: data.created, redisRequests, checks }));
          void expireOwnedKeys().catch(() => console.error('E2E key expiration failed; cleanup is still required.'));
        }
        return send(data);
      };
      return handler(req, res);
    }
    if (req.url === '/e2e/session') {
      const user = await accounts.getAccountFromSession(readSessionToken(req), options);
      if (user) check('browser cookie loads Google account from real Redis', user.id === signedInAccount);
      return res.json({ authenticated: Boolean(user), checks, redisRequests });
    }
    if (req.url === '/e2e/logout' && mutating) {
      const token = readSessionToken(req);
      await accounts.deleteAccountSession(token, options);
      check('Google browser session removed from Redis at logout', !await accounts.getAccountFromSession(token, options));
      res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
      return res.json({ authenticated: false, checks });
    }
    if (req.url === '/e2e/report') return res.json({ namespace, checks, redisRequests });
    res.status(404).json({ error: 'Not found' });
  } catch { res.status(500).json({ error: 'E2E assertion or service failed; no secrets logged' }); }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  server.close();
  try { await cleanup(); console.log(JSON.stringify({ phase: 'cleanup', checks })); process.exit(0); }
  catch { console.error('Test namespace cleanup failed; inspect namespace printed at startup.'); process.exit(1); }
});
try {
  await redisIntegration();
  if (process.argv.includes('--redis-only')) {
    await cleanup();
    console.log(JSON.stringify({ phase:'cleanup', namespace, keysRemaining:0 }));
  }
  else server.listen(port, '127.0.0.1', () => console.log(`GOOGLE_E2E_READY ${origin}`));
} catch (e) {
  console.error(`E2E setup failed: ${e.name}; secret values withheld.`);
  await cleanup().catch(() => {});
  process.exitCode = 1;
}
