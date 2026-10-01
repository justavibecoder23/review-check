// Negative HTTP checks against the running local harness, not a mock server.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
const origin = process.env.GOOGLE_E2E_ORIGIN || 'http://localhost:3137';
assert.equal(new URL(origin).hostname, 'localhost');
const checks = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push({ name, passed: true }); };
const call = (body, { cookie = '', requestOrigin = origin, method = 'POST' } = {}) => fetch(origin + '/api/auth-google', {
  method, headers: { Origin: requestOrigin, Cookie: cookie, 'Content-Type': 'application/json' },
  ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {})
});
const config = await (await call(null, { method: 'GET' })).json();
check('GET config exposes public Client ID only', config.enabled && Object.keys(config).length === 2);
check('cross-origin POST rejected', (await call({ action: 'begin' }, { requestOrigin: 'https://attacker.invalid' })).status === 403);
check('missing Origin rejected', (await call({ action: 'begin' }, { requestOrigin: '' })).status === 403);
check('PUT rejected', (await call(null, { method: 'PUT' })).status === 405);
check('malformed JSON rejected', (await call('{broken')).status === 400);
const start = await call({ action: 'begin' });
const cookie = start.headers.get('set-cookie').split(';')[0];
const challenge = await start.json();
check('HTTP begin issues HttpOnly SameSite browser cookie', start.status === 200 && /HttpOnly/.test(start.headers.get('set-cookie')) && /SameSite=Lax/.test(start.headers.get('set-cookie')));
const missing = await call({ action: 'authenticate', challengeId: challenge.challengeId, credential: 'invalid' });
check('authenticate without browser cookie rejected', missing.status === 401);
const certs = await fetch('https://www.googleapis.com/oauth2/v1/certs');
assert.equal(certs.status, 200);
const kid = Object.keys(await certs.json())[0];
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const now = Math.floor(Date.now() / 1000);
const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
const claims = Buffer.from(JSON.stringify({ iss:'https://accounts.google.com', aud: config.clientId, sub:'e2e_invalid_signature',
  email:'e2e.invalid.signature@gmail.com', email_verified:true, nonce: challenge.nonce, iat:now, exp:now+300 })).toString('base64url');
const input = `${header}.${claims}`;
const forged = `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
const rejected = await call({ action:'authenticate', challengeId:challenge.challengeId, credential:forged }, { cookie });
const error = await rejected.json();
check('official Google certificate verification rejects forged signature', rejected.status === 401 && error.code === 'INVALID_GOOGLE_TOKEN');
check('error does not expose token or claims', !JSON.stringify(error).includes(forged) && !JSON.stringify(error).includes('e2e.invalid.signature'));
const invalid = await call({action:'authenticate', challengeId:challenge.challengeId, credential:'bad'}, {cookie});
check('invalid token does not consume valid challenge', (await invalid.json()).code === 'INVALID_GOOGLE_TOKEN');
console.log(JSON.stringify({ phase: 'actual-http-and-google-certificates', checks }));
