import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  getDynamicAccessGrant,
  listAccessAudit,
  listAccessGrants,
  resolveDynamicAccessRole,
  revokeAccessGrant,
  upsertAccessGrant
} from '../src/blog-access-store.mjs';
import { resolveEffectiveBlogRole } from '../src/blog-admin-auth.mjs';

function redisMock() {
  const strings = new Map(); const sorted = new Map(); const lists = new Map();
  function command(parts) {
    const [raw, ...args] = parts; const name = String(raw).toUpperCase();
    if (name === 'SET') { strings.set(args[0], String(args[1])); return 'OK'; }
    if (name === 'GET') return strings.get(args[0]) ?? null;
    if (name === 'MGET') return args.map((key) => strings.get(key) ?? null);
    if (name === 'ZADD') { const values = sorted.get(args[0]) || new Map(); values.set(String(args[2]), Number(args[1])); sorted.set(args[0], values); return 1; }
    if (name === 'ZREVRANGE') {
      const values = [...(sorted.get(args[0]) || new Map()).entries()].sort((a, b) => b[1] - a[1]).map(([member]) => member);
      return values.slice(Number(args[1]), Number(args[2]) + 1);
    }
    if (name === 'LPUSH') { const values = lists.get(args[0]) || []; args.slice(1).forEach((value) => values.unshift(String(value))); lists.set(args[0], values); return values.length; }
    if (name === 'LTRIM') { const values = lists.get(args[0]) || []; lists.set(args[0], values.slice(Number(args[1]), Number(args[2]) + 1)); return 'OK'; }
    if (name === 'LRANGE') return (lists.get(args[0]) || []).slice(Number(args[1]), Number(args[2]) + 1);
    throw new Error(`Unsupported command ${name}`);
  }
  return {
    fetchImpl: async (url, options) => {
      const input = JSON.parse(options.body);
      const body = url.endsWith('/multi-exec') ? input.map((item) => ({ result: command(item) })) : { result: command(input) };
      return { ok: true, json: async () => body };
    }
  };
}

async function withRedis(run) {
  const oldUrl = process.env.UPSTASH_REDIS_REST_URL; const oldToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test'; process.env.UPSTASH_REDIS_REST_TOKEN = 'test';
  try { return await run(redisMock()); }
  finally {
    if (oldUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL; else process.env.UPSTASH_REDIS_REST_URL = oldUrl;
    if (oldToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN; else process.env.UPSTASH_REDIS_REST_TOKEN = oldToken;
  }
}

const actor = { account: { id: 'owner-1', email: 'owner@realview.com.vn', username: 'owner' }, role: 'admin' };
const env = { BLOG_ADMIN_EMAILS: 'owner@realview.com.vn, second@realview.com.vn' };

test('admin cấp quyền động theo thời hạn, cập nhật và hệ thống tự vô hiệu khi hết hạn', () => withRedis(async (redis) => {
  const now = Date.parse('2026-09-17T10:00:00.000Z');
  const entry = await upsertAccessGrant({
    email: 'Editor@Example.com', role: 'editor', startsAt: new Date(now).toISOString(), expiresAt: new Date(now + 86_400_000).toISOString()
  }, actor, { fetchImpl: redis.fetchImpl, env, nowMs: now });
  assert.equal(entry.email, 'editor@example.com');
  assert.equal(entry.status, 'active');
  assert.equal(await resolveDynamicAccessRole(entry.email, { fetchImpl: redis.fetchImpl, nowMs: now + 1 }), 'editor');
  assert.equal(await resolveDynamicAccessRole(entry.email, { fetchImpl: redis.fetchImpl, nowMs: now + 86_400_001 }), null);

  const updated = await upsertAccessGrant({ email: entry.email, role: 'admin', startsAt: new Date(now).toISOString(), expiresAt: null }, actor, { fetchImpl: redis.fetchImpl, env, nowMs: now + 2 });
  assert.equal(updated.role, 'admin');
  assert.equal(updated.expiresAt, null);
  assert.equal((await listAccessAudit({ fetchImpl: redis.fetchImpl })).length, 2);
}));

test('admin gốc không thể bị sửa và luôn xuất hiện như chủ sở hữu', () => withRedis(async (redis) => {
  await assert.rejects(
    upsertAccessGrant({ email: 'owner@realview.com.vn', role: 'editor' }, actor, { fetchImpl: redis.fetchImpl, env }),
    (error) => error.code === 'BOOTSTRAP_ADMIN_IMMUTABLE'
  );
  const entries = await listAccessGrants({ fetchImpl: redis.fetchImpl, env });
  assert.deepEqual(entries.map((entry) => [entry.email, entry.status]), [
    ['owner@realview.com.vn', 'owner'], ['second@realview.com.vn', 'owner']
  ]);
}));

test('thu hồi có hiệu lực ở lần kiểm tra kế tiếp và không cho admin tự thu hồi', () => withRedis(async (redis) => {
  await upsertAccessGrant({ email: 'admin@example.com', role: 'admin' }, actor, { fetchImpl: redis.fetchImpl, env });
  await revokeAccessGrant('admin@example.com', actor, { fetchImpl: redis.fetchImpl, env });
  assert.equal((await getDynamicAccessGrant('admin@example.com', { fetchImpl: redis.fetchImpl })).status, 'revoked');
  assert.equal(await resolveDynamicAccessRole('admin@example.com', { fetchImpl: redis.fetchImpl }), null);
  await assert.rejects(
    revokeAccessGrant('owner@realview.com.vn', actor, { fetchImpl: redis.fetchImpl, env }),
    (error) => error.code === 'BOOTSTRAP_ADMIN_IMMUTABLE'
  );
}));

test('role hiệu lực ưu tiên admin gốc rồi mới dùng ACL động', async () => {
  assert.equal(await resolveEffectiveBlogRole({ id: '1', email: 'owner@realview.com.vn' }, {
    env,
    resolveDynamicAccessRoleImpl: async () => { throw new Error('không được gọi'); }
  }), 'admin');
  assert.equal(await resolveEffectiveBlogRole({ id: '2', email: 'dynamic@example.com' }, {
    env,
    resolveDynamicAccessRoleImpl: async () => 'editor'
  }), 'editor');
});

test('frontend chỉ render menu quyền truy cập theo capability manageAccess', async () => {
  const [auth, page, script, vercel] = await Promise.all([
    readFile(new URL('../public/auth.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/admin-access.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/admin-access.js', import.meta.url), 'utf8'),
    readFile(new URL('../vercel.json', import.meta.url), 'utf8')
  ]);
  assert.match(auth, /currentBlogCapabilities\?\.manageAccess/);
  assert.match(auth, /href="\/admin\/access"/);
  assert.match(page, /data-access-list/);
  assert.match(script, /Editor và user không có quyền/);
  assert.match(vercel, /"source": "\/api\/admin-access", "destination": "\/api\/blog\.mjs\?route=access-admin"/);
  assert.match(vercel, /"source": "\/admin\/access"/);
});
