// Local-only QA server: real application UI/handlers, disposable in-memory Redis
// and an intercepted mailbox. Never import this file from production routes.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { redisLuaMock } from '../test/helpers/redis-lua.mjs';
import { createAccountAuthHandler, currentAccount } from '../api/auth.mjs';
import { createGoogleAuthHandler } from '../api/auth-google.mjs';
import { commitGoogleAccount } from '../src/google-auth-store.mjs';
import { registerAccount, saveAccountHistory, listAccountHistory } from '../src/account-store.mjs';

const port = Number(process.env.ACCOUNT_UI_TEST_PORT || 3146);
const origin = `http://localhost:${port}`;
const mockGoogle = process.argv.includes('--mock-google');
process.env.UPSTASH_REDIS_REST_URL = 'https://memory.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'disposable-test-only';
const clientId = '154335934284-1fupk8riad0u56jughvv73pep358hdft.apps.googleusercontent.com';
const mock = redisLuaMock();
const emails = [];
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const client = new OAuth2Client();
client.getFederatedSignonCertsAsync = async () => ({ certs: { qa: publicKey.export({ type: 'spki', format: 'pem' }) } });
const options = {
  fetchImpl: mock.fetchImpl,
  env: { GOOGLE_CLIENT_ID: clientId, GOOGLE_LOGIN_ENABLED: 'true' },
  ...(mockGoogle ? { client } : {}),
  sendReset: async (user, code) => { emails.push({ email: user.email, code, purpose: 'password' }); return { delivered: true }; },
  sendCode: async (email, code) => { emails.push({ email, code, purpose: 'verification' }); return { delivered: true }; },
  sendWelcome: async () => ({ delivered: true }),
  discardGuestHistory: async () => {}, claimGuestHistory: async () => 0
};
const googleFixture = { subject: 'qa-google-buyer', email: 'reviewer@gmail.com', name: 'Người mua thử', authoritativeEmail: true };
const googleAccount = await commitGoogleAccount(googleFixture, {}, options);
const legacyAccount = await registerAccount({ username: 'LegacyBuyer', email: 'legacy@example.com', password: 'qa-existing-password' }, options);
for (const user of [googleAccount.user, legacyAccount]) await saveAccountHistory(user.id, {
  id: 'qa-preserved-history', analyzedAt: new Date().toISOString(), title: 'Kết quả thử nghiệm', fullReport: { product: { title: 'Kết quả thử nghiệm' }, reviews: [] }
}, options);
const accountHandler = createAccountAuthHandler(options);
const googleHandler = createGoogleAuthHandler(options);
const publicRoot = resolve(new URL('../public', import.meta.url).pathname);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml' };
const sdkFixture = `<script>
  let qaGoogleConfig;
  window.google = { accounts: { id: {
    initialize(config) { qaGoogleConfig = config; }, cancel() {}, disableAutoSelect() {},
    renderButton(slot) {
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'qa-google-button'; button.textContent = 'Tiếp tục với Google (mô phỏng)';
      button.onclick = async () => {
        const response = await fetch('/test/credential', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ nonce:qaGoogleConfig.nonce, kind:document.querySelector('#qa-google-kind').value }) });
        qaGoogleConfig.callback(await response.json());
      }; slot.append(button);
    }
  } } };
</script>`;
const banner = `<aside class="qa-banner">KIỂM THỬ CỤC BỘ — dữ liệu và email giả lập, không tác động production.
  ${mockGoogle ? '<label>Luồng Google <select id="qa-google-kind"><option value="google">Tài khoản chỉ có Google</option><option value="legacy">Email có tài khoản RealView</option><option value="external">Email cần mã xác minh</option><option value="error">Google bị lỗi</option></select></label>' : 'Nút Google dùng SDK chính thức; chưa xác minh đăng nhập thật.'}</aside>
  <style>.qa-banner{position:relative;z-index:10;padding:10px 16px;background:#fff4dc;color:#725011;font:12px/1.6 Arial}.qa-banner label{display:inline-flex;gap:8px;margin-left:14px}.qa-google-button{min-height:44px;width:100%;border:1px solid #747775;border-radius:12px;background:white;color:#1f1f1f;font:500 14px Arial;cursor:pointer}</style>`;
const server = createServer(async (request, response) => {
  const json = (status, payload) => { response.statusCode = status; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(payload)); };
  response.status = status => { response.statusCode = status; return response; };
  response.json = payload => json(response.statusCode || 200, payload);
  response.setHeader('Cache-Control', 'no-store');
  try {
    if (request.headers.host !== `localhost:${port}`) return json(403, { error: 'Loopback QA host only' });
    const pathname = new URL(request.url, origin).pathname;
    if (request.method === 'POST') {
      if (request.headers.origin !== origin) return json(403, { error: 'Same-origin QA requests only' });
      let raw = ''; for await (const chunk of request) { raw += chunk; if (raw.length > 20000) return json(413, { error: 'Too large' }); }
      request.body = JSON.parse(raw || '{}');
    }
    if (pathname === '/api/auth') return accountHandler(request, response);
    if (pathname === '/api/auth-google') return googleHandler(request, response);
    if (pathname === '/api/admin-blog') return json(200, { role: null });
    if (pathname === '/api/history') {
      const user = await currentAccount(request, options);
      return user ? json(200, { history: await listAccountHistory(user.id, options), total: 1 }) : json(401, { error: 'Đăng nhập để xem lịch sử' });
    }
    if (pathname === '/api/analyze' && request.method === 'GET') return json(200, { remainingGuestQuota: 3 });
    if (pathname === '/api/chatbot-gemini-config') return json(200, { enabled: false });
    if (pathname === '/test/mail') return json(200, { emails });
    if (pathname === '/test/credential' && request.method === 'POST' && mockGoogle) {
      if (request.body.kind === 'error') return json(200, { credential: 'invalid-token' });
      const identity = request.body.kind === 'legacy' ? { subject: 'qa-legacy-google', email: legacyAccount.email, name: 'Legacy Buyer' }
        : request.body.kind === 'external' ? { subject: 'qa-external-google', email: 'thirdparty@example.net', name: 'External Buyer' } : googleFixture;
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'qa' })).toString('base64url');
      const claims = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: clientId, sub: identity.subject,
        email: identity.email, name: identity.name, email_verified: true, nonce: request.body.nonce, iat: now, exp: now + 300 })).toString('base64url');
      const message = header + '.' + claims;
      return json(200, { credential: message + '.' + sign('RSA-SHA256', Buffer.from(message), privateKey).toString('base64url') });
    }
    const routes = { '/': '/index.html', '/chinh-sach-bao-mat': '/privacy.html', '/dieu-khoan-su-dung': '/terms.html' };
    const file = resolve(publicRoot, '.' + (routes[pathname] || pathname));
    if (!file.startsWith(publicRoot + sep)) return json(403, { error: 'Forbidden' });
    let content = await readFile(file);
    if (pathname === '/') content = Buffer.from(content.toString().replace('<body>', `<body>${banner}${mockGoogle ? sdkFixture : ''}`));
    response.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream'); response.end(content);
  } catch (error) { json(error.code === 'ENOENT' ? 404 : 500, { error: 'QA route unavailable' }); }
});
server.listen(port, '127.0.0.1', () => console.log(`Isolated account UI QA: ${origin} (${mockGoogle ? 'simulated Google' : 'official Google SDK'})`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
