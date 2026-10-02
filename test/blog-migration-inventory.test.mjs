import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, privateDecrypt, createDecipheriv, constants } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { inventoryRedis, previewSql, encryptBackup, hash } from '../tools/blog-migration-inventory.mjs';

test('inventory uses only indexed read commands and reports inaccessible Blob bodies without fetching them', async () => {
  const calls = [];
  const prefix = 'realview:blog:cms:v1';
  const meta = JSON.stringify({ slug: 'test', managedSlugs: ['test'] });
  const values = new Map([
    [`${prefix}:post:one:meta`, meta],
    [`${prefix}:post:one:revision:1`, JSON.stringify({ storage: 'vercel-blob-private', pathname: 'locked' })]
  ]);
  const result = await inventoryRedis(async command => {
    calls.push(command);
    if (command[0] === 'GET') return values.get(command[1]) || null;
    if (command[1] === `${prefix}:posts`) return command.includes('WITHSCORES') ? ['one', '1'] : ['one'];
    if (command[1] === `${prefix}:post:one:revisions`) return command.includes('WITHSCORES') ? ['1', '1'] : ['1'];
    return [];
  });
  assert.equal(result.summary.blockedBlobRevisions, 1);
  assert.equal(result.summary.inlineRevisions, 0);
  assert.equal(result.summary.observedStable, true);
  assert.ok(calls.every(command => ['GET', 'ZRANGE', 'ZREVRANGE', 'LRANGE'].includes(command[0])));
});

test('preview import is repeatable and reserves static/snapshot slugs without activating grants', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../cloudflare/blog-preview/migrations/0001_preview_inventory.sql', import.meta.url), 'utf8'));
  const files = [{ path: 'public/blog/test.html', sha256: 'a', bytes: 10, canonical: 'https://www.realview.com.vn/bai-viet/test' },
    { path: 'public/blog/snapshots/test.html', sha256: 'b', bytes: 20, canonical: 'https://www.realview.com.vn/bai-viet/test' }];
  const records = [{ key: 'private', type: 'string', raw: 'nháp có dấu và dấu nháy \u0027', sha256: 'c' }];
  const sql = previewSql(files, records);
  db.exec(sql); db.exec(sql);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM blog_import_files').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM blog_import_records').get().n, 1);
  assert.equal(db.prepare('SELECT ownership FROM blog_slugs WHERE slug=?').get('test').ownership, 'snapshot');
  assert.equal(db.prepare('SELECT value FROM blog_migration_settings').get().value, 'true');
  db.close();
});

test('encrypted backup roundtrips and refuses modified ciphertext', () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const payload = { objects: [{ path: 'image.webp', base64: Buffer.from('original bytes').toString('base64') }], records: ['private draft'] };
  const envelope = JSON.parse(encryptBackup(payload, pair.publicKey));
  const key = privateDecrypt({ key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(envelope.wrappedKey, 'base64'));
  function decrypt(data) {
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    cipher.setAAD(Buffer.from('realview-blog-backup-v1'));
    cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([cipher.update(data), cipher.final()]);
  }
  const data = Buffer.from(envelope.data, 'base64');
  assert.deepEqual(JSON.parse(decrypt(data)), payload);
  assert.equal(hash(Buffer.from(payload.objects[0].base64, 'base64')), hash(Buffer.from('original bytes')));
  data[0] ^= 1;
  assert.throws(() => decrypt(data));
});

test('legacy classification preserves raw pointer hashes, reserves archived aliases and never replaces snapshot ownership', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(readFileSync(new URL('../cloudflare/blog-preview/migrations/0001_preview_inventory.sql', import.meta.url), 'utf8'));
    const pointer = JSON.stringify({ storage: 'vercel-blob-private', pathname: 'unavailable' });
    const meta = JSON.stringify({ slug: 't', status: 'archived', managedSlugs: ['old-alias', 'existing-snapshot'] });
    db.exec(previewSql([{ path: 'public/blog/snapshots/existing-snapshot.html', sha256: 'x', bytes: 1,
      canonical: 'https://www.realview.com.vn/bai-viet/existing-snapshot' }], [
      { key: 'realview:blog:cms:v1:post:one:revision:1', type: 'string', raw: pointer, sha256: hash(JSON.stringify(pointer)) },
      { key: 'realview:blog:cms:v1:post:one:meta', type: 'string', raw: meta, sha256: hash(JSON.stringify(meta)) }
    ]));
    db.exec(readFileSync(new URL('../cloudflare/blog-preview/migrations/0004_legacy_registry.sql', import.meta.url), 'utf8'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM blog_legacy_state').get().n, 1);
    assert.equal(db.prepare('SELECT ownership FROM blog_slugs WHERE slug=?').get('t').ownership, 'legacy_reserved');
    assert.equal(db.prepare('SELECT ownership FROM blog_slugs WHERE slug=?').get('old-alias').ownership, 'legacy_reserved');
    assert.equal(db.prepare('SELECT ownership FROM blog_slugs WHERE slug=?').get('existing-snapshot').ownership, 'snapshot');
    const original = db.prepare('SELECT raw_json,sha256 FROM blog_import_records WHERE record_key=?')
      .get('realview:blog:cms:v1:post:one:revision:1');
    assert.equal(original.raw_json, JSON.stringify(pointer));
    assert.equal(hash(original.raw_json), original.sha256);
  } finally { db.close(); }
});
