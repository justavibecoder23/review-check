import { blogError } from './draft-store.mjs';

const seconds = () => Math.floor(Date.now() / 1000);
const RETENTION = 30 * 86400;
// Only authenticated mutations get durable rows. No body, email, session,
// secret or draft text is copied into the audit sink.
export async function beginOperationAudit(db, envelope, operation) {
  const now = seconds();
  try {
    const row = await db.prepare(`INSERT INTO blog_operation_audit
      (request_id,actor_id,operation,body_sha256,state,started_at,expires_at)
      VALUES (?,?,?,?,'started',?,?)`).bind(envelope.requestId, envelope.actorId,
        operation, envelope.bodyHash, now, now + RETENTION).run();
    if (row.meta?.changes !== 1) throw new Error('audit not persisted');
  } catch { throw blogError('BLOG_AUDIT_UNAVAILABLE', 503); }
  let ordinal = 0;
  const ordinals = new Map();
  return {
    async event(fields) {
      try {
        if (fields.event === 'put_attempted') {
          const index = ++ordinal;
          const result = await db.prepare(`INSERT INTO blog_media_put_audit
            (request_id,ordinal,pathname,byte_length,state,attempted_at)
            VALUES (?,?,?,?,'attempted',?)`).bind(envelope.requestId, index,
              fields.pathname, fields.bytes, seconds()).run();
          if (result.meta?.changes !== 1) throw new Error('audit not persisted');
          ordinals.set(fields.pathname, index);
        } else {
          const state = { put_confirmed:'confirmed', put_condition_not_met:'condition-not-met', put_outcome_unknown:'unknown' }[fields.event];
          const index = ordinals.get(fields.pathname);
          if (!state || !index) throw new Error('audit event invalid');
          const result = await db.prepare(`UPDATE blog_media_put_audit SET state=?,completed_at=?
            WHERE request_id=? AND ordinal=? AND state='attempted'`)
            .bind(state, seconds(), envelope.requestId, index).run();
          if (result.meta?.changes !== 1) throw new Error('audit event not persisted');
        }
      } catch { throw blogError('BLOG_AUDIT_UNAVAILABLE', 503); }
    },
    async finish(status, code, metrics) {
      try {
        const result = await db.prepare(`UPDATE blog_operation_audit
          SET state='finished',finished_at=?,status=?,error_code=?,metrics_json=?
          WHERE request_id=? AND state='started'`)
          .bind(seconds(), status, code || null, JSON.stringify(metrics), envelope.requestId).run();
        if (result.meta?.changes !== 1) throw new Error('audit finish not persisted');
      } catch { throw blogError('BLOG_AUDIT_UNAVAILABLE', 503); }
    }
  };
}

// Bounded, indexed cleanup. Epoch units differ: legacy idempotency uses ms.
// Never delete content, grants, pending media, fencing state or legacy locators.
export async function maintainBlogPreview(db, { now = Date.now() } = {}) {
  const sec = Math.floor(now / 1000);
  const tables = [['blog_request_replays',sec,500],['blog_idempotency',now,500],['blog_operation_audit',sec,200]];
  const result = { completedAt:sec, deleted:{}, backlogCapped:{}, warning:false };
  for (const [table, cutoff, limit] of tables) {
    const deleted = await db.prepare(`DELETE FROM ${table} WHERE rowid IN
      (SELECT rowid FROM ${table} WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)`)
      .bind(cutoff, limit).run();
    result.deleted[table] = deleted.meta?.changes || 0;
    const remaining = await db.prepare(`SELECT COUNT(*) AS n FROM
      (SELECT 1 FROM ${table} WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)`)
      .bind(cutoff, limit + 1).first();
    result.backlogCapped[table] = remaining.n;
    if (remaining.n) result.warning = true;
  }
  await db.prepare(`INSERT INTO blog_migration_settings(setting,value) VALUES ('maintenance_status',?)
    ON CONFLICT(setting) DO UPDATE SET value=excluded.value`).bind(JSON.stringify(result)).run();
  return result;
}

export async function readMaintenanceStatus(db) {
  const row = await db.prepare("SELECT value FROM blog_migration_settings WHERE setting='maintenance_status'").first();
  let state = null;
  try { state = JSON.parse(row?.value || 'null'); } catch { /* fail closed status */ }
  return { ...state, stale: !state?.completedAt || seconds() - state.completedAt > 3 * 3600 };
}
