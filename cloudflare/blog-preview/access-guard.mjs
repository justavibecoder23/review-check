// The SAME predicate must gate every content/media/publish commit, not merely
// the beginning of an HTTP request. Its two placeholders are actorId, adminOnly.
export const BLOG_READ_AUTH_SQL = `
  EXISTS (SELECT 1 FROM blog_access_grants
    WHERE actor_id = ? AND active = 1 AND (role = 'admin' OR (? = 0 AND role = 'editor'))
      AND starts_at <= CAST(strftime('%s','now') AS INTEGER)
      AND (expires_at IS NULL OR expires_at > CAST(strftime('%s','now') AS INTEGER)))
`;
export const BLOG_WRITE_AUTH_SQL = `${BLOG_READ_AUTH_SQL}
  AND EXISTS (SELECT 1 FROM blog_migration_settings
    WHERE setting = 'studio_read_only' AND value = 'false')
`;

function denial(code, statusCode) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

export async function assertBlogWriteAccess(db, actorId, { adminOnly = false, write = true } = {}) {
  const row = await db.prepare(`SELECT
    ${BLOG_READ_AUTH_SQL} AS granted,
    EXISTS(SELECT 1 FROM blog_migration_settings
      WHERE setting = 'studio_read_only' AND value = 'false') AS writable
  `).bind(actorId, adminOnly ? 1 : 0).first();
  if (!row?.granted) throw denial('BLOG_ACCESS_DENIED', 403);
  if (write && !row.writable) throw denial('BLOG_READ_ONLY', 503);
  return row;
}

// Call ONLY after verifyBlogRequest has authenticated the body and timestamp.
// A duplicate envelope is rejected even if its idempotency key is valid.
// A retry signs a NEW requestId while reusing its logical idempotency key.
export async function consumeBlogRequest(db, envelope, { environment, adminOnly = false, write = true, now = Date.now() }) {
  if (!['preview', 'production'].includes(environment)) throw denial('BLOG_AUTH_INVALID', 401);
  if (typeof envelope?.actorId !== 'string' || typeof envelope?.requestId !== 'string'
    || !Number.isSafeInteger(envelope.timestamp)) throw denial('BLOG_AUTH_INVALID', 401);
  const acceptedAt = Math.floor(now / 1000);
  if (!Number.isSafeInteger(acceptedAt) || acceptedAt - envelope.timestamp > 300 || envelope.timestamp - acceptedAt > 30) {
    throw denial('BLOG_AUTH_EXPIRED', 401);
  }
  // Atomic identity/role/read-only check + replay reservation in ONE statement.
  const result = await db.prepare(`INSERT INTO blog_request_replays
    (environment, request_id, actor_id, accepted_at, expires_at)
    SELECT ?, ?, ?, ?, ? WHERE ${write ? BLOG_WRITE_AUTH_SQL : BLOG_READ_AUTH_SQL}
    ON CONFLICT(environment, request_id) DO NOTHING
  `).bind(environment, envelope.requestId, envelope.actorId, acceptedAt, envelope.timestamp + 301,
    envelope.actorId, adminOnly ? 1 : 0).run();
  if (result.meta?.changes === 1) return;
  // This diagnosis is not authorization for a later write. Commit must re-check.
  await assertBlogWriteAccess(db, envelope.actorId, { adminOnly, write });
  throw denial('BLOG_AUTH_REPLAY', 409);
}
