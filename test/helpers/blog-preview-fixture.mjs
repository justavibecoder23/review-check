import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

export function previewFixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  const directory = new URL('../../cloudflare/blog-preview/migrations/', import.meta.url);
  for (const file of readdirSync(directory).filter(file => file.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(file, directory), 'utf8'));
  }
  const hooks = {};
  const commands = [];
  function statement(sql, values = []) {
    return { sql, values,
      bind(...bound) { return statement(sql, bound); },
      async first() { commands.push(sql); return sqlite.prepare(sql).get(...values) || null; },
      async all() { commands.push(sql); return { results: sqlite.prepare(sql).all(...values) }; },
      async run() {
        await hooks.beforeRun?.(sql, values);
        commands.push(sql);
        return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } };
      }
    };
  }
  const db = { prepare: statement, async batch(statements) {
    await hooks.beforeBatch?.();
    sqlite.exec('BEGIN');
    let results;
    try {
      results = statements.map(item => {
        commands.push(item.sql);
        return { meta: { changes: Number(sqlite.prepare(item.sql).run(...item.values).changes) } };
      });
      sqlite.exec('COMMIT');
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    await hooks.afterCommit?.();
    return results;
  } };
  const actorId = 'test-preview-actor';
  function enable() {
    sqlite.prepare('INSERT INTO blog_access_grants(actor_id,role,active,updated_at) VALUES (?, ?, 1, 0)').run(actorId, 'editor');
    sqlite.exec("UPDATE blog_migration_settings SET value='false' WHERE setting='studio_read_only'");
  }
  const objects = new Map();
  const counts = { put: 0, head: 0, get: 0 };
  const bucket = {
    async put(key, bytes, options) {
      counts.put++;
      await hooks.beforePut?.(key);
      if (options.onlyIf?.get('if-none-match') !== '*') throw new Error('immutable condition missing');
      if (objects.has(key)) return null;
      const object = { size: bytes.length, httpMetadata: options.httpMetadata, customMetadata: options.customMetadata,
        body: new Uint8Array(bytes) };
      objects.set(key, object);
      await hooks.afterPut?.(key);
      return object;
    },
    async head(key) { counts.head++; return objects.get(key) || null; },
    async get(key) { counts.get++; return objects.get(key) || null; }
  };
  return { db, sqlite, hooks, commands, actorId, enable, bucket, objects, counts,
    count(table) { return sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; },
    close() { sqlite.close(); }
  };
}
