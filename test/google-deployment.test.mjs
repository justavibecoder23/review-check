import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import authEndpoint from '../api/auth.mjs';

function responseMock() {
  return {
    headers: {}, statusCode: 0, body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }
  };
}

test('Google URL shares the account function and stays within Vercel Hobby limits', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  const functions = (await readdir(new URL('../api/', import.meta.url))).filter((name) => name.endsWith('.mjs'));
  assert.equal(functions.length, 12);
  assert.ok(!functions.includes('auth-google.mjs'));
  assert.equal(config.functions['api/auth.mjs'].maxDuration, 30);
  assert.deepEqual(config.rewrites.find((rule) => rule.source === '/api/auth-google'), {
    source: '/api/auth-google', destination: '/api/auth.mjs?authProvider=google'
  });
});

test('shared endpoint dispatches Google without changing account GET or origin protection', async () => {
  const previous = { id: process.env.GOOGLE_CLIENT_ID, enabled: process.env.GOOGLE_LOGIN_ENABLED };
  process.env.GOOGLE_CLIENT_ID = '154335934284-1fupk8riad0u56jughvv73pep358hdft.apps.googleusercontent.com';
  process.env.GOOGLE_LOGIN_ENABLED = 'true';
  try {
    const google = responseMock();
    await authEndpoint({ method: 'GET', query: { authProvider: 'google' }, headers: {} }, google);
    assert.equal(google.statusCode, 200);
    assert.equal(google.body.enabled, true);
    assert.equal(google.body.clientId, process.env.GOOGLE_CLIENT_ID);
    assert.equal(google.headers['Cache-Control'], 'no-store');

    const account = responseMock();
    await authEndpoint({ method: 'GET', query: {}, headers: {} }, account);
    assert.equal(account.statusCode, 200);
    assert.deepEqual(account.body, { user: null });

    const rejected = responseMock();
    await authEndpoint({ method: 'POST', query: { authProvider: 'google' },
      headers: { host: 'www.realview.com.vn', origin: 'https://other.example', 'x-forwarded-proto': 'https' },
      body: { action: 'begin' } }, rejected);
    assert.equal(rejected.statusCode, 403);
    assert.equal(rejected.body.code, 'INVALID_ORIGIN');
  } finally {
    if (previous.id === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = previous.id;
    if (previous.enabled === undefined) delete process.env.GOOGLE_LOGIN_ENABLED;
    else process.env.GOOGLE_LOGIN_ENABLED = previous.enabled;
  }
});
