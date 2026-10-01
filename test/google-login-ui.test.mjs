import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { generateKeyPairSync, sign } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { redisLuaMock } from './helpers/redis-lua.mjs';
import { createAccountAuthHandler } from '../api/auth.mjs';
import { createGoogleAuthHandler } from '../src/google-auth-route.mjs';
import { registerAccount, saveAccountHistory, listAccountHistory } from '../src/account-store.mjs';
import { commitGoogleAccount } from '../src/google-auth-store.mjs';

// DOM integration only: no browser automation, real mailbox or external Redis.
test('approved UI and real handlers complete Google/password/link/OTP/error flows', async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const origin = 'http://localhost:3137';
  const dom = new JSDOM('<!doctype html><body><header class="site-header"><div class="header-inner"><div data-auth-controls></div></div></header></body>', { url: origin });
  const originals = Object.fromEntries(['window', 'document', 'FormData', 'CustomEvent', 'ResizeObserver', 'fetch'].map(key => [key, globalThis[key]]));
  const { window } = dom;
  window.matchMedia = () => ({ matches: false });
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
  Object.assign(globalThis, { window, document: window.document, FormData: window.FormData, CustomEvent: window.CustomEvent,
    ResizeObserver: class { observe() {} disconnect() {} } });
  const mock = redisLuaMock(); const emails = [], requests = [], cookies = new Map();
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const client = new OAuth2Client();
  client.getFederatedSignonCertsAsync = async () => ({ certs: { ui: publicKey.export({ type: 'spki', format: 'pem' }) } });
  const clientId = '154335934284-1fupk8riad0u56jughvv73pep358hdft.apps.googleusercontent.com';
  const options = { fetchImpl: mock.fetchImpl, client, env: { GOOGLE_CLIENT_ID: clientId },
    sendReset: async (user, code) => { emails.push({ email: user.email, code }); return { delivered: true }; },
    sendCode: async (email, code) => { emails.push({ email, code }); return { delivered: true }; },
    sendWelcome: async () => {}, discardGuestHistory: async () => {}, claimGuestHistory: async () => 0 };
  const identity = { subject: 'ui-google', email: 'googlebuyer@gmail.com', name: 'Google Buyer', authoritativeEmail: true };
  const { user: googleUser } = await commitGoogleAccount(identity, {}, options);
  const legacy = await registerAccount({ username: 'LegacyBuyer', email: 'legacy@example.com', password: 'existing-password' }, options);
  await saveAccountHistory(googleUser.id, { id: 'original-history', analyzedAt: new Date().toISOString(), fullReport: { product: { title: 'Preserved' } } }, options);
  const handlers = { '/api/auth': createAccountAuthHandler(options), '/api/auth-google': createGoogleAuthHandler(options) };
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url, action: init.body && JSON.parse(init.body).action });
    if (url === '/api/admin-blog?action=access') return { ok: true, json: async () => ({ role: null }) };
    const result = { status: 200, headers: {} };
    await handlers[url]({ method: init.method || 'GET', body: init.body,
      headers: { origin, host: 'localhost:3137', cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') }, socket: { remoteAddress: 'ui-test' } }, {
      setHeader(name, value) { result.headers[name.toLowerCase()] = value; }, status(code) { result.status = code; return this; }, json(body) { result.body = body; }
    });
    for (const header of [result.headers['set-cookie']].flat().filter(Boolean)) {
      const [key, value] = header.split(';')[0].split('='); value ? cookies.set(key, value) : cookies.delete(key);
    }
    return { ok: result.status < 400, status: result.status, json: async () => result.body };
  };
  let sdkConfig, googleKind = 'google';
  const renderedButtons = [];
  const credential = () => {
    if (googleKind === 'error') return 'invalid-token';
    const value = googleKind === 'new' ? { subject: 'ui-new', email: 'newbuyer@gmail.com', name: 'New Buyer' }
      : googleKind === 'new_login' ? { subject: 'ui-new-login', email: 'newlogin@gmail.com', name: 'New Login' }
      : googleKind === 'legacy' ? { subject: 'ui-linked', email: legacy.email, name: 'Legacy Buyer' }
      : googleKind === 'external' ? { subject: 'ui-external', email: 'external@example.net', name: 'External Buyer' } : identity;
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'ui' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: clientId, sub: value.subject, email: value.email,
      name: value.name, email_verified: true, nonce: sdkConfig.nonce, iat: now, exp: now + 300 })).toString('base64url');
    const input = `${header}.${claims}`; return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
  };
  window.google = { accounts: { id: { initialize(config) { sdkConfig = config; }, cancel() {}, disableAutoSelect() {},
    renderButton(slot, config) { renderedButtons.push(config); const button = window.document.createElement('button'); button.dataset.testGoogle = '';
      button.textContent = config.text === 'signup_with' ? 'Đăng ký bằng Google' : 'Đăng nhập bằng Google';
      button.onclick = () => { void sdkConfig.callback({ credential: credential() }); }; slot.append(button); } } } };
  const q = selector => window.document.querySelector(selector);
  const wait = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('UI transition did not complete'); };
  const submit = form => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const dismissMarketing = () => { if (q('#marketing-consent-dialog')?.open) q('[data-marketing-consent-dismiss]').click(); };
  try {
    const auth = await import(`../public/auth.js?dom-integration=${Date.now()}`);
    await auth.getCurrentUser();
    assert.equal(requests.some(r => r.url === '/api/auth-google'), false, 'Google is not fetched on homepage initialization');
    auth.openAuthDialog(); await wait(() => q('[data-test-google]'));
    assert.equal(renderedButtons.at(-1).text, 'signin_with');
    assert.equal(q('[data-google-button]').getAttribute('aria-label'), 'Đăng nhập bằng tài khoản Google');
    assert.match(q('.google-purpose').textContent, /Không cần tạo mật khẩu RealView/);
    // Switching tabs reuses the nonce but must update the official button text.
    const initialChallenge = sdkConfig.nonce;
    q('[data-auth-tab="register"]').click();
    await wait(() => renderedButtons.at(-1).text === 'signup_with');
    assert.equal(sdkConfig.nonce, initialChallenge);
    assert.equal(q('[data-google-button]').getAttribute('aria-label'), 'Đăng ký bằng tài khoản Google');
    googleKind = 'new';
    const beforeSignup = requests.length;
    q('[data-test-google]').click(); await wait(() => !q('#account-dialog').open); dismissMarketing();
    const firstGoogleUser = await auth.getCurrentUser();
    assert.equal(firstGoogleUser.email, 'newbuyer@gmail.com');
    assert.equal(firstGoogleUser.hasPassword, false);
    assert.deepEqual(firstGoogleUser.authProviders, ['google']);
    assert.deepEqual(requests.slice(beforeSignup).filter(r => r.url === '/api/auth-google').map(r => r.action), ['authenticate']);
    assert.equal(requests.slice(beforeSignup).some(r => /password|registration/.test(r.action || '')), false);
    q('[data-auth-logout]').click(); await wait(() => q('[data-auth-open]'));
    // The login tab accepts the account created through the register tab.
    auth.openAuthDialog(); await wait(() => q('[data-test-google]'));
    assert.equal(renderedButtons.at(-1).text, 'signin_with');
    q('[data-test-google]').click(); await wait(() => !q('#account-dialog').open); dismissMarketing();
    assert.equal((await auth.getCurrentUser()).id, firstGoogleUser.id);
    assert.equal((await auth.getCurrentUser()).hasPassword, false);
    q('[data-auth-logout]').click(); await wait(() => q('[data-auth-open]'));
    // Also sign in a never-seen Google identity from the login tab.
    googleKind = 'new_login';
    auth.openAuthDialog(); await wait(() => q('[data-test-google]'));
    q('[data-test-google]').click(); await wait(() => !q('#account-dialog').open); dismissMarketing();
    assert.equal((await auth.getCurrentUser()).email, 'newlogin@gmail.com');
    assert.equal((await auth.getCurrentUser()).hasPassword, false);
    q('[data-auth-logout]').click(); await wait(() => q('[data-auth-open]'));
    googleKind = 'google';
    auth.openAuthDialog(); await wait(() => q('[data-test-google]'));
    q('[data-test-google]').click(); await wait(() => !q('#account-dialog').open); dismissMarketing();
    assert.equal((await auth.getCurrentUser()).id, googleUser.id);
    assert.equal(q('[data-auth-password]').textContent, 'Thêm mật khẩu RealView');
    q('[data-auth-password]').click();
    const settings = q('[data-auth-form="request_password_change"]');
    assert.equal(settings.elements.email.readOnly, true);
    submit(settings); await wait(() => q('#account-dialog').dataset.mode === 'reset_password');
    const reset = q('[data-auth-form="reset_password"]');
    reset.elements.code.value = emails.at(-1).code;
    reset.elements.password.value = 'new-local-password'; reset.elements.passwordConfirm.value = 'different-password';
    submit(reset); await wait(() => !reset.querySelector('[data-auth-error]').hidden);
    assert.match(reset.querySelector('[data-auth-error]').textContent, /chưa trùng khớp/);
    reset.elements.passwordConfirm.value = 'new-local-password'; submit(reset);
    await wait(() => !q('#account-dialog').open); dismissMarketing();
    assert.equal(q('[data-auth-password]').textContent, 'Đổi mật khẩu');
    assert.equal((await auth.getCurrentUser()).id, googleUser.id);
    assert.deepEqual((await auth.getCurrentUser()).authProviders, ['password', 'google']);
    assert.equal((await listAccountHistory(googleUser.id, options))[0].id, 'original-history');
    q('[data-auth-logout]').click(); await wait(() => q('[data-auth-open]'));
    auth.openAuthDialog();
    const login = q('[data-auth-form="login"]'); login.elements.identifier.value = 'GOOGLEBUYER@GMAIL.COM'; login.elements.password.value = 'new-local-password';
    submit(login); await wait(() => !q('#account-dialog').open); dismissMarketing();
    assert.equal((await auth.getCurrentUser()).id, googleUser.id);
    q('[data-auth-logout]').click(); await wait(() => q('[data-auth-open]'));
    auth.openAuthDialog(); await wait(() => q('[data-test-google]'));
    googleKind = 'legacy'; q('[data-test-google]').click(); await wait(() => q('#account-dialog').dataset.mode === 'google_link');
    const link = q('[data-auth-form="google_link"]'); link.elements.password.value = 'wrong-password'; submit(link);
    await wait(() => !link.querySelector('[data-auth-error]').hidden);
    assert.equal(await auth.getCurrentUser(), null); // remains signed out
    link.elements.password.value = 'existing-password'; submit(link); await wait(() => !q('#account-dialog').open); dismissMarketing();
    assert.equal((await auth.getCurrentUser()).id, legacy.id);
    q('[data-auth-logout]').click(); await wait(() => q('[data-auth-open]'));
    auth.openAuthDialog(); await wait(() => q('[data-test-google]')); googleKind = 'external'; q('[data-test-google]').click();
    await wait(() => q('#account-dialog').dataset.mode === 'google_email_request');
    submit(q('[data-auth-form="google_email_request"]')); await wait(() => q('#account-dialog').dataset.mode === 'google_email_verify');
    const verification = q('[data-auth-form="google_email_verify"]'); verification.elements.code.value = emails.at(-1).code; submit(verification);
    await wait(() => !q('#account-dialog').open); dismissMarketing(); assert.equal((await auth.getCurrentUser()).hasPassword, false);
    q('[data-auth-logout]').click(); await wait(() => q('[data-auth-open]'));
    auth.openAuthDialog(); await wait(() => q('[data-test-google]')); googleKind = 'error'; q('[data-test-google]').click();
    await wait(() => !q('[data-google-error]').hidden);
    assert.equal(q('[data-auth-form="login"]').hidden, false);
    assert.equal(q('[data-auth-form="login"] [type="submit"]').disabled, false);
    assert.equal(q('#account-dialog').getAttribute('aria-busy'), 'false');
    auth.closeAuthDialog();
    assert.equal(q('[data-auth-form="login"]').elements.password.value, '');
    assert.equal(window.localStorage.length, 0); assert.equal(window.sessionStorage.length, 0);
    assert.equal((await auth.getCurrentUser()), null);
  } finally { dom.window.close(); Object.assign(globalThis, originals); }
});
