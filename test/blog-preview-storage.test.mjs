import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { previewFixture } from './helpers/blog-preview-fixture.mjs';
import { saveDraft, readDraft } from '../cloudflare/blog-preview/draft-store.mjs';
import { uploadMedia, readMedia } from '../cloudflare/blog-preview/media-store.mjs';
import { blogBodyHash, signBlogRequest } from '../cloudflare/blog-preview/request-auth.mjs';
import worker from '../cloudflare/blog-preview/worker.mjs';
import { preparePreviewMedia, createCloudflarePreviewHandler, previewWorkerCall } from '../src/blog-cloudflare-preview.mjs';
import { currentAccount } from '../api/auth.mjs';

const secret = 'test-secret-only-not-a-production-secret-12345';
const post = { title: 'Bài thử nghiệm preview', slug: 'bai-thu-nghiem', category: 'doc-review',
  blocks: [{ id: 'one', type: 'paragraph', text: 'Nội dung giữ nguyên.' }] };
async function envelope(f, body, key = randomUUID()) {
  return { actorId: f.actorId, idempotencyKey: key, bodyHash: await blogBodyHash(new TextEncoder().encode(JSON.stringify(body))) };
}
async function image() {
  const bytes = await sharp({ create: { width: 1200, height: 675, channels: 3, background: '#ff7518' } }).png().toBuffer();
  return preparePreviewMedia({ contentType: 'image/png', data: bytes.toString('base64') });
}
async function request(f, path, payload, overrides = {}) {
  const url = `https://realview-blog-preview.wwpk-cloudflare-relay.workers.dev${path}`;
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const headers = await signBlogRequest({ secret, environment: 'preview', method: 'POST', url,
    timestamp: Math.floor(Date.now() / 1000), requestId: randomUUID(), actorId: f.actorId,
    idempotencyKey: randomUUID(), contentType: 'application/json', body, ...overrides });
  return new Request(url, { method: 'POST', headers, body });
}
function workerEnv(f) { return { BLOG_HMAC_SECRET: secret, BLOG_DB: f.db, BLOG_MEDIA: f.bucket }; }

test('D1 save is idempotent, byte-preserves new body, retries an ambiguous commit once', async () => {
  const f = previewFixture(); f.enable();
  try {
    const input = { post, expectedRevision: 0 };
    const e = await envelope(f, input);
    f.hooks.afterCommit = () => { throw new Error('response lost AFTER commit'); };
    const saved = await saveDraft(f.db, input, e);
    assert.equal(saved.revision, 1);
    assert.deepEqual(await saveDraft(f.db, input, e), saved);
    assert.equal(f.count('blog_drafts'), 1); assert.equal(f.count('blog_revisions'), 1);
    assert.equal(f.count('blog_idempotency'), 1); assert.equal(f.count('blog_commit_checks'), 0);
    assert.deepEqual((await readDraft(f.db, saved.id)).post.blocks, post.blocks);
    await assert.rejects(saveDraft(f.db, input, { ...e, bodyHash: '0'.repeat(64) }), { code: 'BLOG_IDEMPOTENCY_CONFLICT' });
  } finally { f.close(); }
});

test('two tabs cannot commit the same revision; losing transaction has no partial rows', async () => {
  const f = previewFixture(); f.enable();
  try {
    const initial = { post };
    const saved = await saveDraft(f.db, initial, await envelope(f, initial));
    const a = { id: saved.id, expectedRevision: 1, post: { ...post, title: 'Tab A' } };
    const b = { id: saved.id, expectedRevision: 1, post: { ...post, title: 'Tab B' } };
    const eA = await envelope(f, a), eB = await envelope(f, b);
    const results = await Promise.allSettled([saveDraft(f.db, a, eA), saveDraft(f.db, b, eB)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'BLOG_REVISION_CONFLICT');
    assert.equal(f.count('blog_revisions'), 2); assert.equal(f.count('blog_idempotency'), 2);
    assert.equal(f.count('blog_commit_checks'), 0);
  } finally { f.close(); }
});

test('reserved/tombstone slug and nonexistent edit ID are rejected, never overwritten', async () => {
  const f = previewFixture(); f.enable();
  try {
    for (const [slug, ownership, tombstone] of [['snapshot-cu', 'snapshot', 0], ['tombstone-cu', 'studio', 1]]) {
      f.sqlite.prepare('INSERT INTO blog_slugs VALUES (?,?,?,?)').run(slug, ownership, 'old-owner', tombstone);
      const input = { post: { ...post, slug } };
      await assert.rejects(saveDraft(f.db, input, await envelope(f, input)), { code: 'BLOG_SLUG_CONFLICT' });
    }
    const input = { id: randomUUID(), expectedRevision: 0, post };
    await assert.rejects(saveDraft(f.db, input, await envelope(f, input)), { code: 'BLOG_REVISION_CONFLICT' });
    assert.equal(f.count('blog_drafts'), 0); assert.equal(f.count('blog_idempotency'), 0);
  } finally { f.close(); }
});

test('revocation/read-only at the actual save batch rolls back all content', async () => {
  for (const [sql, code] of [["UPDATE blog_access_grants SET active=0", 'BLOG_ACCESS_DENIED'],
    ["UPDATE blog_migration_settings SET value='true'", 'BLOG_READ_ONLY']]) {
    const f = previewFixture(); f.enable();
    try {
      f.hooks.beforeBatch = () => f.sqlite.exec(sql);
      const input = { post };
      await assert.rejects(saveDraft(f.db, input, await envelope(f, input)), { code });
      for (const table of ['blog_drafts', 'blog_revisions', 'blog_idempotency', 'blog_slugs', 'blog_commit_checks']) assert.equal(f.count(table), 0);
    } finally { f.close(); }
  }
});

test('R2 immutable upload becomes ready only after all variants HEAD; identical retry has zero PUT', async () => {
  const f = previewFixture(); f.enable();
  try {
    const input = await image(), e = await envelope(f, input);
    const asset = await uploadMedia(f.db, f.bucket, input, e);
    assert.equal(asset.responsiveSources.length, 3);
    assert.equal(f.counts.put, 3); assert.equal(f.counts.head, 3);
    assert.deepEqual(await uploadMedia(f.db, f.bucket, input, e), asset);
    assert.equal(f.counts.put, 3); assert.equal(f.counts.head, 3);
    const response = await readMedia(f.db, f.bucket, asset.id, asset.width);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await response.arrayBuffer()).byteLength, asset.size);
    await assert.rejects(readMedia(f.db, f.bucket, '../other', 960), { statusCode: 404 });
  } finally { f.close(); }
});

test('PUT response timeout AFTER storage reconciles the same key, without another PUT', async () => {
  const f = previewFixture(); f.enable();
  try {
    f.hooks.afterPut = () => { throw new Error('ambiguous timeout'); };
    const input = await image();
    const asset = await uploadMedia(f.db, f.bucket, input, await envelope(f, input));
    assert.equal(f.counts.put, 3); assert.equal(f.objects.size, 3); assert.equal(f.counts.head, 6);
    assert.equal(asset.responsiveSources.length, 3);
  } finally { f.close(); }
});

test('partial upload stays private; retry reuses deterministic keys and skips existing object', async () => {
  const f = previewFixture(); f.enable();
  try {
    f.hooks.beforePut = () => { if (f.counts.put === 2) throw new Error('failed before storage'); };
    const input = await image(), e = await envelope(f, input);
    await assert.rejects(uploadMedia(f.db, f.bucket, input, e), { code: 'BLOG_MEDIA_RETRY' });
    const row = f.sqlite.prepare('SELECT * FROM blog_media').get();
    assert.equal(row.state, 'pending'); assert.equal(f.objects.size, 1);
    const existingKey = [...f.objects.keys()][0];
    await assert.rejects(readMedia(f.db, f.bucket, row.hash, 480), { statusCode: 404 });
    f.hooks.beforePut = null;
    await uploadMedia(f.db, f.bucket, input, e);
    assert.equal(f.counts.put, 4); assert.equal(f.objects.size, 3);
    assert.ok(f.objects.has(existingKey));
    assert.equal(f.sqlite.prepare('SELECT fence,state FROM blog_media').get().fence, 2);
  } finally { f.close(); }
});

test('lost ownership and ambiguous heartbeat halt new PUTs and forbid ready publication', async () => {
  for (const scenario of ['owner', 'heartbeat', 'revoke', 'read-only']) {
    const f = previewFixture(); f.enable();
    try {
      let tick;
      const timers = { setIntervalImpl(fn, interval) { assert.equal(interval, 10000); tick = fn; return 1; }, clearIntervalImpl() {} };
      f.hooks.afterPut = async () => {
        if (scenario === 'owner') f.sqlite.exec("UPDATE blog_media SET owner='different-owner',fence=fence+1");
        if (scenario === 'revoke') f.sqlite.exec('UPDATE blog_access_grants SET active=0');
        if (scenario === 'read-only') f.sqlite.exec("UPDATE blog_migration_settings SET value='true'");
        if (scenario === 'heartbeat') {
          f.hooks.beforeRun = sql => { if (sql.includes('SET lease_until=CAST')) throw new Error('renewal response unknown'); };
          tick();
          await new Promise(resolve => setImmediate(resolve));
          f.hooks.beforeRun = null;
        }
      };
      const input = await image();
      await assert.rejects(uploadMedia(f.db, f.bucket, input, await envelope(f, input), timers));
      assert.equal(f.counts.put, 1); assert.equal(f.sqlite.prepare('SELECT state FROM blog_media').get().state, 'pending');
      if (scenario === 'owner') assert.notEqual(f.sqlite.prepare('SELECT lease_until FROM blog_media').get().lease_until, 0);
    } finally { f.close(); }
  }
});

test('Worker rejects forged/expired/replayed/denied requests and has no public or publish endpoint', async () => {
  const f = previewFixture();
  try {
    const denied = await worker.fetch(await request(f, '/v1/save', { post }), workerEnv(f));
    assert.equal(denied.status, 403); assert.equal(f.count('blog_request_replays'), 0);
    f.enable();
    const good = await request(f, '/v1/read', { action: 'list' });
    const repeated = good.clone();
    assert.equal((await worker.fetch(good, workerEnv(f))).status, 200);
    assert.equal((await worker.fetch(repeated, workerEnv(f))).status, 409);
    const bad = await request(f, '/v1/save', { post }); bad.headers.set('x-blog-signature', '0'.repeat(64));
    assert.equal((await worker.fetch(bad, workerEnv(f))).status, 401);
    assert.equal((await worker.fetch(await request(f, '/v1/save', { post }, { timestamp: Math.floor(Date.now() / 1000) - 301 }), workerEnv(f))).status, 401);
    f.sqlite.exec("UPDATE blog_migration_settings SET value='true'");
    assert.equal((await worker.fetch(await request(f, '/v1/save', { post }), workerEnv(f))).status, 503);
    const read = await worker.fetch(await request(f, '/v1/read', { action: 'list' }), workerEnv(f));
    assert.equal(read.status, 200); assert.equal((await read.json()).readOnly, true);
    for (const path of ['/sitemap.xml', '/v1/publish', '/v1/unpublish', '/v1/grants', '/bai-viet/bai-thu-nghiem']) {
      assert.equal((await worker.fetch(await request(f, path, {}), workerEnv(f))).status, 404);
    }
    assert.equal(f.count('blog_drafts'), 0); assert.equal(f.count('blog_media'), 0);
  } finally { f.close(); }
});

test('bridge uses ONLY signed Worker calls for content/media; wrong origin, off flag and production deny', async () => {
  const f = previewFixture(); f.enable();
  try {
    const env = { BLOG_STORAGE_BACKEND: 'cloudflare-preview', VERCEL_ENV: 'preview', BLOG_PREVIEW_HMAC_SECRET: secret,
      BLOG_PREVIEW_WORKER_URL: 'https://realview-blog-preview.wwpk-cloudflare-relay.workers.dev' };
    const calls = [];
    const fetchImpl = (url, options) => {
      calls.push(url);
      assert.ok(url.startsWith(env.BLOG_PREVIEW_WORKER_URL));
      return worker.fetch(new Request(url, options), workerEnv(f));
    };
    const handler = createCloudflarePreviewHandler({ env, fetchImpl, currentAccountImpl: async () => ({ id: f.actorId }) });
    function response() { return { headers: {}, setHeader(k,v) { this.headers[k]=v; }, status(s) { this.statusCode=s; return this; }, json(p) { this.payload=p; }, end(p) { this.payload=p; } }; }
    const req = { method: 'POST', headers: { host: 'test.vercel.app', origin: 'https://test.vercel.app' },
      body: { action: 'save', post, idempotencyKey: randomUUID() } };
    const res = response(); await handler(req, res); assert.equal(res.statusCode, 200); assert.equal(res.payload.revision, 1);
    const input = await sharp({ create: { width: 80, height: 40, channels: 3, background: '#ffa550' } }).png().toBuffer();
    const upload = response();
    await handler({ ...req, body: { action: 'upload_media', contentType: 'image/png', data: input.toString('base64') } }, upload);
    assert.equal(upload.statusCode, 200); assert.equal(upload.payload.asset.responsiveSources.length, 1);
    assert.equal(calls.length, 3); assert.equal(f.counts.put, 1);
    const foreign = response(); await handler({ ...req, headers: { ...req.headers, origin: 'https://evil.test' } }, foreign);
    assert.equal(foreign.statusCode, 403); assert.equal(calls.length, 3);
    await assert.rejects(previewWorkerCall('/v1/read', {}, f.actorId, { env: { ...env, VERCEL_ENV: 'production' }, fetchImpl }), { code: 'BLOG_PREVIEW_ONLY' });
    await assert.rejects(previewWorkerCall('/v1/read', {}, f.actorId, { env: {}, fetchImpl }), { code: 'BLOG_PREVIEW_DISABLED' });
    const inherited = response();
    await createCloudflarePreviewHandler({env:{...env,BLOB_READ_WRITE_TOKEN:'forbidden-test-token'},fetchImpl,
      currentAccountImpl:async()=>({id:f.actorId})})(req,inherited);
    assert.equal(inherited.statusCode,503); assert.equal(inherited.payload.code,'BLOG_PREVIEW_STORAGE_NOT_ISOLATED');
    assert.equal(calls.length,3);
    await assert.rejects(preparePreviewMedia({ contentType: 'image/png', data: Buffer.from('not an image').toString('base64') }), { code: 'BLOG_MEDIA_INVALID_IMAGE' });
    await assert.rejects(preparePreviewMedia({ contentType: 'image/png', data: Buffer.alloc(3 * 1024 * 1024 + 1).toString('base64') }));
    const maxPayload = { action: 'upload_media', fileName: 'ộ'.repeat(200), alt: 'ộ'.repeat(300),
      contentType: 'image/png', data: Buffer.alloc(3 * 1024 * 1024).toString('base64') };
    assert.ok(Buffer.byteLength(JSON.stringify(maxPayload)) < 4_300_000);
  } finally { f.close(); }
});

test('actual session resolution issues only GET, while forbidden Blob/Redis writes are trapped', async () => {
  const f = previewFixture(); f.enable();
  const oldUrl = process.env.UPSTASH_REDIS_REST_URL, oldToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const oldFetch = globalThis.fetch;
  const commands = [], forbidden = [];
  try {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-redis.invalid';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token-not-real';
    globalThis.fetch = async (url, options) => {
      if (url === 'https://fake-redis.invalid') {
        const parts = JSON.parse(options.body); commands.push(parts);
        if (parts[0] !== 'GET') { forbidden.push('redis-write'); throw new Error('unexpected Redis write'); }
        const result = parts[1].includes(':session:') ? JSON.stringify({ userId:f.actorId, version:0 })
          : JSON.stringify({ id:f.actorId,username:'synthetic-test',email:'test@example.invalid',sessionVersion:0 });
        return Response.json({result});
      }
      if (String(url).startsWith('https://realview-blog-preview.wwpk-cloudflare-relay.workers.dev/')) {
        return worker.fetch(new Request(url,options),workerEnv(f));
      }
      forbidden.push('blob-or-other-network'); throw new Error('forbidden storage request');
    };
    const env = { BLOG_STORAGE_BACKEND:'cloudflare-preview',VERCEL_ENV:'preview',BLOG_PREVIEW_HMAC_SECRET:secret,
      BLOG_PREVIEW_WORKER_URL:'https://realview-blog-preview.wwpk-cloudflare-relay.workers.dev' };
    const handler = createCloudflarePreviewHandler({env});
    const response = { setHeader() {},status(value) { this.statusCode=value; return this; },json(value) { this.payload=value; } };
    await handler({method:'POST',headers:{cookie:'realview_session=synthetic-token',host:'test.vercel.app',origin:'https://test.vercel.app'},
      body:{action:'save',post,idempotencyKey:randomUUID()}},response);
    assert.equal(response.statusCode,200);
    assert.equal(commands.length,2); assert.ok(commands.every(parts=>parts[0]==='GET'));
    assert.deepEqual(forbidden,[]);
    // Dedicated loader mode intercepts SDK calls, including swallowed errors.
    if (process.env.BLOG_BLOB_SPY_TEST === 'true') {
      await import('@vercel/blob');
      assert.deepEqual(globalThis.__blogBlobCalls,[]);
    }
    assert.equal((await currentAccount({headers:{cookie:''}})),null);
  } finally {
    globalThis.fetch=oldFetch;
    if (oldUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL; else process.env.UPSTASH_REDIS_REST_URL=oldUrl;
    if (oldToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN; else process.env.UPSTASH_REDIS_REST_TOKEN=oldToken;
    f.close();
  }
});
