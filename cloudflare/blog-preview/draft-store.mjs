import { BLOG_WRITE_AUTH_SQL, assertBlogWriteAccess } from './access-guard.mjs';
import { blogBodyHash } from './request-auth.mjs';

export function blogError(code, statusCode, extra = {}) {
  return Object.assign(new Error(code), { code, statusCode, ...extra });
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function postId(value) {
  if (!UUID.test(String(value || ''))) throw blogError('BLOG_POST_ID_REQUIRED', 400);
  return value;
}
function view(row) {
  const post = JSON.parse(row.body_json);
  const meta = { id: row.id, slug: row.slug, title: row.title, category: row.category,
    revision: row.revision, publishedRevision: 0, status: 'draft', hasUnpublishedChanges: true,
    createdAt: row.created_at, updatedAt: row.updated_at };
  return { id: row.id, revision: row.revision, post: { ...post, ...meta }, meta };
}
export async function readDraft(db, id, revision) {
  postId(id);
  const row = await db.prepare('SELECT * FROM blog_drafts WHERE id=?').bind(id).first();
  if (!row) throw blogError('BLOG_POST_NOT_FOUND', 404);
  if (revision != null) {
    const r = await db.prepare('SELECT * FROM blog_revisions WHERE post_id=? AND revision=?').bind(id, Number(revision)).first();
    if (!r) throw blogError('BLOG_REVISION_NOT_FOUND', 404);
    return view({ ...row, body_json: r.body_json, revision: r.revision });
  }
  return view(row);
}
async function savedResponse(db, actor, key, hash) {
  const row = await db.prepare("SELECT body_sha256,state,response_json FROM blog_idempotency WHERE environment='preview' AND actor_id=? AND operation='save' AND idempotency_key=?")
    .bind(actor, key).first();
  if (!row) return null;
  if (row.body_sha256 !== hash) throw blogError('BLOG_IDEMPOTENCY_CONFLICT', 409);
  if (row.state !== 'complete') throw blogError('BLOG_SAVE_RETRY', 503);
  return JSON.parse(row.response_json);
}
export async function saveDraft(db, input, envelope) {
  await assertBlogWriteAccess(db, envelope.actorId);
  const prior = await savedResponse(db, envelope.actorId, envelope.idempotencyKey, envelope.bodyHash);
  if (prior) return prior;
  const post = input.post;
  const body = JSON.stringify(post);
  if (!post || typeof post !== 'object' || Array.isArray(post) || !String(post.title || '').trim()
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(post.slug || '') || post.slug.length > 160
    || !Array.isArray(post.blocks) || new TextEncoder().encode(body).length > 750_000) {
    throw blogError('INVALID_BLOG_POST', 400);
  }
  const id = input.id ? postId(input.id) : crypto.randomUUID();
  const expected = Number(input.expectedRevision || 0);
  if (!Number.isSafeInteger(expected) || expected < 0 || (!input.id && expected !== 0)) throw blogError('BLOG_REVISION_CONFLICT', 409);
  const revision = expected + 1;
  const timestamp = new Date().toISOString();
  const digest = await blogBodyHash(new TextEncoder().encode(body));
  const token = crypto.randomUUID();
  const existing = input.id ? await db.prepare('SELECT created_at,created_by FROM blog_drafts WHERE id=?').bind(id).first() : null;
  if (input.id && !existing) throw blogError('BLOG_REVISION_CONFLICT', 409, { currentRevision: 0 });
  const result = view({ id, slug: post.slug, title: post.title, category: post.category || 'doc-review', revision,
    body_json: body, created_at: existing?.created_at || timestamp, updated_at: timestamp });
  const statements = [
    db.prepare(`INSERT INTO blog_commit_checks SELECT ?, CASE WHEN ${BLOG_WRITE_AUTH_SQL}
      AND ((?=0 AND NOT EXISTS(SELECT 1 FROM blog_drafts WHERE id=?)) OR
           (? > 0 AND EXISTS(SELECT 1 FROM blog_drafts WHERE id=? AND revision=?)))
      AND NOT EXISTS(SELECT 1 FROM blog_slugs WHERE slug=? AND (ownership <> 'studio' OR owner_id <> ? OR tombstone=1))
      THEN 1 ELSE 0 END`).bind(token, envelope.actorId, 0, expected, id, expected, id, expected, post.slug, id),
    db.prepare("INSERT INTO blog_idempotency VALUES ('preview',?,'save',?,?,'complete',?,?,?)")
      .bind(envelope.actorId, envelope.idempotencyKey, envelope.bodyHash, JSON.stringify(result), Date.now(), Date.now() + 7 * 86400000),
    db.prepare("INSERT INTO blog_slugs VALUES (?,'studio',?,0) ON CONFLICT(slug) DO NOTHING").bind(post.slug, id),
    db.prepare(`INSERT INTO blog_drafts VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      slug=excluded.slug,title=excluded.title,category=excluded.category,revision=excluded.revision,
      body_json=excluded.body_json,body_sha256=excluded.body_sha256,updated_at=excluded.updated_at`)
      .bind(id, post.slug, post.title, post.category || 'doc-review', revision, body, digest,
        existing?.created_at || timestamp, timestamp, existing?.created_by || envelope.actorId),
    db.prepare('INSERT INTO blog_revisions VALUES (?,?,?,?,?,?)').bind(id, revision, body, digest, timestamp, envelope.actorId),
    db.prepare('DELETE FROM blog_commit_checks WHERE token=?').bind(token)
  ];
  try { await db.batch(statements); }
  catch {
    // Includes ambiguous transport failure: read the committed idempotency result
    // before ever retrying a batch or inventing another revision.
    await assertBlogWriteAccess(db, envelope.actorId);
    const committed = await savedResponse(db, envelope.actorId, envelope.idempotencyKey, envelope.bodyHash);
    if (committed) return committed;
    const owner = await db.prepare('SELECT * FROM blog_slugs WHERE slug=?').bind(post.slug).first();
    if (owner && (owner.ownership !== 'studio' || owner.owner_id !== id || owner.tombstone)) throw blogError('BLOG_SLUG_CONFLICT', 409);
    const current = await db.prepare('SELECT revision FROM blog_drafts WHERE id=?').bind(id).first();
    if ((current?.revision || 0) !== expected || (input.id && !current)) {
      throw blogError('BLOG_REVISION_CONFLICT', 409, { currentRevision: current?.revision || 0 });
    }
    throw blogError('BLOG_SAVE_RETRY', 503);
  }
  return result;
}
export async function listDrafts(db) {
  const rows = await db.prepare('SELECT * FROM blog_drafts ORDER BY updated_at DESC,id LIMIT 100').all();
  return rows.results.map(row => view(row).meta);
}
