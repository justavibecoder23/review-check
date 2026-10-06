import { BLOG_WRITE_AUTH_SQL, assertBlogWriteAccess } from './access-guard.mjs';
import { blogError, postId, readDraft, saveDraft, draftView, savedResponse } from './draft-store.mjs';
import { blogBodyHash } from './request-auth.mjs';

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function validSlug(slug) {
  if (!slugPattern.test(slug || '') || slug.length > 160) throw blogError('BLOG_POST_NOT_FOUND', 404);
  return slug;
}
export async function publicPost(db, slug) {
  validSlug(slug);
  const row = await db.prepare(`SELECT s.tombstone,p.* FROM blog_slugs s
    LEFT JOIN blog_published p ON p.slug=s.slug WHERE s.slug=?`).bind(slug).first();
  if (row?.tombstone) return { kind: 'gone' };
  if (!row?.html) return { kind: 'snapshot' };
  // Recheck the authoritative pointer AFTER loading the body.
  const current = await db.prepare('SELECT generation FROM blog_published WHERE slug=?').bind(slug).first();
  if (current?.generation !== row.generation) throw blogError('BLOG_PUBLIC_RETRY', 503);
  return { kind:'published', html:row.html, revision:row.revision, generation:row.generation };
}
export async function listProductionPosts(db, { publicOnly = false } = {}) {
  const drafts = (await db.prepare('SELECT * FROM blog_drafts ORDER BY updated_at DESC LIMIT 500').all()).results;
  const legacy = (await db.prepare(`SELECT a.*,s.tombstone FROM blog_legacy_articles a
    JOIN blog_slugs s ON s.slug=a.slug`).all()).results;
  const published = (await db.prepare('SELECT * FROM blog_published').all()).results;
  const map = new Map(legacy.filter(r => !r.tombstone).map(r => [r.slug,
    { ...JSON.parse(r.summary_json), id:`static:${r.slug}`, status:'published', revision:0,
      legacySnapshot:true, managedSlugs:[r.slug] }]));
  if (publicOnly) {
    for (const row of published) map.set(row.slug, { ...JSON.parse(row.body_json), id:row.post_id,
      status:'published', publishedAt:row.published_at, updatedAt:row.updated_at, managedSlugs:[row.slug] });
  } else {
    for (const row of drafts) map.set(row.slug, draftView(row).meta);
  }
  return [...map.values()];
}

async function prior(db, e, operation) {
  const row = await db.prepare(`SELECT * FROM blog_idempotency WHERE environment=? AND actor_id=?
    AND operation=? AND idempotency_key=?`).bind(e.environment,e.actorId,operation,e.idempotencyKey).first();
  if (!row) return null;
  if (row.body_sha256 !== e.bodyHash) throw blogError('BLOG_IDEMPOTENCY_CONFLICT',409);
  return JSON.parse(row.response_json);
}
function receipt(db,e,operation,result) {
  return db.prepare("INSERT INTO blog_idempotency VALUES (?,?,?,?,?,'complete',?,?,?)")
    .bind(e.environment,e.actorId,operation,e.idempotencyKey,e.bodyHash,JSON.stringify(result),Date.now(),Date.now()+7*86400000);
}
async function commit(db,statements,e,operation,result) {
  try { await db.batch([...statements,receipt(db,e,operation,result),
    db.prepare('INSERT INTO blog_mutation_audit VALUES (?,?,?,?,?,?)')
      .bind(e.requestId,e.actorId,operation,result.id,e.bodyHash,new Date().toISOString())]); }
  catch {
    await assertBlogWriteAccess(db,e.actorId);
    const saved = await prior(db,e,operation); if (saved) return saved;
    throw blogError('BLOG_REVISION_CONFLICT',409);
  }
  return result;
}
export async function importLegacy(db,input,e) {
  await assertBlogWriteAccess(db,e.actorId);
  e={...e,bodyHash:await blogBodyHash(new TextEncoder().encode(JSON.stringify({post:input.post,sourceHash:input.sourceHash})))};
  const cached = await prior(db,e,'import_legacy'); if (cached) return cached;
  validSlug(input.post?.slug);
  const legacy = await db.prepare('SELECT * FROM blog_legacy_articles WHERE slug=?').bind(input.post.slug).first();
  if (!legacy || legacy.html_sha256 !== input.sourceHash) throw blogError('BLOG_IMPORT_SOURCE_MISMATCH',409);
  const owned = await db.prepare('SELECT * FROM blog_slugs WHERE slug=?').bind(input.post.slug).first();
  if (owned?.ownership === 'studio') {
    const current=await readDraft(db,owned.owner_id);
    throw blogError('BLOG_REVISION_CONFLICT',409,{currentRevision:current.revision});
  }
  const body = JSON.stringify(input.post);
  if (new TextEncoder().encode(body).length > 750000 || !Array.isArray(input.post.blocks)) throw blogError('INVALID_BLOG_POST',400);
  const id = crypto.randomUUID(),at = new Date().toISOString(),token = crypto.randomUUID();
  const sha = await blogBodyHash(new TextEncoder().encode(body));
  const result = { id, revision:1, post:{...input.post,id,revision:1,status:'published'},
    meta:{id,slug:input.post.slug,status:'published',revision:1,publishedRevision:0,hasUnpublishedChanges:true} };
  return commit(db,[
    db.prepare(`INSERT INTO blog_commit_checks SELECT ?,CASE WHEN ${BLOG_WRITE_AUTH_SQL}
      AND EXISTS(SELECT 1 FROM blog_slugs WHERE slug=? AND ownership IN ('static','snapshot') AND tombstone=0)
      THEN 1 ELSE 0 END`).bind(token,e.actorId,0,input.post.slug),
    db.prepare(`INSERT INTO blog_drafts(id,slug,title,category,revision,body_json,body_sha256,created_at,updated_at,created_by,status,published_at)
      VALUES (?,?,?,?,1,?,?,?,?,?,'published',?)`).bind(id,input.post.slug,input.post.title,input.post.category||'doc-review',body,sha,at,at,e.actorId,JSON.parse(legacy.summary_json).publishedAt||at),
    db.prepare('INSERT INTO blog_revisions VALUES (?,1,?,?,?,?)').bind(id,body,sha,at,e.actorId),
    db.prepare("UPDATE blog_slugs SET ownership='studio',owner_id=? WHERE slug=?").bind(id,input.post.slug),
    db.prepare('DELETE FROM blog_commit_checks WHERE token=?').bind(token)
  ],e,'import_legacy',result);
}

export async function changePublication(db,input,e) {
  await assertBlogWriteAccess(db,e.actorId);
  const operation = input.action;
  // Server-rendered HTML may contain a different publication timestamp on a
  // transport retry. The immutable revision + action is the logical mutation.
  e={...e,bodyHash:await blogBodyHash(new TextEncoder().encode(JSON.stringify({operation,id:input.id,revision:input.expectedRevision})))};
  const cached = await prior(db,e,operation); if (cached) return cached;
  postId(input.id);
  const draft = await db.prepare('SELECT * FROM blog_drafts WHERE id=?').bind(input.id).first();
  if (!draft || draft.revision !== input.expectedRevision) throw blogError('BLOG_REVISION_CONFLICT',409);
  const post = JSON.parse(draft.body_json),at = new Date().toISOString(),token = crypto.randomUUID();
  const statements = [db.prepare(`INSERT INTO blog_commit_checks SELECT ?,CASE WHEN ${BLOG_WRITE_AUTH_SQL}
    AND EXISTS(SELECT 1 FROM blog_drafts WHERE id=? AND revision=?) THEN 1 ELSE 0 END`)
    .bind(token,e.actorId,0,input.id,input.expectedRevision)];
  const result = { id:input.id,revision:draft.revision,slug:draft.slug,
    post:{...post,id:input.id,revision:draft.revision,status:operation==='publish'?'published':operation==='archive'?'archived':'draft'},
    meta:{id:input.id,slug:draft.slug,revision:draft.revision,status:operation==='publish'?'published':operation==='archive'?'archived':'draft'} };
  if (operation === 'publish') {
    const registry = await db.prepare('SELECT tombstone FROM blog_slugs WHERE slug=?').bind(draft.slug).first();
    if (registry?.tombstone) {
      await assertBlogWriteAccess(db,e.actorId,{adminOnly:true});
      const adminCheck=crypto.randomUUID();
      statements.push(db.prepare(`INSERT INTO blog_commit_checks SELECT ?,CASE WHEN ${BLOG_WRITE_AUTH_SQL} THEN 1 ELSE 0 END`).bind(adminCheck,e.actorId,1));
      statements.push(db.prepare('DELETE FROM blog_commit_checks WHERE token=?').bind(adminCheck));
    }
    if (typeof input.html !== 'string' || input.html.length > 1500000) throw blogError('INVALID_BLOG_POST',400);
    if (input.documentHash !== draft.body_sha256) throw blogError('BLOG_REVISION_CONFLICT',409);
    statements.push(db.prepare(`INSERT INTO blog_published VALUES (?,?,?,1,?,?,?,?)
      ON CONFLICT(slug) DO UPDATE SET revision=excluded.revision,generation=blog_published.generation+1,
      body_json=excluded.body_json,html=excluded.html,updated_at=excluded.updated_at`)
      .bind(draft.slug,input.id,draft.revision,draft.body_json,input.html,draft.published_at||at,at));
    statements.push(db.prepare("UPDATE blog_slugs SET tombstone=0 WHERE slug=? AND owner_id=?").bind(draft.slug,input.id));
    statements.push(db.prepare("UPDATE blog_drafts SET status='published',published_revision=revision,published_at=COALESCE(published_at,?),updated_at=? WHERE id=?").bind(at,at,input.id));
    statements.push(db.prepare('DELETE FROM blog_public_media WHERE slug=?').bind(draft.slug));
    const hashes = [...new Set([...draft.body_json.matchAll(/route=cloudflare-media&hash=([a-f0-9]{64})/g)].map(m=>m[1]))];
    for (const hash of hashes) {
      const check=crypto.randomUUID();
      statements.push(db.prepare(`INSERT INTO blog_commit_checks SELECT ?,CASE WHEN
        EXISTS(SELECT 1 FROM blog_media WHERE hash=? AND state='ready') THEN 1 ELSE 0 END`).bind(check,hash));
      statements.push(db.prepare(`INSERT INTO blog_public_media SELECT ?,hash FROM blog_media WHERE hash=? AND state='ready'`).bind(draft.slug,hash));
      statements.push(db.prepare('DELETE FROM blog_commit_checks WHERE token=?').bind(check));
    }
    result.meta.publishedRevision=draft.revision; result.meta.hasUnpublishedChanges=false;
  } else if (['unpublish','archive'].includes(operation)) {
    statements.push(db.prepare('DELETE FROM blog_published WHERE post_id=?').bind(input.id));
    statements.push(db.prepare('DELETE FROM blog_public_media WHERE slug=?').bind(draft.slug));
    statements.push(db.prepare('UPDATE blog_slugs SET tombstone=1 WHERE slug=? AND owner_id=?').bind(draft.slug,input.id));
    statements.push(db.prepare('UPDATE blog_drafts SET status=?,published_revision=0,updated_at=? WHERE id=?').bind(operation==='archive'?'archived':'draft',at,input.id));
  } else throw blogError('INVALID_BLOG_ACTION',400);
  statements.push(db.prepare('DELETE FROM blog_commit_checks WHERE token=?').bind(token));
  return commit(db,statements,e,operation,result);
}
export async function restoreDraft(db,input,e) {
  await assertBlogWriteAccess(db,e.actorId);
  const cached=await savedResponse(db,e.actorId,e.idempotencyKey,e.bodyHash,e.environment);
  if(cached)return cached;
  const current = await readDraft(db,input.id);
  if (current.revision !== input.expectedRevision) throw blogError('BLOG_REVISION_CONFLICT',409);
  const revision = input.action==='discard_draft' ? current.meta.publishedRevision : input.revisionToRestore;
  if (!revision) throw blogError('BLOG_LEGACY_REVISION_UNAVAILABLE',409);
  const source = await readDraft(db,input.id,revision);
  return saveDraft(db,{id:input.id,expectedRevision:input.expectedRevision,post:source.post},e);
}

export async function manageGrants(db,input,e) {
  await assertBlogWriteAccess(db,e.actorId,{adminOnly:true,write:input.action!=='list'});
  if (input.action==='list') {
    const rows = (await db.prepare('SELECT * FROM blog_access_grants LIMIT 500').all()).results;
    return { role:'admin',entries:rows.map(r=>({actorId:r.actor_id,email:r.email,role:r.role,
      startsAt:new Date(r.starts_at*1000).toISOString(),expiresAt:r.expires_at?new Date(r.expires_at*1000).toISOString():null,
      status:!r.active?'revoked':r.starts_at>Date.now()/1000?'scheduled':r.expires_at&&r.expires_at<=Date.now()/1000?'expired':'active'})),
      audit:(await db.prepare('SELECT * FROM blog_access_audit ORDER BY created_at DESC LIMIT 50').all()).results };
  }
  postId(input.actorId);
  if (!['admin','editor'].includes(input.role) || !Number.isSafeInteger(input.startsAt)
    || (input.expiresAt!==null && (!Number.isSafeInteger(input.expiresAt)||input.expiresAt<=input.startsAt))) throw blogError('INVALID_ACCESS_DATE',400);
  const token = crypto.randomUUID();
  // Never allow removing the last currently-active admin, including self-revoke.
  await db.batch([
    db.prepare(`INSERT INTO blog_commit_checks SELECT ?,CASE WHEN ${BLOG_WRITE_AUTH_SQL}
      AND (?='admin' AND ?=1 AND ?<=CAST(strftime('%s','now') AS INTEGER) AND (? IS NULL OR ?>CAST(strftime('%s','now') AS INTEGER))
      OR (${BLOG_WRITE_AUTH_SQL} AND EXISTS(SELECT 1 FROM blog_access_grants WHERE actor_id<>? AND role='admin'
        AND active=1 AND starts_at<=CAST(strftime('%s','now') AS INTEGER) AND (expires_at IS NULL OR expires_at>CAST(strftime('%s','now') AS INTEGER))))
      THEN 1 ELSE 0 END`).bind(token,e.actorId,1,input.role,input.active?1:0,input.startsAt,input.expiresAt,input.expiresAt,e.actorId,1,input.actorId),
    db.prepare(`INSERT INTO blog_access_grants(actor_id,role,active,updated_at,starts_at,expires_at,email,display_name)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(actor_id) DO UPDATE SET role=excluded.role,active=excluded.active,
      updated_at=excluded.updated_at,starts_at=excluded.starts_at,expires_at=excluded.expires_at,email=excluded.email,display_name=excluded.display_name`)
      .bind(input.actorId,input.role,input.active?1:0,Date.now(),input.startsAt,input.expiresAt,input.email,input.displayName||''),
    db.prepare('INSERT INTO blog_access_audit VALUES (?,?,?,?,?)').bind(crypto.randomUUID(),e.actorId,input.actorId,input.active?'grant':'revoke',new Date().toISOString()),
    db.prepare('DELETE FROM blog_commit_checks WHERE token=?').bind(token)
  ]);
  return { entry:{email:input.email,role:input.role,status:input.active?'active':'revoked'} };
}
