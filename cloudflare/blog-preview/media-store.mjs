import { BLOG_WRITE_AUTH_SQL, assertBlogWriteAccess } from './access-guard.mjs';
import { blogBodyHash } from './request-auth.mjs';
import { blogError } from './draft-store.mjs';

export const MEDIA_RULE = 'r2-webp-v1-q84-480-960-1600';
const HEX = /^[a-f0-9]{64}$/;
const MAX = 3 * 1024 * 1024;
const pathFor = (hash, width) => `blog/${MEDIA_RULE}/${hash}/${width}w.webp`;
export async function mediaFingerprint(sourceHash, manifest) {
  return blogBodyHash(new TextEncoder().encode(`${MEDIA_RULE}:${sourceHash}:${JSON.stringify(manifest)}`));
}
function decode(value) {
  if (typeof value !== 'string' || value.length > 4_194_304 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(value) || value.length % 4) throw blogError('BLOG_MEDIA_INVALID_BASE64', 400);
  const raw = atob(value);
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}
function asset(hash, manifest) {
  const responsiveSources = manifest.map(item => ({ ...item, contentType: 'image/webp',
    pathname: pathFor(hash, item.width), url: `/api/blog?route=cloudflare-media&hash=${hash}&width=${item.width}` }));
  return { id: hash, ...responsiveSources.at(-1), responsiveSources };
}
function correctHead(object, item) {
  return object && object.size === item.size && object.httpMetadata?.contentType === 'image/webp'
    && object.customMetadata?.sha256 === item.sha256;
}
export async function uploadMedia(db, bucket, input, envelope, options = {}) {
  if (!bucket) throw blogError('BLOG_MEDIA_STORAGE_UNAVAILABLE', 503);
  await assertBlogWriteAccess(db, envelope.actorId);
  if (!HEX.test(input.sourceHash || '') || !Array.isArray(input.variants) || !input.variants.length || input.variants.length > 3) {
    throw blogError('BLOG_MEDIA_INVALID_IMAGE', 400);
  }
  const processed = [];
  for (const variant of input.variants) {
    const data = decode(variant.data);
    if (!data.length || data.length > MAX || !Number.isSafeInteger(variant.width) || variant.width < 1 || variant.width > 1600
      || !Number.isSafeInteger(variant.height) || variant.height < 1 || variant.width * variant.height > 40_000_000
      || data.length < 12 || new TextDecoder().decode(data.slice(0, 4)) !== 'RIFF'
      || new TextDecoder().decode(data.slice(8, 12)) !== 'WEBP') throw blogError('BLOG_MEDIA_INVALID_IMAGE', 400);
    processed.push({ data, item: { width: variant.width, height: variant.height, size: data.length, sha256: await blogBodyHash(data) } });
  }
  processed.sort((a, b) => a.item.width - b.item.width);
  if (new Set(processed.map(p => p.item.width)).size !== processed.length) throw blogError('BLOG_MEDIA_INVALID_IMAGE', 400);
  const manifest = processed.map(p => p.item);
  const hash = await mediaFingerprint(input.sourceHash, manifest);
  const json = JSON.stringify(manifest);
  const previous = await db.prepare('SELECT * FROM blog_media WHERE hash=?').bind(hash).first();
  if (previous?.state === 'ready') return asset(hash, manifest);
  const owner = crypto.randomUUID();
  const acquired = await db.prepare(`INSERT INTO blog_media
    SELECT ?,?,'pending',?,1,CAST(strftime('%s','now') AS INTEGER)+90,CAST(strftime('%s','now') AS INTEGER),NULL
    WHERE ${BLOG_WRITE_AUTH_SQL}
    ON CONFLICT(hash) DO UPDATE SET owner=excluded.owner,fence=blog_media.fence+1,lease_until=excluded.lease_until
    WHERE blog_media.state='pending' AND blog_media.lease_until <= CAST(strftime('%s','now') AS INTEGER)
      AND blog_media.manifest_json=excluded.manifest_json`).bind(hash, json, owner, envelope.actorId, 0).run();
  if (acquired.meta?.changes !== 1) {
    await assertBlogWriteAccess(db, envelope.actorId);
    const ready = await db.prepare('SELECT state FROM blog_media WHERE hash=?').bind(hash).first();
    if (ready?.state === 'ready') return asset(hash, manifest);
    throw blogError('BLOG_MEDIA_RETRY', 503);
  }
  const lease = await db.prepare('SELECT fence FROM blog_media WHERE hash=? AND owner=?').bind(hash, owner).first();
  if (!lease) throw blogError('BLOG_MEDIA_RETRY', 503);
  async function renew() {
    const renewed = await db.prepare(`UPDATE blog_media SET lease_until=CAST(strftime('%s','now') AS INTEGER)+90
      WHERE hash=? AND owner=? AND fence=? AND state='pending'
      AND lease_until > CAST(strftime('%s','now') AS INTEGER) AND ${BLOG_WRITE_AUTH_SQL}`)
      .bind(hash, owner, lease.fence, envelope.actorId, 0).run();
    if (renewed.meta?.changes !== 1) {
      await assertBlogWriteAccess(db, envelope.actorId);
      throw blogError('BLOG_MEDIA_RETRY', 503);
    }
  }
  // Renewal and fencing are complementary. An ambiguous/failed heartbeat
  // stops opening new PUTs. An in-flight PUT may finish but cannot publish a
  // ready mapping after losing its lease.
  let lost = null;
  let renewing = Promise.resolve();
  const timer = (options.setIntervalImpl || setInterval)(() => {
    if (!lost) renewing = renewing.then(renew).catch(error => { lost = error; });
  }, 10_000);
  const stopHeartbeat = () => (options.clearIntervalImpl || clearInterval)(timer);
  async function ensureLease() {
    await renewing;
    if (lost) throw lost;
    await renew();
  }
  try {
    for (const { item, data } of processed) {
      await ensureLease();
      const key = pathFor(hash, item.width);
      let stored = lease.fence > 1 ? await bucket.head(key) : null;
      if (stored && !correctHead(stored, item)) throw blogError('BLOG_MEDIA_OBJECT_CONFLICT', 409);
      if (!stored) {
        try {
          stored = await bucket.put(key, data, { onlyIf: new Headers({ 'if-none-match': '*' }),
            httpMetadata: { contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' },
            customMetadata: { sha256: item.sha256, rule: MEDIA_RULE }, sha256: item.sha256 });
        } catch (error) {
          if (error?.code === 'BLOG_AUDIT_UNAVAILABLE') throw error;
          // Timeout is ambiguous; HEAD the SAME predetermined key, never put blindly again.
          stored = await bucket.head(key);
        }
        if (!stored) stored = await bucket.head(key);
        if (!correctHead(stored, item)) throw blogError('BLOG_MEDIA_RETRY', 503);
      }
    }
    await ensureLease();
    for (const item of manifest) if (!correctHead(await bucket.head(pathFor(hash, item.width)), item)) throw blogError('BLOG_MEDIA_RETRY', 503);
    stopHeartbeat();
    await ensureLease();
    const done = await db.prepare(`UPDATE blog_media SET state='ready',ready_at=CAST(strftime('%s','now') AS INTEGER)
      WHERE hash=? AND owner=? AND fence=? AND state='pending'
      AND lease_until > CAST(strftime('%s','now') AS INTEGER) AND ${BLOG_WRITE_AUTH_SQL}`)
      .bind(hash, owner, lease.fence, envelope.actorId, 0).run();
    if (done.meta?.changes !== 1) { await assertBlogWriteAccess(db, envelope.actorId); throw blogError('BLOG_MEDIA_RETRY', 503); }
    return asset(hash, manifest);
  } catch (error) {
    // Conditional release cannot unlock another owner's lease. Objects are NOT deleted.
    await db.prepare("UPDATE blog_media SET lease_until=0 WHERE hash=? AND owner=? AND fence=? AND state='pending'")
      .bind(hash, owner, lease.fence).run().catch(() => {});
    if (error?.statusCode) throw error;
    throw blogError('BLOG_MEDIA_RETRY', 503);
  } finally {
    stopHeartbeat();
    await renewing;
  }
}
export async function readMedia(db, bucket, hash, width) {
  if (!HEX.test(hash || '') || !/^\d{1,4}$/.test(String(width))) throw blogError('BLOG_MEDIA_NOT_FOUND', 404);
  const row = await db.prepare("SELECT manifest_json FROM blog_media WHERE hash=? AND state='ready'").bind(hash).first();
  const item = row && JSON.parse(row.manifest_json).find(item => item.width === Number(width));
  if (!item) throw blogError('BLOG_MEDIA_NOT_FOUND', 404);
  const object = await bucket.get(pathFor(hash, item.width));
  if (!correctHead(object, item)) throw blogError('BLOG_MEDIA_NOT_FOUND', 404);
  // Preview is authenticated: NEVER public-cache draft media on Vercel.
  return new Response(object.body, { headers: { 'content-type': 'image/webp', 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store' } });
}
