import { readFile, writeFile } from 'node:fs/promises';
import { constants, privateDecrypt, createDecipheriv } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { hash, encryptBackup } from './blog-migration-inventory.mjs';
import { redisCommand } from '../src/redis-rest.mjs';

const PREFIX = 'realview:account:v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function parse(value) { try { return JSON.parse(value); } catch { return null; } }

export async function mapLegacyBlogGrants(records, command = redisCommand) {
  const candidates = records.filter(record => /^realview:blog:access:v1:grant:[a-f0-9]{64}$/.test(record.key));
  const mappings = [];
  let reads = 0;
  const get = async key => { reads++; return command(['GET', key]); };
  for (const record of candidates) {
    const entry = parse(record.raw);
    const row = { recordKey: record.key, sourceHash: record.sha256, mappingStatus: 'unresolved', active: false };
    mappings.push(row);
    const email = String(entry?.email || '').trim().toLowerCase();
    if (!email || !['admin', 'editor'].includes(entry?.role) || record.key.split(':').at(-1) !== hash(email)) {
      row.reason = 'invalid_source'; continue;
    }
    const currentGrant = await get(record.key);
    if (currentGrant !== record.raw) { row.reason = 'source_changed'; continue; }
    const id = await get(`${PREFIX}:email:${email}`);
    if (typeof id !== 'string' || !UUID.test(id)) { row.reason = 'no_account_index'; continue; }
    const user = parse(await get(`${PREFIX}:user:${id}`));
    if (!user || user.id !== id || String(user.email || '').trim().toLowerCase() !== email) {
      row.reason = 'account_mismatch'; continue;
    }
    if (user.deletedAt || user.disabledAt || ['disabled', 'deleted', 'suspended'].includes(user.status)) {
      row.reason = 'account_disabled'; continue;
    }
    const username = String(user.usernameNormalized || user.username || '').trim().toLowerCase();
    if (!username || await get(`${PREFIX}:username:${username}`) !== id) { row.reason = 'reverse_index_mismatch'; continue; }
    const startsAt = Date.parse(entry.startsAt);
    const expiresAt = entry.expiresAt ? Date.parse(entry.expiresAt) : null;
    if (!Number.isFinite(startsAt) || (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= startsAt))) {
      row.reason = 'invalid_window'; continue;
    }
    Object.assign(row, { mappingStatus: 'mapped', actorId: id, role: entry.role,
      startsAt: Math.floor(startsAt / 1000), expiresAt: expiresAt === null ? null : Math.floor(expiresAt / 1000),
      legacyRevoked: Boolean(entry.revokedAt || entry.status === 'revoked') });
  }
  for (const row of mappings) {
    if (row.actorId && mappings.filter(other => other.actorId === row.actorId).length > 1) {
      row.mappingStatus = 'unresolved'; row.reason = 'duplicate_account';
    }
  }
  return { capturedAt: new Date().toISOString(), mappings,
    summary: { total: mappings.length, mapped: mappings.filter(row => row.mappingStatus === 'mapped').length,
      unresolved: mappings.filter(row => row.mappingStatus !== 'mapped').length, activated: 0,
      redisReads: reads, redisWrites: 0 } };
}

export async function readEncryptedBlogBackup(backupPath, keyPath) {
  const envelope = JSON.parse(await readFile(backupPath, 'utf8'));
  if (envelope.version !== 1 || envelope.algorithm !== 'AES-256-GCM+RSA-OAEP-SHA256') throw new Error('BACKUP_FORMAT');
  const key = privateDecrypt({ key: await readFile(keyPath), padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256' }, Buffer.from(envelope.wrappedKey, 'base64'));
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  cipher.setAAD(Buffer.from('realview-blog-backup-v1'));
  cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(envelope.data, 'base64')), cipher.final()]));
}
async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const i = arg.indexOf('='); return [arg.slice(2, i), arg.slice(i + 1)];
  }));
  if (!args.backup || !args.key || !args.out || !args['public-key']) throw new Error('MAPPING_ARGS_REQUIRED');
  const payload = await readEncryptedBlogBackup(args.backup, args.key);
  for (const record of payload.records) if (hash(JSON.stringify(record.raw)) !== record.sha256) throw new Error('RECORD_HASH');
  const result = await mapLegacyBlogGrants(payload.records);
  // No account credential, raw account record, email or plaintext mapping is persisted.
  await writeFile(args.out, encryptBackup(result, await readFile(args['public-key'])), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify(result.summary));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('GRANT_MAPPING_FAILED: no private data printed'); process.exitCode = 1; });
}
