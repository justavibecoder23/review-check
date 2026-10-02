import { createHash, createCipheriv, randomBytes, publicEncrypt, constants } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { redisCommand } from '../src/redis-rest.mjs';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const CMS = 'realview:blog:cms:v1';
const ACCESS = 'realview:blog:access:v1';
const quote = value => `'${String(value).replaceAll("'", "''")}'`;

export async function inventoryLocal(root) {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const bytes = await readFile(path);
        const name = relative(root, path);
        files.push({ path: name, bytes: bytes.length, sha256: hash(bytes),
          ...(name.endsWith('.html') ? { canonical: bytes.toString().match(/<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"/i)?.[1] || null } : {}) });
      }
    }
  }
  for (const dir of ['public/blog', 'public/assets/blog', 'public/assets/blog-recovered']) {
    try { await walk(resolve(root, dir)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function inventoryRedis(command = redisCommand) {
  const records = [];
  const ids = await command(['ZREVRANGE', `${CMS}:posts`, '0', '-1']) || [];
  if (ids.length > 10000) throw new Error('INVENTORY_POST_LIMIT');
  async function add(key, type = 'string') {
    const raw = await command(type === 'list' ? ['LRANGE', key, '0', '-1']
      : type === 'zset' ? ['ZRANGE', key, '0', '-1', 'WITHSCORES'] : ['GET', key]);
    if (raw != null) records.push({ key, type, raw, sha256: hash(JSON.stringify(raw)) });
    if (records.length > 50000) throw new Error('INVENTORY_RECORD_LIMIT');
    return raw;
  }
  await add(`${CMS}:posts`, 'zset');
  const before = [];
  let pointers = 0, inline = 0, blockedBlob = 0, maxInlineBytes = 0;
  const revisionNumbers = [];
  for (const id of ids) {
    const metaRaw = await add(`${CMS}:post:${id}:meta`);
    before.push(metaRaw);
    const meta = metaRaw ? JSON.parse(metaRaw) : {};
    for (const slug of new Set([meta.slug, meta.publishedSlug, ...(meta.managedSlugs || [])].filter(Boolean))) {
      await add(`${CMS}:slug:${slug}`);
      await add(`${CMS}:redirect:${slug}`);
    }
    await add(`${CMS}:post:${id}:revisions`, 'zset');
    await add(`${CMS}:post:${id}:audit`, 'list');
    const revisions = await command(['ZRANGE', `${CMS}:post:${id}:revisions`, '0', '-1']) || [];
    revisionNumbers.push({ id, revisions });
    if (revisions.length > 10000) throw new Error('INVENTORY_REVISION_LIMIT');
    for (const revision of revisions) {
      const raw = await add(`${CMS}:post:${id}:revision:${revision}`);
      if (!raw) continue;
      const pointer = JSON.parse(raw); pointers++;
      if (pointer.storage === 'redis' && pointer.document) {
        inline++; maxInlineBytes = Math.max(maxInlineBytes, Buffer.byteLength(JSON.stringify(pointer.document)));
      } else if (pointer.storage === 'vercel-blob-private') blockedBlob++;
    }
  }
  await add(`${ACCESS}:grants`, 'zset');
  await add(`${ACCESS}:audit`, 'list');
  const grants = await command(['ZREVRANGE', `${ACCESS}:grants`, '0', '-1']) || [];
  if (grants.length > 10000) throw new Error('INVENTORY_GRANT_LIMIT');
  for (const digest of grants) await add(`${ACCESS}:grant:${digest}`);
  const afterIds = await command(['ZREVRANGE', `${CMS}:posts`, '0', '-1']) || [];
  const after = [];
  for (const id of ids) after.push(await command(['GET', `${CMS}:post:${id}:meta`]));
  let stable = JSON.stringify(ids) === JSON.stringify(afterIds) && JSON.stringify(before) === JSON.stringify(after);
  for (const entry of revisionNumbers) stable &&= JSON.stringify(entry.revisions)
    === JSON.stringify(await command(['ZRANGE', `${CMS}:post:${entry.id}:revisions`, '0', '-1']) || []);
  const unique = [...new Map(records.map(record => [record.key, record])).values()];
  return { records: unique, summary: { posts: ids.length, revisionPointers: pointers, inlineRevisions: inline,
    blockedBlobRevisions: blockedBlob, maxInlineRevisionBytes: maxInlineBytes, grants: grants.length,
    records: unique.length, observedStable: stable, blobReads: 0, redisWrites: 0 } };
}

export function previewSql(files, records, { transaction = true } = {}) {
  const statements = transaction ? ['BEGIN TRANSACTION;'] : [];
  for (const file of files) statements.push(`INSERT OR IGNORE INTO blog_import_files(path,sha256,byte_length,canonical) VALUES (${quote(file.path)},${quote(file.sha256)},${file.bytes},${file.canonical ? quote(file.canonical) : 'NULL'});`);
  for (const record of records) statements.push(`INSERT OR IGNORE INTO blog_import_records(record_key,record_type,raw_json,sha256) VALUES (${quote(record.key)},${quote(record.type)},${quote(JSON.stringify(record.raw))},${quote(record.sha256)});`);
  const slugs = new Map();
  for (const file of files.filter(f => f.canonical && f.path.endsWith('.html'))) {
    const slug = new URL(file.canonical).pathname.match(/^\/bai-viet\/([a-z0-9-]+)$/)?.[1];
    if (!slug) continue;
    const ownership = file.path.includes('/snapshots/') ? 'snapshot' : 'static';
    if (!slugs.has(slug) || ownership === 'snapshot') slugs.set(slug, { ownership, path: file.path });
  }
  for (const [slug, owner] of slugs) statements.push(`INSERT OR IGNORE INTO blog_slugs(slug,ownership,owner_id,tombstone) VALUES (${quote(slug)},${quote(owner.ownership)},${quote(owner.path)},0);`);
  if (transaction) statements.push('COMMIT;');
  return statements.join('\n');
}

export function encryptBackup(payload, publicKey) {
  const key = randomBytes(32), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('realview-blog-backup-v1'));
  const data = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return JSON.stringify({ version: 1, algorithm: 'AES-256-GCM+RSA-OAEP-SHA256',
    wrappedKey: publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key).toString('base64'),
    iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(a => { const i = a.indexOf('='); return [a.slice(2, i), a.slice(i + 1)]; }));
  if (!args.out) throw new Error('Use --out=absolute-output-directory [--public-key=path]');
  const root = resolve('.'), out = resolve(args.out);
  const files = await inventoryLocal(root);
  const remote = await inventoryRedis();
  const payload = { schemaVersion: 1, capturedAt: new Date().toISOString(), files, ...remote };
  if (Buffer.byteLength(JSON.stringify(payload)) > 128 * 1024 * 1024) throw new Error('BACKUP_SIZE_LIMIT');
  await mkdir(out, { recursive: true, mode: 0o700 });
  const report = { capturedAt: payload.capturedAt, ...remote.summary,
    localFiles: files.length, localBytes: files.reduce((n, f) => n + f.bytes, 0),
    snapshotArticles: files.filter(f => f.path.includes('/snapshots/') && f.canonical?.includes('/bai-viet/')).length,
    encryptedBackup: Boolean(args['public-key']), importReady: false,
    warning: 'Read-only sample, not a frozen cutover export; locked Blob revision bodies are absent.' };
  await writeFile(join(out, 'inventory-report.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  await writeFile(join(out, 'local-file-manifest.json'), JSON.stringify(files, null, 2), { flag: 'wx', mode: 0o600 });
  if (args['public-key']) {
    payload.objects = await Promise.all(files.map(async file => ({ path: file.path,
      sha256: file.sha256, base64: (await readFile(resolve(root, file.path))).toString('base64') })));
    if (payload.objects.some(object => hash(Buffer.from(object.base64, 'base64')) !== object.sha256)) throw new Error('LOCAL_FILE_CHANGED');
    if (Buffer.byteLength(JSON.stringify(payload)) > 256 * 1024 * 1024) throw new Error('BACKUP_SIZE_LIMIT');
    await writeFile(join(out, 'blog-backup.encrypted.json'), encryptBackup(payload, await readFile(args['public-key'])), { flag: 'wx', mode: 0o600 });
    // Working import file contains private data: local mode 0600, never commit/upload to public storage.
    await writeFile(join(out, 'preview-import.sql'), previewSql(files, remote.records), { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify(report));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => {
  console.error(JSON.stringify({ error: error.message })); process.exitCode = 1;
});
