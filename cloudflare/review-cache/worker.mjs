import { productCacheIdentity, REVIEW_CACHE_TTL_SECONDS, validateReviewCache } from '../../src/review-cache-policy.mjs';
import { tiktokMetadataRoute, cleanupTikTokMetadata } from './tiktok-metadata.mjs';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROW_BYTES = 1_900_000;
const encoder = new TextEncoder();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'
  } });
}

async function digest(text) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function authorized(request, env) {
  if (!env.REVIEW_CACHE_SECRET || !request.headers.get('authorization')) return false;
  const [expected, actual] = await Promise.all([
    digest(`Bearer ${env.REVIEW_CACHE_SECRET}`), digest(request.headers.get('authorization'))
  ]);
  return expected === actual;
}

function validateBundle(bundle) {
  if (bundle?.datasetKind !== 'review-dataset-bundle' || !bundle.runId) throw new Error('INVALID_BUNDLE');
  const raw = bundle.rawDataset;
  const labeled = bundle.labeledDataset;
  const key = productCacheIdentity(raw?.product);
  if (!key || raw?.datasetKind !== 'raw-reviews' || labeled?.datasetKind !== 'labeled-reviews'
    || productCacheIdentity(labeled.product) !== key || productCacheIdentity(bundle.product) !== key
    || !Array.isArray(raw.reviews) || !Array.isArray(labeled.reviews)
    || raw.reviews.length + labeled.reviews.length > 800
    || raw.reviewCount !== raw.reviews.length || labeled.reviewCount !== labeled.reviews.length
    || raw.createdAt !== bundle.createdAt || labeled.createdAt !== bundle.createdAt
    || raw.runId !== bundle.runId || labeled.runId !== bundle.runId) throw new Error('INVALID_BUNDLE');
  const createdAt = Date.parse(bundle.createdAt);
  if (!Number.isFinite(createdAt) || createdAt > Date.now() + 5_000) throw new Error('INVALID_CREATED_AT');
  return { key, createdAt };
}

async function reconstruct(db, row) {
  if (!row) return null;
  const entries = await db.prepare('SELECT kind, position, data_json FROM review_entries WHERE dataset_id = ? ORDER BY kind, position')
    .bind(row.id).all();
  const bundle = JSON.parse(row.header_json);
  bundle.rawDataset.reviews = [];
  bundle.labeledDataset.reviews = [];
  for (const entry of entries.results) {
    const target = entry.kind === 'raw' ? bundle.rawDataset.reviews : bundle.labeledDataset.reviews;
    if (entry.position !== target.length) throw new Error('DATASET_INCOMPLETE');
    target.push(JSON.parse(entry.data_json));
  }
  if (bundle.rawDataset.reviews.length !== row.raw_count || bundle.labeledDataset.reviews.length !== row.labeled_count
    || await digest(JSON.stringify(bundle)) !== row.content_hash) throw new Error('DATASET_INTEGRITY_FAILED');
  return bundle;
}

async function writeDataset(request, env) {
  if (Number(request.headers.get('content-length')) > MAX_BYTES) return json({ error: 'PAYLOAD_TOO_LARGE' }, 413);
  const text = await request.text();
  if (encoder.encode(text).byteLength > MAX_BYTES) return json({ error: 'PAYLOAD_TOO_LARGE' }, 413);
  const body = JSON.parse(text);
  const bundle = body.bundle;
  const { key, createdAt } = validateBundle(bundle);
  if (!/^[a-f0-9]{32,64}$/.test(body.fingerprint || '')) throw new Error('INVALID_FINGERPRINT');
  const serialized = JSON.stringify(bundle);
  const contentHash = await digest(serialized);
  const id = contentHash;
  const now = Date.now();
  const expiresAt = createdAt + REVIEW_CACHE_TTL_SECONDS * 1000;
  // Imports preserve every historical bundle. Live writes reuse the first complete
  // bundle with this fingerprint for five days, matching the existing Blob dedupe.
  const dedupeKey = body.importedFrom ? `import:${id}` : `${key}:${body.fingerprint}`;
  const header = structuredClone(bundle);
  header.rawDataset.reviews = null;
  header.labeledDataset.reviews = null;
  const headerJson = JSON.stringify(header);
  if (encoder.encode(headerJson).byteLength > MAX_ROW_BYTES) throw new Error('ROW_TOO_LARGE');
  const rows = [];
  for (const [kind, reviews] of [['raw', bundle.rawDataset.reviews], ['labeled', bundle.labeledDataset.reviews]]) {
    reviews.forEach((review, position) => {
      const data = JSON.stringify(review);
      if (encoder.encode(data).byteLength > MAX_ROW_BYTES) throw new Error('ROW_TOO_LARGE');
      rows.push({ kind, position, data });
    });
  }
  const eligibility = validateReviewCache(bundle.rawDataset, { now });
  const publishCache = body.cacheable !== false && bundle.rawDataset.source?.collection?.cacheable !== false && eligibility.valid;
  const db = env.DB;
  const selectedIdSql = '(SELECT dataset_id FROM review_write_dedupe WHERE dedupe_key = ?)';
  const statements = [
    db.prepare(`INSERT OR IGNORE INTO review_datasets
      (id, product_key, fingerprint, run_id, created_at, expires_at, header_json, raw_count,
       labeled_count, content_hash, byte_length, imported_from, stored_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM review_write_dedupe WHERE dedupe_key = ? AND expires_at > ?)`)
      .bind(id, key, body.fingerprint, bundle.runId, createdAt, expiresAt, headerJson, rows.filter(r => r.kind === 'raw').length,
        rows.filter(r => r.kind === 'labeled').length, contentHash, encoder.encode(serialized).byteLength,
        String(body.importedFrom || '').slice(0, 1000) || null, now, dedupeKey, now),
    db.prepare(`INSERT INTO review_write_dedupe (dedupe_key, dataset_id, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(dedupe_key) DO UPDATE SET dataset_id = excluded.dataset_id, expires_at = excluded.expires_at
      WHERE review_write_dedupe.expires_at <= ?`).bind(dedupeKey, id, now + REVIEW_CACHE_TTL_SECONDS * 1000, now),
    ...rows.map(row => db.prepare(`INSERT OR IGNORE INTO review_entries (dataset_id, kind, position, data_json)
      SELECT ?, ?, ?, ? WHERE ? = ${selectedIdSql}`).bind(id, row.kind, row.position, row.data, id, dedupeKey))
  ];
  if (publishCache) {
    statements.push(db.prepare(`INSERT INTO review_cache_latest (product_key, dataset_id, created_at, expires_at)
      SELECT product_key, id, created_at, expires_at FROM review_datasets WHERE id = ${selectedIdSql} AND expires_at > ?
      ON CONFLICT(product_key) DO UPDATE SET dataset_id = excluded.dataset_id,
        created_at = excluded.created_at, expires_at = excluded.expires_at
      WHERE excluded.created_at > review_cache_latest.created_at`).bind(dedupeKey, now));
  }
  statements.push(db.prepare(`SELECT id, run_id, created_at, expires_at, raw_count, labeled_count, content_hash
    FROM review_datasets WHERE id = ${selectedIdSql}`).bind(dedupeKey));
  const results = await db.batch(statements);
  const stored = results.at(-1).results[0];
  if (!stored) throw new Error('WRITE_NOT_CONFIRMED');
  const metrics = results.reduce((acc, result) => ({
    rowsRead: acc.rowsRead + (result.meta?.rows_read || 0), rowsWritten: acc.rowsWritten + (result.meta?.rows_written || 0)
  }), { rowsRead: 0, rowsWritten: 0 });
  console.log(JSON.stringify({ event: 'review_dataset_write', productKey: key, id: stored.id,
    reused: stored.id !== id, cacheable: publishCache, ...metrics }));
  return json({ saved: true, datasetId: stored.id, runId: stored.run_id,
    createdAt: new Date(stored.created_at).toISOString(), expiresAt: new Date(stored.expires_at).toISOString(),
    reused: stored.id !== id, rawCount: stored.raw_count, labeledCount: stored.labeled_count,
    contentHash: stored.content_hash, cacheable: publishCache, ...metrics });
}

export default {
  async scheduled(_event, env) {
    try { await cleanupTikTokMetadata(env); }
    catch (error) {
      console.error(JSON.stringify({ event: 'tiktok_metadata_cleanup_failed', code: 'STORAGE_ERROR' }));
      throw error;
    }
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ service: 'realview-review-cache', schemaVersion: 1 });
    }
    if (!await authorized(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
    try {
      if (url.pathname === '/v1/tiktok-product-metadata' && ['GET', 'POST'].includes(request.method)) {
        return json(await tiktokMetadataRoute(request, env));
      }
      if (url.pathname === '/v1/product-metadata' && ['GET', 'POST'].includes(request.method)) {
        if (Number(request.headers.get('content-length')) > 8192) return json({ error: 'PAYLOAD_TOO_LARGE' }, 413);
        let input;
        if (request.method === 'POST') {
          const text = await request.text();
          if (encoder.encode(text).byteLength > 8192) return json({ error: 'PAYLOAD_TOO_LARGE' }, 413);
          input = JSON.parse(text);
        } else input = Object.fromEntries(url.searchParams);
        const shopId = String(input.shopId || '');
        const itemId = String(input.itemId || '');
        if (!/^\d{1,25}$/.test(shopId) || !/^\d{1,25}$/.test(itemId)) throw new Error('INVALID_METADATA_ID');
        const key = `shopee:${shopId}:${itemId}`;
        const now = Date.now();
        const select = () => env.DB.prepare('SELECT * FROM product_metadata_cache WHERE product_key = ? AND expires_at > ?').bind(key, now);
        if (request.method === 'POST') {
          const title = String(input.title || '').trim().slice(0, 1000);
          const image = String(input.image || '').trim();
          if (image) {
            const imageUrl = new URL(image);
            if (imageUrl.protocol !== 'https:' || !/(?:^|\.)susercontent\.com$/i.test(imageUrl.hostname)
              || imageUrl.username || imageUrl.password || image.length > 3000) throw new Error('INVALID_METADATA_IMAGE');
          }
          if (!title && !image) throw new Error('INVALID_METADATA_EMPTY');
          await env.DB.batch([env.DB.prepare(`INSERT INTO product_metadata_cache
            (product_key, shop_id, item_id, title, image_url, source, updated_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(product_key) DO UPDATE SET
              title = CASE WHEN excluded.title != '' THEN excluded.title WHEN product_metadata_cache.expires_at > ? THEN product_metadata_cache.title ELSE '' END,
              image_url = CASE WHEN excluded.image_url != '' THEN excluded.image_url WHEN product_metadata_cache.expires_at > ? THEN product_metadata_cache.image_url ELSE '' END,
              source = excluded.source, updated_at = excluded.updated_at, expires_at = excluded.expires_at
            WHERE product_metadata_cache.expires_at <= ?
              OR (excluded.title != '' AND excluded.title != COALESCE(product_metadata_cache.title, ''))
              OR (excluded.image_url != '' AND excluded.image_url != COALESCE(product_metadata_cache.image_url, ''))`)
            .bind(key, shopId, itemId, title, image, String(input.source || 'unknown').slice(0, 40), now,
              now + REVIEW_CACHE_TTL_SECONDS * 1000, now, now, now)]);
        }
        const row = await select().first();
        const metadata = row ? { shopId: row.shop_id, itemId: row.item_id,
          ...(row.title ? { title: row.title } : {}), ...(row.image_url ? { image: row.image_url } : {}),
          source: row.source, updatedAt: new Date(row.updated_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString() } : null;
        return json(request.method === 'GET' ? { hit: Boolean(row), metadata } : { saved: Boolean(row), metadata });
      }
      if (request.method === 'POST' && url.pathname === '/v1/datasets') return await writeDataset(request, env);
      if (request.method === 'GET' && url.pathname === '/v1/cache') {
        const key = url.searchParams.get('key');
        if (!/^(?:shopee:\d+|tiktok:\d{8,25})$/.test(key || '')) return json({ error: 'INVALID_PRODUCT_KEY' }, 400);
        const row = await env.DB.prepare(`SELECT d.* FROM review_cache_latest c
          JOIN review_datasets d ON d.id = c.dataset_id WHERE c.product_key = ? AND c.expires_at > ?`)
          .bind(key, Date.now()).first();
        if (!row) return json({ hit: false });
        const bundle = await reconstruct(env.DB, row);
        if (!validateReviewCache(bundle.rawDataset).valid) return json({ hit: false });
        return json({ hit: true, datasetId: row.id, bundle });
      }
      if (request.method === 'GET' && /^\/v1\/datasets\/[a-f0-9]{64}$/.test(url.pathname)) {
        const row = await env.DB.prepare('SELECT * FROM review_datasets WHERE id = ?').bind(url.pathname.split('/').at(-1)).first();
        return row ? json({ datasetId: row.id, bundle: await reconstruct(env.DB, row) }) : json({ error: 'NOT_FOUND' }, 404);
      }
      return json({ error: 'NOT_FOUND' }, 404);
    } catch (error) {
      const invalid = error instanceof SyntaxError || /^(?:INVALID_|ROW_TOO_LARGE|PAYLOAD_TOO_LARGE)/.test(error.message);
      console.error(JSON.stringify({ event: 'review_cache_error', path: url.pathname,
        code: invalid ? 'INVALID_REQUEST' : 'STORAGE_ERROR' }));
      return json({ error: invalid ? 'INVALID_REQUEST' : 'STORAGE_ERROR' }, invalid ? 400 : 503);
    }
  }
};
