import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../cloudflare/review-cache/worker.mjs';
import { saveReviewDatasets } from '../src/review-dataset-storage.mjs';
import { getCachedShopeeDataset, getCachedTikTokDataset, getShopeeProductMetadata, setShopeeProductMetadata } from '../src/product-cache.mjs';
import { fetchShopeeDetailActorMetadata } from '../src/shopee-detail-metadata.mjs';
import { saveCloudflareReviewBundle, verifyCloudflareReviewBundle } from '../src/cloudflare-review-store.mjs';
import { migrateReviewDatasets } from '../tools/migrate-review-datasets-to-d1.mjs';
import { createShopeeProductMetaHandler } from '../src/shopee-product-meta-route.mjs';
import { createShopeeMetadataTicket } from '../src/shopee-metadata-ticket.mjs';
import { fetchShopeePublicMetadata } from '../src/shopee-public-metadata.mjs';
import { publicProductHtml, PUBLIC_IMAGE } from './fixtures/shopee-public-metadata.mjs';

function fixture({ platform = 'Shopee', createdAt = new Date().toISOString(), runId = 'test-run', text = 'Sản phẩm đúng mô tả, dùng tốt.' } = {}) {
  const product = platform === 'Shopee' ? { platform, shopId: '452200291', itemId: '17701438002', title: 'Kính camera', image: 'https://down-vn.img.susercontent.com/file/example' }
    : { platform, productId: '1731238970187483121', title: 'Sản phẩm TikTok' };
  const reviews = Array.from({ length: 20 }, (_, index) => ({ reviewId: String(index), rating: index % 5 + 1, text: `${text} ${index}`, extra: { original: true } }));
  const source = { type: 'live', collection: { strategy: 'parallel-star-filters', ratingStrata: [1, 2, 3, 4, 5], targetMaximum: 100 } };
  const rawDataset = { schemaVersion: '1.0.0', datasetKind: 'raw-reviews', runId, createdAt, product, source,
    reviewCount: reviews.length, reviews, trailingField: 'Giữ nguyên thứ tự trường và dữ liệu.' };
  const labeledDataset = { ...rawDataset, datasetKind: 'labeled-reviews', reviews: reviews.map(review => ({ ...review, included: true, labels: { layer1: 'accepted' } })) };
  return { schemaVersion: '2.0.0', datasetKind: 'review-dataset-bundle', runId, createdAt, product, rawDataset, labeledDataset };
}

function sqliteD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../cloudflare/review-cache/migrations/0001_review_cache.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../cloudflare/review-cache/migrations/0002_product_metadata.sql', import.meta.url), 'utf8'));
  const db = {
    sqlite, failAt: null,
    prepare(sql) {
      return {
        values: [],
        bind(...values) { this.values = values; return this; },
        async first() { return sqlite.prepare(sql).get(...this.values) || null; },
        async all() { return { results: sqlite.prepare(sql).all(...this.values), meta: {} }; },
        execute() {
          const statement = sqlite.prepare(sql);
          if (/^\s*SELECT\b/i.test(sql)) return { results: statement.all(...this.values), meta: {} };
          const result = statement.run(...this.values);
          return { results: [], meta: { rows_written: Number(result.changes) } };
        }
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map((statement, index) => {
          if (index === db.failAt) throw new Error('Injected write failure');
          return statement.execute();
        });
        sqlite.exec('COMMIT'); return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  };
  return db;
}

function setup() {
  const db = sqliteD1();
  const env = { DB: db, REVIEW_CACHE_SECRET: 'local-test-secret' };
  const options = { reviewStorageMode: 'd1', cloudflareReviewUrl: 'https://review.test',
    cloudflareReviewSecret: env.REVIEW_CACHE_SECRET, blobReviewFallback: false,
    cloudflareFetchImpl: (url, init) => worker.fetch(new Request(url, init), env) };
  return { db, env, options };
}

test('D1 metadata caches exact Shopee title/image URL for five days and skips paid Actor', async () => {
  const { db, options } = setup();
  const metadata = { title: 'Kính camera chính hãng', image: 'https://down-vn.img.susercontent.com/file/product-image-123456' };
  const saved = await setShopeeProductMetadata('123', '456', metadata, options);
  assert.equal(saved.saved, true);
  assert.equal(Date.parse(saved.metadata.expiresAt) - Date.parse(saved.metadata.updatedAt), 5 * 86400_000);
  assert.equal((await getShopeeProductMetadata('123', '456', options)).image, metadata.image);
  assert.equal(await getShopeeProductMetadata('124', '456', options), null);
  const actor = await fetchShopeeDetailActorMetadata('https://shopee.vn/product/123/456', {
    ...options, reserveImpl: () => { throw new Error('Must not reserve an Actor'); },
    fetchImpl: () => { throw new Error('Must not call Apify or download images'); }
  });
  assert.equal(actor.status, 'cached');
  const repeated = await setShopeeProductMetadata('123', '456', metadata, options);
  assert.equal(repeated.metadata.expiresAt, saved.metadata.expiresAt, 'identical writes do not refresh expiry');
  db.sqlite.prepare('UPDATE product_metadata_cache SET expires_at = ?').run(Date.now() - 1);
  assert.equal(await getShopeeProductMetadata('123', '456', options), null);
  const partial = await setShopeeProductMetadata('123', '456', { title: 'Tên mới' }, options);
  assert.equal(partial.metadata.image, undefined, 'expired image must not be revived by a title-only write');
  db.sqlite.close();
});

test('D1 metadata rejects Blob images and unauthorized requests', async () => {
  const { db, env } = setup();
  const url = 'https://review.test/v1/product-metadata';
  const body = { shopId: '123', itemId: '456', image: 'https://example.public.blob.vercel-storage.com/image.webp' };
  assert.equal((await worker.fetch(new Request(url, { method: 'POST', body: JSON.stringify(body) }), env)).status, 401);
  assert.equal((await worker.fetch(new Request(url, { method: 'POST', headers: { authorization: `Bearer ${env.REVIEW_CACHE_SECRET}` }, body: JSON.stringify(body) }), env)).status, 400);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM product_metadata_cache').get().n, 0);
  db.sqlite.close();
});

test('public-source POST persists exact metadata in D1, GET/cache skip public requests and paid usage', async () => {
  const { db, options } = setup();
  const oldSecret = process.env.RESULT_CONTEXT_SIGNING_SECRET;
  process.env.RESULT_CONTEXT_SIGNING_SECRET = 'public-source-d1-local-test';
  let requests = 0;
  let actorCalls = 0;
  const route = createShopeeProductMetaHandler({
    getMetadata: (shopId, itemId) => getShopeeProductMetadata(shopId, itemId, options),
    saveMetadata: (shopId, itemId, metadata, extra) => setShopeeProductMetadata(shopId, itemId, metadata, { ...options, ...extra }),
    fetchPublic: (url, ids) => fetchShopeePublicMetadata(url, { ...ids, fetchImpl: async () => {
      requests++; return new Response(publicProductHtml(), { headers: { 'content-type': 'text/html' } });
    } }),
    fetchActor: async () => { actorCalls++; throw new Error('Must not reserve paid Actor'); }
  });
  const productUrl = 'https://shopee.vn/product/452200291/17701438002';
  const response = () => ({ setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } });
  try {
    const request = { method: 'POST', headers: { host: 'realview.com.vn' }, body: {
      url: productUrl, metadataTicket: createShopeeMetadataTicket('452200291', '17701438002')
    } };
    const first = response(); await route(request, first);
    assert.equal(first.body.status, 'resolved');
    assert.equal(first.body.metadata.image, PUBLIC_IMAGE);
    assert.equal(Date.parse(first.body.metadata.expiresAt) - Date.parse(first.body.metadata.updatedAt), 5 * 86400_000);
    const second = response(); await route(request, second);
    assert.equal(second.body.status, 'cached');
    const read = response(); await route({ method: 'GET', headers: {}, url: `/api/shopee-product-meta?url=${encodeURIComponent(productUrl)}` }, read);
    assert.equal(read.body.metadata.image, PUBLIC_IMAGE);
    assert.equal(requests, 1);
    assert.equal(actorCalls, 0);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM product_metadata_cache').get().n, 1);
  } finally {
    db.sqlite.close();
    if (oldSecret === undefined) delete process.env.RESULT_CONTEXT_SIGNING_SECRET;
    else process.env.RESULT_CONTEXT_SIGNING_SECRET = oldSecret;
  }
});

test('D1 reproduces raw, labels, Unicode, order and headers exactly; cache requires no Redis or Blob', async () => {
  const { db, options } = setup();
  for (const platform of ['Shopee', 'TikTok Shop']) {
    const bundle = fixture({ platform });
    const stored = await saveCloudflareReviewBundle(bundle, 'a'.repeat(32), options);
    assert.equal((await verifyCloudflareReviewBundle(stored.datasetId, bundle, options)).matches, true);
    const cached = platform === 'Shopee'
      ? await getCachedShopeeDataset(bundle.product.itemId, { ...options, shopId: bundle.product.shopId })
      : await getCachedTikTokDataset(bundle.product.productId, options);
    assert.deepEqual(cached.dataset, bundle.rawDataset);
    assert.equal(cached.mapping.provider, 'cloudflare-d1');
  }
  db.sqlite.close();
});

test('concurrent identical fingerprints commit one complete dataset and original expiry', async () => {
  const { db, options } = setup();
  const first = fixture({ createdAt: new Date(Date.now() - 1000).toISOString(), runId: 'first' });
  const second = fixture({ runId: 'second' });
  const stored = await Promise.all([first, second].map(bundle => saveCloudflareReviewBundle(bundle, 'b'.repeat(32), options)));
  assert.equal(stored[0].datasetId, stored[1].datasetId);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM review_datasets').get().n, 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM review_entries').get().n, 40);
  const cached = await getCachedShopeeDataset(first.product.itemId, options);
  assert.equal(cached.dataset.createdAt, stored[0].createdAt);
  db.sqlite.close();
});

test('older imports cannot replace a newer cache; expired archives stay stored but never refresh cache', async () => {
  const { db, options } = setup();
  const newer = fixture({ runId: 'newest' });
  const older = fixture({ createdAt: new Date(Date.now() - 86400_000).toISOString(), runId: 'older' });
  const expired = fixture({ createdAt: new Date(Date.now() - 6 * 86400_000).toISOString(), runId: 'expired' });
  for (const [index, bundle] of [newer, older, expired].entries()) {
    await saveCloudflareReviewBundle(bundle, String(index).repeat(32), { ...options, importedFrom: `old-${index}` });
  }
  assert.equal((await getCachedShopeeDataset(newer.product.itemId, options)).dataset.runId, 'newest');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM review_datasets').get().n, 3);
  const expiry = db.sqlite.prepare('SELECT expires_at FROM review_cache_latest').get().expires_at;
  await getCachedShopeeDataset(newer.product.itemId, options);
  assert.equal(db.sqlite.prepare('SELECT expires_at FROM review_cache_latest').get().expires_at, expiry);
  db.sqlite.close();
});

test('failed transaction rolls back entries and pointer; retry completes without duplicates', async () => {
  const { db, options } = setup();
  const bundle = fixture();
  db.failAt = 3;
  await assert.rejects(saveCloudflareReviewBundle(bundle, 'c'.repeat(32), options), /HTTP_503/);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM review_datasets').get().n, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM review_cache_latest').get().n, 0);
  db.failAt = null;
  const saved = await saveCloudflareReviewBundle(bundle, 'c'.repeat(32), options);
  assert.equal((await verifyCloudflareReviewBundle(saved.datasetId, bundle, options)).matches, true);
  db.sqlite.close();
});

test('auth, wrong shop, incomplete strata and unfinished Actor cannot publish usable cache', async () => {
  const { db, env, options } = setup();
  assert.equal((await worker.fetch(new Request('https://review.test/v1/cache?key=shopee:17701438002'), env)).status, 401);
  const bundle = fixture();
  bundle.rawDataset.source.collection.ratingStrata = [5];
  await saveCloudflareReviewBundle(bundle, 'd'.repeat(32), options);
  assert.equal(await getCachedShopeeDataset(bundle.product.itemId, options), null);
  const good = fixture();
  await saveCloudflareReviewBundle(good, 'e'.repeat(32), options);
  assert.equal(await getCachedShopeeDataset(good.product.itemId, { ...options, shopId: '999' }), null);
  const tiktok = fixture({ platform: 'TikTok Shop' });
  tiktok.rawDataset.source.collection.cacheable = false;
  await saveCloudflareReviewBundle(tiktok, 'f'.repeat(32), options);
  assert.equal(await getCachedTikTokDataset(tiktok.product.productId, options), null);
  db.sqlite.close();
});

test('D1 primary save preserves result success even when storage is unavailable and fallback disabled', async () => {
  const { db, options } = setup();
  const bundle = fixture();
  const input = { rawReviews: bundle.rawDataset.reviews, labeledReviews: bundle.labeledDataset.reviews,
    product: bundle.product, source: bundle.rawDataset.source };
  const stored = await saveReviewDatasets(input, options);
  assert.equal(stored.provider, 'cloudflare-d1');
  assert.equal(stored.saved, true);
  assert.equal(stored.blobOperations, 0);
  let blobCalls = 0;
  const unavailable = { ...options,
    cloudflareFetchImpl: async () => { throw new Error('NETWORK_TIMEOUT'); },
    blobPutImpl: async () => { blobCalls++; throw new Error('BLOB_MUST_NOT_BE_CALLED'); },
    blobGetImpl: async () => { blobCalls++; throw new Error('BLOB_MUST_NOT_BE_CALLED'); },
    redisFetchImpl: async () => { throw new Error('LEGACY_CACHE_MUST_NOT_BE_CALLED'); }
  };
  const failed = await saveReviewDatasets(input, unavailable);
  assert.equal(failed.saved, false);
  assert.match(failed.warning, /kết quả phân tích/);
  assert.equal(await getCachedShopeeDataset(bundle.product.itemId, unavailable), null);
  assert.equal(await getCachedTikTokDataset('1730000000000000001', unavailable), null);
  assert.equal(blobCalls, 0);
  db.sqlite.close();
});

test('migration verifies v2 and legacy pairs, preserves age, can run again, and reports missing labels', async () => {
  const { db, options } = setup();
  const v2 = fixture({ runId: 'v2' });
  const v1 = fixture({ runId: 'v1', createdAt: new Date(Date.now() - 6 * 86400_000).toISOString() });
  const objects = new Map([
    ['review-datasets/2026/10/01/shopee-17701438002/v2/reviews.dataset.json', v2],
    ['review-datasets/2026/09/25/shopee-17701438002/v1/reviews.raw.json', v1.rawDataset],
    ['review-datasets/2026/09/25/shopee-17701438002/v1/reviews.labeled.json', v1.labeledDataset],
    ['review-datasets/2026/09/25/shopee-17701438002/missing/reviews.raw.json', v1.rawDataset]
  ]);
  const migrationOptions = { ...options, apply: true, scope: 'all',
    blobListImpl: async () => ({ blobs: [...objects.keys()].map(pathname => ({ pathname })), hasMore: false }),
    blobGetImpl: async pathname => ({ statusCode: 200, stream: new Response(JSON.stringify(objects.get(pathname))).body }) };
  const report = await migrateReviewDatasets(migrationOptions);
  assert.equal(report.verified, 2);
  assert.equal(report.failures[0].reason, 'LEGACY_LABELED_DATASET_MISSING');
  const repeat = await migrateReviewDatasets(migrationOptions);
  assert.equal(repeat.verified, 2);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM review_datasets').get().n, 2);
  db.sqlite.close();
});
