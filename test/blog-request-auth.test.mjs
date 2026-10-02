import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { canonicalBlogTarget, signBlogRequest, verifyBlogRequest } from '../cloudflare/blog-preview/request-auth.mjs';

const secret = 'local-test-only-secret-not-for-deployment-1234';
const body = new TextEncoder().encode('{"title":"Đọc review trước khi mua"}');
const fields = {
  environment: 'preview', method: 'POST', url: 'https://worker.example/v1/blog/save?b=2&a=%C3%A1',
  timestamp: 1790902800, requestId: 'request-0000000001', actorId: 'account:123',
  idempotencyKey: 'save-000000000001', contentType: 'application/json'
};
const now = fields.timestamp * 1000;
async function fixture() { return signBlogRequest({ secret, body, ...fields }); }
function verify(headers, changes = {}) { return verifyBlogRequest({ secret, body, ...fields, headers, now, ...changes }); }

test('fixed target vectors normalize query ordering, space and percent case identically', () => {
  const vectors = [
    ['https://worker.example/v1/blog/save?b=2&a=%C3%A1', '/v1/blog/save?a=%C3%A1&b=2'],
    ['https://worker.example/v1/blog/save?a=%c3%a1&b=2', '/v1/blog/save?a=%C3%A1&b=2'],
    ['https://worker.example/v1/%73ave?q=a+b', '/v1/save?q=a%20b'],
    ['https://worker.example/v1/save?q=a%20b', '/v1/save?q=a%20b']
  ];
  for (const [input, expected] of vectors) assert.equal(canonicalBlogTarget(input), expected);
});

test('ambiguous paths, duplicate query names, invalid encoding and fragments fail closed', () => {
  for (const suffix of ['/a/../save', '/a/%2E%2E/save', '/a%2Fsave', '/a%5Csave', '/a//save', '/save/',
    '/save?a=1&a=2', '/save?a=1&%61=2', '/save?q=%GG', '/save?q=%FF', '/save#fragment']) {
    assert.throws(() => canonicalBlogTarget(`https://worker.example${suffix}`));
  }
});

test('WebCrypto signature matches independent Node HMAC on exact UTF-8 envelope bytes', async () => {
  const headers = await fixture();
  const canonical = ['realview-blog-hmac-v1', 'preview', 'POST', '/v1/blog/save?a=%C3%A1&b=2',
    '1790902800', 'request-0000000001', 'account:123', 'save-000000000001', 'application/json',
    headers['x-blog-body-sha256']].join('\n');
  assert.equal(headers['x-blog-signature'], createHmac('sha256', secret).update(canonical).digest('hex'));
  assert.equal((await verify(headers)).actorId, 'account:123');
  await verify(headers, { url: 'https://worker.example/v1/blog/save?a=%c3%a1&b=2' });
});

test('altered body, identity, idempotency, method, target, content type or environment cannot authenticate', async () => {
  const headers = await fixture();
  for (const changes of [
    { body: new TextEncoder().encode('{"title":"Changed"}') }, { environment: 'production' },
    { method: 'DELETE' }, { url: 'https://worker.example/v1/blog/other?b=2&a=%C3%A1' },
    { secret: 'different-production-secret-never-shared-1234' }
  ]) await assert.rejects(verify(headers, changes));
  for (const [key, value] of Object.entries({
    'x-blog-actor-id': 'account:456', 'x-blog-idempotency-key': 'save-000000000002',
    'x-blog-request-id': 'request-0000000002', 'content-type': 'application/octet-stream',
    'x-blog-body-sha256': '0'.repeat(64), 'x-blog-signature': '0'.repeat(64)
  })) await assert.rejects(verify({ ...headers, [key]: value }));
});

test('signature window and payload limits reject expired, future, malformed and oversized requests', async () => {
  const headers = await fixture();
  await assert.rejects(verify(headers, { now: now + 301_000 }), { code: 'BLOG_AUTH_EXPIRED' });
  await assert.rejects(verify(headers, { now: now - 31_000 }), { code: 'BLOG_AUTH_EXPIRED' });
  await verify(headers, { now: now + 300_000 });
  await verify(headers, { now: now - 30_000 });
  await assert.rejects(verify(headers, { body: new Uint8Array(4_300_001) }), { code: 'BLOG_AUTH_BODY_TOO_LARGE' });
  await assert.rejects(verify(headers, { secret: '' }), { code: 'BLOG_AUTH_NOT_CONFIGURED' });
  await assert.rejects(verify({ ...headers, 'x-blog-timestamp': '1e9' }));
  const missingActor = { ...headers };
  delete missingActor['x-blog-actor-id'];
  await assert.rejects(verify(missingActor));
  await assert.rejects(signBlogRequest({ secret, body, ...fields, actorId: undefined }));
});

test('signature validation alone is deliberately NOT replay protection or grant authorization', async () => {
  const headers = await fixture();
  // Integration MUST consume requestId atomically and check D1 grants after this step.
  assert.deepEqual(await verify(headers), await verify(headers));
});
