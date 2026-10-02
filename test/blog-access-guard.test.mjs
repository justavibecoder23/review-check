import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { BLOG_WRITE_AUTH_SQL, consumeBlogRequest } from '../cloudflare/blog-preview/access-guard.mjs';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of ['0001_preview_inventory.sql', '0002_preview_security.sql', '0003_grant_validity.sql']) {
    sqlite.exec(readFileSync(new URL(`../cloudflare/blog-preview/migrations/${name}`, import.meta.url), 'utf8'));
  }
  // Adapter models D1 prepared queries, but does NOT claim remote D1 runtime testing.
  const db = { prepare(sql) {
    return { bind(...values) { return {
      async first() { return sqlite.prepare(sql).get(...values); },
      async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }; }
    }; } };
  } };
  const envelope = { actorId: 'stable-account-123', requestId: 'request-000000001', timestamp: 1790902800 };
  const options = { environment: 'preview', now: envelope.timestamp * 1000 };
  function enable(role = 'editor') {
    sqlite.prepare('INSERT INTO blog_access_grants(actor_id,role,active,updated_at) VALUES (?, ?, 1, ?)').run(envelope.actorId, role, envelope.timestamp);
    sqlite.exec("UPDATE blog_migration_settings SET value='false' WHERE setting='studio_read_only'");
  }
  return { sqlite, db, envelope, options, enable };
}

test('migration defaults deny all writes, does not activate old grants and requires authoritative read-only flag', async () => {
  const f = fixture();
  try {
    await assert.rejects(consumeBlogRequest(f.db, f.envelope, f.options), { code: 'BLOG_ACCESS_DENIED' });
    f.enable();
    f.sqlite.exec("UPDATE blog_migration_settings SET value='true'");
    await assert.rejects(consumeBlogRequest(f.db, f.envelope, f.options), { code: 'BLOG_READ_ONLY' });
    f.sqlite.exec('DELETE FROM blog_migration_settings');
    await assert.rejects(consumeBlogRequest(f.db, f.envelope, f.options), { code: 'BLOG_READ_ONLY' });
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM blog_request_replays').get().n, 0);
  } finally { f.sqlite.close(); }
});

test('concurrent duplicate envelopes have exactly one replay reservation, retry needs a new request ID', async () => {
  const f = fixture();
  try {
    f.enable();
    const results = await Promise.allSettled([consumeBlogRequest(f.db, f.envelope, f.options), consumeBlogRequest(f.db, f.envelope, f.options)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'BLOG_AUTH_REPLAY');
    await consumeBlogRequest(f.db, { ...f.envelope, requestId: 'request-000000002' }, f.options);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM blog_request_replays').get().n, 2);
  } finally { f.sqlite.close(); }
});

test('editor cannot pass an admin route and revoked grant cannot reserve a request', async () => {
  const f = fixture();
  try {
    f.enable();
    await assert.rejects(consumeBlogRequest(f.db, f.envelope, { ...f.options, adminOnly: true }), { code: 'BLOG_ACCESS_DENIED' });
    f.sqlite.exec('UPDATE blog_access_grants SET active=0');
    await assert.rejects(consumeBlogRequest(f.db, f.envelope, f.options), { code: 'BLOG_ACCESS_DENIED' });
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM blog_request_replays').get().n, 0);
  } finally { f.sqlite.close(); }
});

test('grant revoked between request acceptance and content commit produces zero content writes', async () => {
  const f = fixture();
  try {
    f.enable();
    await consumeBlogRequest(f.db, f.envelope, f.options);
    f.sqlite.exec('CREATE TABLE test_content (id TEXT PRIMARY KEY, body TEXT)');
    f.sqlite.exec('UPDATE blog_access_grants SET active=0');
    const result = f.sqlite.prepare(`INSERT INTO test_content SELECT ?, ? WHERE ${BLOG_WRITE_AUTH_SQL}`)
      .run('fixture', 'new body', f.envelope.actorId, 0);
    assert.equal(result.changes, 0);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM test_content').get().n, 0);
  } finally { f.sqlite.close(); }
});

test('read-only switched on during processing blocks commit; fresh requests expire instead of reserving', async () => {
  const f = fixture();
  try {
    f.enable('admin');
    await consumeBlogRequest(f.db, f.envelope, { ...f.options, adminOnly: true });
    f.sqlite.exec("CREATE TABLE test_content (id TEXT); UPDATE blog_migration_settings SET value='true'");
    assert.equal(f.sqlite.prepare(`INSERT INTO test_content SELECT ? WHERE ${BLOG_WRITE_AUTH_SQL}`)
      .run('fixture', f.envelope.actorId, 1).changes, 0);
    await assert.rejects(consumeBlogRequest(f.db, { ...f.envelope, requestId: 'request-000000003' }, {
      ...f.options, now: f.options.now + 301_000
    }), { code: 'BLOG_AUTH_EXPIRED' });
  } finally { f.sqlite.close(); }
});

test('scheduled or expired grant cannot authorize writes even with active=1', async () => {
  const f = fixture();
  try {
    f.enable();
    f.sqlite.exec("UPDATE blog_access_grants SET starts_at=CAST(strftime('%s','now') AS INTEGER)+600");
    await assert.rejects(consumeBlogRequest(f.db, f.envelope, f.options), { code: 'BLOG_ACCESS_DENIED' });
    f.sqlite.exec("UPDATE blog_access_grants SET starts_at=0, expires_at=CAST(strftime('%s','now') AS INTEGER)-1");
    await assert.rejects(consumeBlogRequest(f.db, f.envelope, f.options), { code: 'BLOG_ACCESS_DENIED' });
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM blog_request_replays').get().n, 0);
  } finally { f.sqlite.close(); }
});
