import { randomUUID } from 'node:crypto';
import { redisCommand } from './redis-rest.mjs';

export const MEDIA_RULE_VERSION = 'v1';
export const MEDIA_LOCK_MS = 45_000;
export const MEDIA_WAIT_MS = 15_000;
const AUDIT_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUDIT_LIMIT = 20_000;

// The hash tag keeps all keys for one image in the same Redis slot. Fence keys
// must never be expired, evicted by a cleanup job, or recreated after restore.
export function mediaKeys(hash) {
  const tag = `{${hash}}`;
  return {
    mapping: `blog-media:dedup:v1:${tag}`,
    lock: `blog-media:lock:v1:${tag}`,
    fence: `blog-media:fence:v1:${tag}`
  };
}

export const MEDIA_SCRIPTS = {
  acquire: `#!lua flags=allow-key-locking
if redis.call('EXISTS', KEYS[1]) == 1 then return {'READY'} end
if redis.call('EXISTS', KEYS[2]) == 1 then return {'BUSY'} end
local fence = redis.call('INCR', KEYS[3])
redis.call('SET', KEYS[2], ARGV[1] .. ':' .. fence, 'PX', ARGV[2])
return {'ACQUIRED', tostring(fence)}`,
  renew: `#!lua flags=allow-key-locking
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('PEXPIRE', KEYS[1], ARGV[2])`,
  finalize: `#!lua flags=allow-key-locking
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
if tostring(redis.call('GET', KEYS[3])) ~= ARGV[2] then return 0 end
if redis.call('EXISTS', KEYS[1]) == 1 then return 2 end
redis.call('SET', KEYS[1], ARGV[3])
redis.call('DEL', KEYS[2])
return 1`,
  release: `#!lua flags=allow-key-locking
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])`,
  audit: `#!lua flags=allow-key-locking
local count = redis.call('LPUSH', KEYS[1], ARGV[1])
redis.call('LTRIM', KEYS[1], 0, ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return count`
};

function command(parts, options) {
  if (options.redisCommandImpl) return options.redisCommandImpl(parts);
  return redisCommand(parts, { fetchImpl: options.redisFetchImpl, timeoutMs: options.redisTimeoutMs || 4_000 });
}

function evalScript(script, keys, args, options) {
  return command(['EVAL', script, String(keys.length), ...keys, ...args.map(String)], options);
}

function parseMapping(value, hash) {
  if (!value) return null;
  let mapping;
  try { mapping = JSON.parse(value); } catch { throw new Error('BLOG_MEDIA_MAPPING_INVALID'); }
  if (mapping?.hash !== hash || mapping?.ruleVersion !== MEDIA_RULE_VERSION
    || !Array.isArray(mapping?.responsiveSources) || !mapping.responsiveSources.length
    || mapping.responsiveSources.some((source) => !source?.url || !source?.pathname)) {
    throw new Error('BLOG_MEDIA_MAPPING_INVALID');
  }
  return mapping;
}

export async function readMediaMapping(hash, options = {}) {
  return parseMapping(await command(['GET', mediaKeys(hash).mapping], options), hash);
}

export async function acquireMedia(hash, options = {}) {
  const keys = mediaKeys(hash);
  const owner = (options.randomUUIDImpl || randomUUID)();
  const response = await evalScript(MEDIA_SCRIPTS.acquire, [keys.mapping, keys.lock, keys.fence],
    [owner, MEDIA_LOCK_MS], options).catch(async (error) => {
    // An HTTP timeout does not tell us whether the script ran. Recover only
    // our own lock; never issue another acquisition blindly.
    const [mapping, lock] = await Promise.all([
      readMediaMapping(hash, options), command(['GET', keys.lock], options)
    ]).catch(() => { throw error; });
    if (mapping) return ['READY'];
    const match = typeof lock === 'string' && lock.match(new RegExp(`^${owner}:(\\d+)$`));
    return match ? ['ACQUIRED', match[1]] : ['UNCERTAIN'];
  });
  if (response?.[0] === 'READY') return { state: 'ready' };
  if (response?.[0] === 'BUSY') return { state: 'busy' };
  if (response?.[0] !== 'ACQUIRED' || !/^\d+$/.test(String(response[1]))) {
    return { state: 'uncertain' };
  }
  const fence = String(response[1]);
  return { state: 'acquired', hash, fence, lockValue: `${owner}:${fence}` };
}

export async function renewMedia(lease, options = {}) {
  const keys = mediaKeys(lease.hash);
  // A retry of this conditional script is safe; a GET followed by PEXPIRE is not.
  const result = await evalScript(MEDIA_SCRIPTS.renew, [keys.lock],
    [lease.lockValue, MEDIA_LOCK_MS], options);
  return Number(result) === 1;
}

export async function finalizeMedia(lease, mapping, options = {}) {
  const keys = mediaKeys(lease.hash);
  const serialized = JSON.stringify({ ...mapping, hash: lease.hash, ruleVersion: MEDIA_RULE_VERSION, fence: lease.fence });
  const finalize = () => evalScript(MEDIA_SCRIPTS.finalize,
    [keys.mapping, keys.lock, keys.fence], [lease.lockValue, lease.fence, serialized], options);
  let result;
  try { result = await finalize(); } catch (error) {
    // The script may have committed before its REST response was lost.
    const committed = await readMediaMapping(lease.hash, options).catch(() => null);
    if (committed?.fence === lease.fence && JSON.stringify(committed.responsiveSources) === JSON.stringify(mapping.responsiveSources)) return committed;
    const lock = await command(['GET', keys.lock], options).catch(() => null);
    if (lock !== lease.lockValue) throw error;
    result = await finalize();
  }
  if (Number(result) === 1) return JSON.parse(serialized);
  const committed = await readMediaMapping(lease.hash, options).catch(() => null);
  if (committed?.fence === lease.fence && JSON.stringify(committed.responsiveSources) === JSON.stringify(mapping.responsiveSources)) return committed;
  throw new Error('BLOG_MEDIA_LEASE_LOST');
}

export async function releaseMedia(lease, options = {}) {
  const keys = mediaKeys(lease.hash);
  return evalScript(MEDIA_SCRIPTS.release, [keys.lock], [lease.lockValue], options);
}

export async function waitForMedia(hash, options = {}) {
  const deadline = Date.now() + (options.mediaWaitMs ?? MEDIA_WAIT_MS);
  while (Date.now() < deadline) {
    const mapping = await readMediaMapping(hash, options);
    if (mapping) return mapping;
    await new Promise((resolve) => setTimeout(resolve, Math.min(750, Math.max(0, deadline - Date.now()))));
  }
  return readMediaMapping(hash, options);
}

export async function auditMedia(event, data, options = {}) {
  const record = JSON.stringify({ event, at: new Date().toISOString(), ...data });
  const key = `blog-media:audit:v1:${new Date().toISOString().slice(0, 10)}`;
  // Daily keys permit a bounded 30-day retention without touching fence keys.
  await evalScript(MEDIA_SCRIPTS.audit, [key],
    [record, AUDIT_LIMIT - 1, AUDIT_TTL_SECONDS], options);
}
