import { readFile, writeFile } from 'node:fs/promises';
import { privateDecrypt, createDecipheriv, constants } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { hash, previewSql } from './blog-migration-inventory.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const i = arg.indexOf('='); return [arg.slice(2, i), arg.slice(i + 1)];
}));
const envelope = JSON.parse(await readFile(args.backup, 'utf8'));
if (envelope.version !== 1 || envelope.algorithm !== 'AES-256-GCM+RSA-OAEP-SHA256') throw new Error('BACKUP_FORMAT');
const key = privateDecrypt({ key: await readFile(args.key),
  padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(envelope.wrappedKey, 'base64'));
const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
decipher.setAAD(Buffer.from('realview-blog-backup-v1'));
decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
const payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]));
if (payload.objects.length !== payload.files.length) throw new Error('OBJECT_COUNT');
const manifest = new Map(payload.files.map(file => [file.path, file.sha256]));
for (const object of payload.objects) {
  if (hash(Buffer.from(object.base64, 'base64')) !== manifest.get(object.path)) throw new Error('OBJECT_HASH');
}
for (const record of payload.records) if (hash(JSON.stringify(record.raw)) !== record.sha256) throw new Error('RECORD_HASH');
if (args.sql) await writeFile(args.sql, previewSql(payload.files, payload.records, { transaction: false }), { mode: 0o600 });
let remoteVerified = false;
let remoteCounts = null;
if (args.wrangler) {
  const run = spawnSync(process.execPath, [args.wrangler, 'd1', 'execute', 'realview-blog-preview',
    '--config', 'cloudflare/blog-preview/wrangler.jsonc', '--remote', '--json', '--command',
    'SELECT record_key,raw_json,sha256 FROM blog_import_records; SELECT path,sha256,byte_length FROM blog_import_files; SELECT (SELECT COUNT(*) FROM blog_import_files) AS files,(SELECT COUNT(*) FROM blog_import_records) AS records,(SELECT COUNT(*) FROM blog_slugs) AS slugs,(SELECT COUNT(*) FROM blog_migration_settings) AS settings,(SELECT COUNT(*) FROM d1_migrations) AS migrations;'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (run.status !== 0) throw new Error('REMOTE_QUERY_FAILED');
  const sets = JSON.parse(run.stdout);
  const records = new Map(sets[0].results.map(row => [row.record_key, row]));
  const files = new Map(sets[1].results.map(row => [row.path, row]));
  if (records.size !== payload.records.length || files.size !== payload.files.length) throw new Error('REMOTE_COUNT');
  for (const record of payload.records) {
    const row = records.get(record.key);
    if (!row || hash(row.raw_json) !== record.sha256 || row.sha256 !== record.sha256) throw new Error('REMOTE_RECORD_HASH');
  }
  for (const file of payload.files) {
    const row = files.get(file.path);
    if (!row || row.sha256 !== file.sha256 || row.byte_length !== file.bytes) throw new Error('REMOTE_FILE_MANIFEST');
  }
  remoteVerified = true;
  remoteCounts = sets[2].results[0];
}
if (args.audit) {
  const metas = payload.records.filter(record => /:post:[^:]+:meta$/.test(record.key)).map(record => JSON.parse(record.raw));
  const snapshots = payload.files.filter(file => file.path.includes('/snapshots/') && file.canonical?.includes('/bai-viet/'));
  const matching = snapshots.map(file => {
    const slug = new URL(file.canonical).pathname.split('/').filter(Boolean).at(-1);
    const matches = metas.filter(meta => [meta.slug, meta.publishedSlug, ...(meta.managedSlugs || [])].includes(slug));
    return { slug, path: file.path, indexMatches: matches.length };
  });
  console.log(JSON.stringify({ audit: { snapshotCount: snapshots.length, indexCount: metas.length,
    snapshotOnly: matching.filter(row => row.indexMatches === 0),
    duplicateCanonical: matching.filter((row, i) => matching.some((other, j) => i !== j && other.slug === row.slug)),
    indexWithoutSnapshot: metas.filter(meta => !matching.some(row => [meta.slug, meta.publishedSlug, ...(meta.managedSlugs || [])].includes(row.slug)))
      .map(meta => ({ slug: meta.slug, status: meta.status })), remoteCounts } }));
}
console.log(JSON.stringify({ decrypted: true, objectsVerified: payload.objects.length,
  recordsVerified: payload.records.length, remoteVerified, privateDataPrinted: false }));
