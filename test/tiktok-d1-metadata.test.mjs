import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../cloudflare/review-cache/worker.mjs';
import { getTikTokProductMetadata, setTikTokProductMetadata, tiktokMetadataBackend } from '../src/product-cache.mjs';
import { hydrateTikTokProductMetadata, getReviews } from '../src/sources.mjs';
import { saveCloudflareReviewBundle } from '../src/cloudflare-review-store.mjs';
import { tiktokMetadataImage, TIKTOK_METADATA_TTL_MS } from '../src/tiktok-metadata-policy.mjs';
import { cleanupTikTokMetadata } from '../cloudflare/review-cache/tiktok-metadata.mjs';

const id = '1730952403445516443';
const otherId = '1730952403445516444';
const image = 'https://p16-oec-sg.ibyteimg.com/tos/product-main.webp';
const title = 'Áo thun unisex cotton';

function setup() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of ['0001_review_cache.sql', '0002_product_metadata.sql', '0003_tiktok_product_metadata.sql']) {
    sqlite.exec(readFileSync(new URL(`../cloudflare/review-cache/migrations/${file}`, import.meta.url), 'utf8'));
  }
  const requests = [];
  const db = {
    prepare(sql) { return {
      values: [], bind(...values) { this.values = values; return this; },
      async first() { return sqlite.prepare(sql).get(...this.values) || null; },
      async all() { return { results: sqlite.prepare(sql).all(...this.values), meta: {} }; },
      execute() {
        if (/^\s*SELECT\b/i.test(sql)) return { results: sqlite.prepare(sql).all(...this.values), meta: {} };
        const result = sqlite.prepare(sql).run(...this.values);
        return { results: [], meta: { rows_written: Number(result.changes), changes: Number(result.changes) } };
      }
    }; },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const result = statements.map(s => s.execute()); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  };
  const env = { DB: db, REVIEW_CACHE_SECRET: 'tiktok-local-test-secret' };
  const forbidden = () => { throw new Error('Redis/Blob/Actor/image fetch must not be used'); };
  const options = { reviewStorageMode: 'd1', cloudflareReviewUrl: 'https://review.test',
    cloudflareReviewSecret: env.REVIEW_CACHE_SECRET, redisFetchImpl: forbidden, blobGetImpl: forbidden,
    blobFetchImpl: forbidden, metadataActorFetchImpl: forbidden,
    cloudflareFetchImpl: async (url, init) => {
      requests.push({ url, method: init.method, body: init.body });
      return worker.fetch(new Request(url, init), env);
    } };
  return { sqlite, db, env, options, requests };
}

test('TikTok D1 stores exact ID/title/URL and price/rating with fixed five-day TTL; no Redis or Blob', async (t) => {
  const { sqlite, options, requests } = setup(); t.after(() => sqlite.close());
  const saved = await setTikTokProductMetadata(id, { title, image, price: '129000', rating: 4.8 }, options);
  assert.equal(saved.saved, true);
  assert.equal(saved.metadata.productId, id);
  assert.equal(Date.parse(saved.metadata.expiresAt) - Date.parse(saved.metadata.observedAt), TIKTOK_METADATA_TTL_MS);
  const cached = await getTikTokProductMetadata(id, options);
  assert.equal(cached.title, title); assert.equal(cached.image, image);
  assert.equal(cached.price, '129000'); assert.equal(cached.rating, 4.8);
  assert.equal(await getTikTokProductMetadata(otherId, options), null);
  assert.deepEqual(requests.map(r => r.method), ['POST', 'GET', 'GET']);
});

test('GET/identical POST do not refresh expiry; exactly five days is a cache miss', async (t) => {
  const { sqlite, options } = setup(); t.after(() => sqlite.close());
  let now = 1791190800000;
  t.mock.method(Date, 'now', () => now);
  const saved = await setTikTokProductMetadata(id, { title, image }, { ...options, observedAt: new Date(now).toISOString() });
  now += 86400_000;
  const read = await getTikTokProductMetadata(id, options);
  const repeated = await setTikTokProductMetadata(id, { title, image }, options);
  assert.equal(read.expiresAt, saved.metadata.expiresAt);
  assert.equal(repeated.rowsWritten, 0);
  assert.equal(repeated.metadata.expiresAt, saved.metadata.expiresAt);
  now = Date.parse(saved.metadata.expiresAt);
  assert.equal(await getTikTokProductMetadata(id, options), null);
});

test('fresh partial data does not extend an older image; expired fields are not revived', async (t) => {
  const { sqlite, options } = setup(); t.after(() => sqlite.close());
  let now = 1791190800000;
  t.mock.method(Date, 'now', () => now);
  const saved = await setTikTokProductMetadata(id, { title, image }, options);
  now += 86400_000;
  const changed = await setTikTokProductMetadata(id, { title: 'Tên mới' }, options);
  assert.equal(changed.metadata.image, image);
  assert.equal(changed.metadata.expiresAt, saved.metadata.expiresAt);
  const delayed = await setTikTokProductMetadata(id, { title: 'Tên đến muộn' }, {
    ...options, observedAt: new Date(now - 1000).toISOString()
  });
  assert.equal(delayed.metadata.title, 'Tên mới', 'older partial requests cannot overwrite an accepted newer observation');
  now += 5 * 86400_000;
  const partial = await setTikTokProductMetadata(id, { title: 'Tên mới hơn' }, options);
  assert.equal(partial.metadata.image, undefined);
  assert.equal(Date.parse(partial.metadata.expiresAt) - now, TIKTOK_METADATA_TTL_MS);
});

test('stale/future observations and wrong-ID responses are rejected; older requests cannot overwrite', async (t) => {
  const { sqlite, options } = setup(); t.after(() => sqlite.close());
  const now = Date.now();
  assert.equal((await setTikTokProductMetadata(id, { title, image }, { ...options,
    observedAt: new Date(now - TIKTOK_METADATA_TTL_MS).toISOString() })).saved, false);
  assert.equal((await setTikTokProductMetadata(id, { title, image }, { ...options,
    observedAt: new Date(now + 60000).toISOString() })).saved, false);
  await setTikTokProductMetadata(id, { title, image }, { ...options, observedAt: new Date(now).toISOString() });
  const older = await setTikTokProductMetadata(id, { title: 'Old title', image }, { ...options,
    observedAt: new Date(now - 10000).toISOString() });
  assert.equal(older.metadata.title, title);
  assert.equal(older.rowsWritten, 0);
  assert.equal(await getTikTokProductMetadata(id, { ...options, cloudflareFetchImpl: async () => Response.json({
    hit: true, metadata: { productId: otherId, title, image, observedAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(), expiresAt: new Date(now + TIKTOK_METADATA_TTL_MS).toISOString() }
  }) }), null);
});

test('Worker rejects unauthorized, oversized, unsafe URLs, challenge titles and malformed IDs', async (t) => {
  const { sqlite, env } = setup(); t.after(() => sqlite.close());
  const url = 'https://review.test/v1/tiktok-product-metadata';
  const base = { productId: id, title, image, observedAt: new Date().toISOString() };
  const post = (body, headers = { authorization: `Bearer ${env.REVIEW_CACHE_SECRET}` }) => worker.fetch(new Request(url, {
    method: 'POST', headers, body: JSON.stringify(body)
  }), env);
  assert.equal((await post(base, {})).status, 401);
  for (const changes of [
    { productId: 'x' }, { productId: Number(id) }, { observedAt: 'broken' },
    { image: 'https://a.public.blob.vercel-storage.com/cover.jpg' },
    { image: 'https://127.0.0.1/photo.jpg' }, { image: 'https://p16-oec-sg.ibyteimg.com.evil.test/photo' },
    { image: 'https://user:pass@p16-oec-sg.ibyteimg.com/photo' },
    { title: 'Security Check', image: '' }, { title: 'x'.repeat(9000) }
  ]) assert.equal((await post({ ...base, ...changes })).status, 400);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM tiktok_product_metadata_cache').get().n, 0);
  assert.equal(tiktokMetadataImage('https://p16-oec-sg.ibyteimg.com/photo?signature=abc'), 'https://p16-oec-sg.ibyteimg.com/photo?signature=abc');
});

test('cached dataset with complete recent metadata makes zero metadata requests or writes', async (t) => {
  const { sqlite, options, requests } = setup(); t.after(() => sqlite.close());
  const result = await hydrateTikTokProductMetadata(id, `https://shop.tiktok.com/vn/pdp/product/${id}`, { title, image }, {
    ...options, metadataObservedAt: new Date(Date.now() - 86400_000).toISOString(),
    fetchImpl: () => { throw new Error('Must not probe source'); }
  });
  assert.equal(result.image, image);
  assert.equal(requests.length, 0);
});

test('full getReviews uses recent D1 TikTok dataset without metadata, Redis, Blob or Actor requests', async (t) => {
  const { sqlite, options, requests } = setup(); t.after(() => sqlite.close());
  const createdAt = new Date(Date.now() - 86400_000).toISOString();
  const product = { platform: 'TikTok Shop', productId: id, title, image };
  const reviews = Array.from({ length: 20 }, (_, i) => ({ rating: 5, text: `Review thật ${i}` }));
  const rawDataset = { datasetKind: 'raw-reviews', runId: 'cached-tiktok-run', createdAt, product,
    reviews, reviewCount: reviews.length };
  const bundle = { datasetKind: 'review-dataset-bundle', runId: rawDataset.runId, createdAt, product,
    rawDataset, labeledDataset: { ...rawDataset, datasetKind: 'labeled-reviews' } };
  await saveCloudflareReviewBundle(bundle, 'a'.repeat(64), options);
  requests.length = 0;
  const result = await getReviews(`https://shop.tiktok.com/vn/pdp/product/${id}`, {
    ...options, blobReviewFallback: false, fetchImpl: () => { throw new Error('No external fetch'); },
    collectTikTokReviewsImpl: () => { throw new Error('No paid Actor'); }
  });
  assert.equal(result.source.cache.provider, 'cloudflare-d1');
  assert.equal(result.product.title, title); assert.equal(result.product.image, image);
  assert.equal(result.reviews.length, 20);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/v1\/cache\?/);
});

test('overlay cache hit supplies name/image without SET or external fetch', async (t) => {
  const { sqlite, options, requests } = setup(); t.after(() => sqlite.close());
  await setTikTokProductMetadata(id, { title, image }, options);
  requests.length = 0;
  const result = await hydrateTikTokProductMetadata(id, `https://shop.tiktok.com/vn/pdp/product/${id}`, {}, {
    ...options, fetchImpl: () => { throw new Error('Must not refetch'); }
  });
  assert.equal(result.title, title); assert.equal(result.image, image);
  assert.deepEqual(requests.map(r => r.method), ['GET']);
});

test('historical fallback is not promoted to fresh metadata when the page is blocked', async (t) => {
  const { sqlite, options, requests } = setup(); t.after(() => sqlite.close());
  const old = new Date(Date.now() - 10 * 86400_000).toISOString();
  await hydrateTikTokProductMetadata(id, `https://shop.tiktok.com/vn/pdp/product/${id}`, { title, image }, {
    ...options, metadataObservedAt: old,
    fetchImpl: async () => new Response('<title>Security Check</title>', { headers: { 'content-type': 'text/html' } })
  });
  assert.equal(requests.filter(r => r.method === 'POST').length, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM tiktok_product_metadata_cache').get().n, 0);
});

test('fresh exact-ID page fills an Actor image gap without overwriting the Actor title', async (t) => {
  const { sqlite, options, requests } = setup(); t.after(() => sqlite.close());
  const url = `https://shop.tiktok.com/vn/pdp/product/${id}`;
  const result = await hydrateTikTokProductMetadata(id, url, { title }, {
    ...options, metadataFresh: true,
    fetchImpl: async () => new Response(`<html><head>
      <link rel="canonical" href="${url}">
      <meta property="og:title" content="Tên từ trang sản phẩm">
      <meta property="og:image" content="${image}">
      </head></html>`, { headers: { 'content-type': 'text/html' } })
  });
  assert.equal(result.title, title);
  assert.equal(result.image, image);
  const posted = JSON.parse(requests.find(request => request.method === 'POST').body);
  assert.equal(posted.title, title);
  assert.equal(posted.image, image);
});

test('D1 read outage is best effort with zero Redis/Blob fallback', async (t) => {
  const { sqlite, options } = setup(); t.after(() => sqlite.close());
  assert.equal(await getTikTokProductMetadata(id, {
    ...options, cloudflareFetchImpl: async () => Response.json({ error: 'STORAGE_ERROR' }, { status: 503 })
  }), null);
});

test('TikTok additive schema can be reapplied without destroying metadata', async (t) => {
  const { sqlite, options } = setup(); t.after(() => sqlite.close());
  await setTikTokProductMetadata(id, { title, image }, options);
  sqlite.exec(readFileSync(new URL('../cloudflare/review-cache/migrations/0003_tiktok_product_metadata.sql', import.meta.url), 'utf8'));
  assert.equal((await getTikTokProductMetadata(id, options)).image, image);
});

test('fresh live metadata writes in background; D1 failure never holds result or invokes Redis/Blob', async (t) => {
  const { sqlite, options } = setup(); t.after(() => sqlite.close());
  let rejectWrite;
  const writes = [];
  const pending = new Promise((_resolve, reject) => { rejectWrite = reject; });
  const result = await hydrateTikTokProductMetadata(id, `https://shop.tiktok.com/vn/pdp/product/${id}`, { title, image }, {
    ...options, metadataFresh: true, cloudflareFetchImpl: () => pending,
    onBackgroundWork: promise => writes.push(promise)
  });
  assert.equal(result.title, title); assert.equal(result.image, image);
  assert.equal(writes.length, 1);
  rejectWrite(new Error('D1 temporarily unavailable'));
  await Promise.all(writes);
  assert.equal(tiktokMetadataBackend({ reviewStorageMode: 'd1' }), 'd1');
  assert.equal(tiktokMetadataBackend({ reviewStorageMode: 'dual' }), 'd1');
  assert.equal(tiktokMetadataBackend({ reviewStorageMode: 'd1', tiktokMetadataBackend: 'redis' }), 'redis');
});

test('cleanup deletes at most 500 expired TikTok rows and never deletes Shopee or fresh rows', async (t) => {
  const { sqlite, db } = setup(); t.after(() => sqlite.close());
  const now = Date.now();
  const insert = sqlite.prepare(`INSERT INTO tiktok_product_metadata_cache
    (product_id, title, source, observed_at, updated_at, expires_at) VALUES (?, 'Old', 'test', ?, ?, ?)`);
  for (let i = 0; i < 510; i++) insert.run(String(1730952403445516400n + BigInt(i)), now - 6 * 86400_000, now - 6 * 86400_000, now - 1);
  insert.run('1730952403445519999', now, now, now + 86400_000);
  sqlite.prepare(`INSERT INTO product_metadata_cache (product_key, shop_id, item_id, title, source, updated_at, expires_at)
    VALUES ('shopee:1:2', '1', '2', 'Keep', 'test', ?, ?)`).run(now, now - 1);
  const result = await cleanupTikTokMetadata({ DB: db });
  assert.equal(result.deleted, 500);
  assert.equal(result.rowsWritten, 500);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM tiktok_product_metadata_cache').get().n, 11);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM product_metadata_cache').get().n, 1);
});
