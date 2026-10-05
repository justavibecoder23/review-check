import { normalizeD1TikTokMetadata, TIKTOK_METADATA_TTL_MS } from '../../src/tiktok-metadata-policy.mjs';

const encoder = new TextEncoder();
const MAX_BYTES = 8192;

function metadata(row) {
  return row ? { productId: row.product_id,
    ...(row.title ? { title: row.title } : {}), ...(row.image_url ? { image: row.image_url } : {}),
    ...(row.price ? { price: row.price } : {}), ...(row.rating ? { rating: row.rating } : {}),
    source: row.source, observedAt: new Date(row.observed_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString() } : null;
}

export async function tiktokMetadataRoute(request, env) {
  if (Number(request.headers.get('content-length')) > MAX_BYTES) throw new Error('PAYLOAD_TOO_LARGE');
  const now = Date.now();
  let input;
  if (request.method === 'POST') {
    const text = await request.text();
    if (encoder.encode(text).byteLength > MAX_BYTES) throw new Error('PAYLOAD_TOO_LARGE');
    input = JSON.parse(text);
  } else input = Object.fromEntries(new URL(request.url).searchParams);
  const id = String(input.productId || '');
  if (typeof input.productId !== 'string' || !/^\d{8,25}$/.test(id)) throw new Error('INVALID_METADATA_ID');
  let rowsWritten = 0;
  let rowsRead = 0;
  if (request.method === 'POST') {
    // Reject invalid images rather than silently storing a title from a malformed request.
    const data = normalizeD1TikTokMetadata(id, input, now);
    if (!data || (input.image && !data.image)) throw new Error('INVALID_METADATA');
    const observedAt = Date.parse(data.observedAt);
    // Preserving any older field also preserves the older expiry: a fresh
    // partial title must not extend an old image's lifetime. The operation and
    // age guard are atomic; a late older request cannot overwrite newer data.
    const preserve = `(tiktok_product_metadata_cache.expires_at > ? AND
      ((excluded.title = '' AND tiktok_product_metadata_cache.title != '')
      OR (excluded.image_url = '' AND tiktok_product_metadata_cache.image_url != '')
      OR (excluded.price = '' AND tiktok_product_metadata_cache.price != '')
      OR (excluded.rating IS NULL AND tiktok_product_metadata_cache.rating IS NOT NULL)))`;
    const results = await env.DB.batch([env.DB.prepare(`INSERT INTO tiktok_product_metadata_cache
      (product_id, title, image_url, price, rating, source, observed_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(product_id) DO UPDATE SET
        title = CASE WHEN excluded.title != '' THEN excluded.title WHEN tiktok_product_metadata_cache.expires_at > ? THEN tiktok_product_metadata_cache.title ELSE '' END,
        image_url = CASE WHEN excluded.image_url != '' THEN excluded.image_url WHEN tiktok_product_metadata_cache.expires_at > ? THEN tiktok_product_metadata_cache.image_url ELSE '' END,
        price = CASE WHEN excluded.price != '' THEN excluded.price WHEN tiktok_product_metadata_cache.expires_at > ? THEN tiktok_product_metadata_cache.price ELSE '' END,
        rating = CASE WHEN excluded.rating IS NOT NULL THEN excluded.rating WHEN tiktok_product_metadata_cache.expires_at > ? THEN tiktok_product_metadata_cache.rating ELSE NULL END,
        source = excluded.source, updated_at = excluded.updated_at,
        observed_at = excluded.observed_at,
        expires_at = CASE WHEN ${preserve} THEN MIN(tiktok_product_metadata_cache.expires_at, excluded.expires_at) ELSE excluded.expires_at END
      WHERE excluded.observed_at >= tiktok_product_metadata_cache.observed_at AND
        (tiktok_product_metadata_cache.expires_at <= ?
        OR (excluded.title != '' AND excluded.title != tiktok_product_metadata_cache.title)
        OR (excluded.image_url != '' AND excluded.image_url != tiktok_product_metadata_cache.image_url)
        OR (excluded.price != '' AND excluded.price != tiktok_product_metadata_cache.price)
        OR (excluded.rating IS NOT NULL AND excluded.rating IS NOT tiktok_product_metadata_cache.rating))`)
      .bind(id, data.title || '', data.image || '', data.price || '', data.rating ?? null, data.source,
        observedAt, now, observedAt + TIKTOK_METADATA_TTL_MS, now, now, now, now, now, now)]);
    rowsWritten = results.reduce((total, result) => total + (result.meta?.rows_written || 0), 0);
    rowsRead += results.reduce((total, result) => total + (result.meta?.rows_read || 0), 0);
  }
  const selected = await env.DB.prepare('SELECT * FROM tiktok_product_metadata_cache WHERE product_id = ? AND expires_at > ?').bind(id, now).all();
  rowsRead += selected.meta?.rows_read || 0;
  const row = selected.results?.[0];
  const data = metadata(row);
  console.log(JSON.stringify({ event: request.method === 'GET' ? 'tiktok_metadata_read' : 'tiktok_metadata_write', productId: id, hit: Boolean(data), rowsRead, rowsWritten }));
  if (request.method === 'GET') return { hit: Boolean(data), metadata: data, rowsRead };
  return { saved: Boolean(data), metadata: data, rowsRead, rowsWritten };
}

export async function cleanupTikTokMetadata(env) {
  const now = Date.now();
  const results = await env.DB.batch([env.DB.prepare(`DELETE FROM tiktok_product_metadata_cache
    WHERE product_id IN (SELECT product_id FROM tiktok_product_metadata_cache
      WHERE expires_at <= ? ORDER BY expires_at LIMIT 500) AND expires_at <= ?`).bind(now, now)]);
  const rowsWritten = results.reduce((total, result) => total + (result.meta?.rows_written || 0), 0);
  const deleted = results.reduce((total, result) => total + (result.meta?.changes || 0), 0);
  const rowsRead = results.reduce((total, result) => total + (result.meta?.rows_read || 0), 0);
  const event = { event: 'tiktok_metadata_cleanup', deleted, rowsRead, rowsWritten, batchLimit: 500 };
  console.log(JSON.stringify(event));
  if (deleted >= 500) console.warn(JSON.stringify({ event: 'tiktok_metadata_cleanup_batch_full', deleted, rowsWritten }));
  return event;
}
