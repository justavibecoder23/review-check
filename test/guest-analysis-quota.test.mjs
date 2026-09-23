import test from 'node:test';
import assert from 'node:assert/strict';
import {
  claimGuestHistory,
  guestQuotaConfig,
  guestQuotaStatus,
  reserveGuestAnalysis
} from '../src/guest-analysis-quota.mjs';

function response() {
  const headers = new Map();
  return {
    getHeader: (name) => headers.get(name.toLowerCase()),
    setHeader: (name, value) => headers.set(name.toLowerCase(), value)
  };
}

function request(device = 1, ip = '192.0.2.1') {
  return {
    headers: {
      cookie: `realview_guest=${Buffer.alloc(32, device).toString('base64url')}`,
      'x-forwarded-for': ip
    }
  };
}

function result(id) {
  return {
    product: { platform: 'Shopee', itemId: String(id), url: `https://shopee.vn/product-i.12.${id}`, title: `Product ${id}` },
    reviews: [{ author: 'Guest', text: 'Works well', rating: 5, included: true }],
    stats: { scanned: 1, included: 1, excluded: 0 },
    trust: { score: 82, tone: 'green' }
  };
}

function fakeRedis() {
  const values = new Map();
  const pending = new Map();
  const history = new Map();
  const index = new Map();
  const command = async (args) => {
    const [op, script, count] = args;
    if (op === 'EVAL') {
      const keys = args.slice(3, 3 + Number(count));
      const argv = args.slice(3 + Number(count));
      if (script.includes('ZREMRANGEBYSCORE')) {
        const [usedKey, pendingKey] = keys;
        const records = pending.get(pendingKey) || new Map();
        for (const [id, expiry] of records) if (expiry <= Number(argv[0])) records.delete(id);
        pending.set(pendingKey, records);
        const used = Number(values.get(usedKey) || 0);
        const remaining = Math.max(0, Number(argv[script.includes('local used') ? 2 : 1]) - used - records.size);
        if (!script.includes('local used')) return remaining;
        const [,, duplicateKey, ipCount, ipSeen] = keys;
        const attempt = argv[3];
        if (values.has(duplicateKey)) return [2, Math.max(0, Number(argv[2]) - used)];
        if (records.has(attempt)) return [4, remaining];
        if (remaining <= 0) return [0, 0];
        if (ipCount && !values.has(ipSeen)) {
          const devices = Number(values.get(ipCount) || 0);
          if (devices >= Number(argv[4])) return [3, remaining];
          values.set(ipCount, devices + 1);
          values.set(ipSeen, 1);
        }
        records.set(attempt, Number(argv[0]) + Number(argv[1]));
        return [1, remaining - 1];
      }
      if (script.includes("redis.call('ZREM', KEYS[2]")) {
        const [usedKey, pendingKey, duplicateKey, indexKey, itemKey] = keys;
        const records = pending.get(pendingKey) || new Map();
        const reserved = records.delete(argv[0]);
        const duplicate = values.has(duplicateKey);
        if (reserved && !duplicate) {
          values.set(usedKey, Number(values.get(usedKey) || 0) + 1);
          values.set(duplicateKey, 1);
        }
        if (reserved || duplicate) {
          history.set(itemKey, argv[4]);
          const items = index.get(indexKey) || new Map();
          items.set(argv[5], Number(argv[3]));
          index.set(indexKey, items);
        }
        return Math.max(0, Number(argv[6]) - Number(values.get(usedKey) || 0));
      }
      if (script.includes('ZSCORE')) return 1;
    }
    if (op === 'ZREM') return Number((pending.get(args[1]) || new Map()).delete(args[2]));
    if (op === 'ZREVRANGE') return [...(index.get(args[1]) || new Map())].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    if (op === 'MGET') return args.slice(1).map((key) => history.get(key) || null);
    if (op === 'DEL') {
      for (const key of args.slice(1)) { history.delete(key); index.delete(key); }
      return 1;
    }
    throw new Error(`Unsupported fake command: ${op}`);
  };
  return { command, values, pending, history };
}

const previousUrl = process.env.UPSTASH_REDIS_REST_URL;
const previousToken = process.env.UPSTASH_REDIS_REST_TOKEN;
process.env.UPSTASH_REDIS_REST_URL = 'https://example.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-secret';
process.on('exit', () => {
  if (previousUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = previousUrl;
  if (previousToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = previousToken;
});

test('three successful guest analyses, cache duplicate free, fourth product blocked', async () => {
  const redis = fakeRedis();
  const req = request();
  const res = response();
  for (let id = 1000000001; id < 1000000004; id += 1) {
    const url = `https://shopee.vn/product-i.12.${id}`;
    const ticket = await reserveGuestAnalysis(req, res, url, { redisCommandImpl: redis.command });
    assert.equal(await ticket.confirm(result(id)), 1000000004 - id - 1);
  }
  assert.deepEqual(await guestQuotaStatus(req, res, { redisCommandImpl: redis.command }), { remainingGuestQuota: 0, guestQuotaLimit: 3 });
  const repeated = await reserveGuestAnalysis(req, res, 'https://shopee.vn/product-i.12.1000000001', { redisCommandImpl: redis.command });
  assert.equal(await repeated.confirm(result(1000000001)), 0);
  await assert.rejects(reserveGuestAnalysis(req, res, 'https://shopee.vn/product-i.12.1000000004', { redisCommandImpl: redis.command }),
    { code: 'GUEST_QUOTA_EXHAUSTED', statusCode: 429 });
});

test('pending reservations are counted and refund releases a slot', async () => {
  const redis = fakeRedis();
  const req = request(2);
  const res = response();
  const tickets = [];
  for (let id = 1000000011; id < 1000000014; id += 1) {
    tickets.push(await reserveGuestAnalysis(req, res, `https://shopee.vn/product-i.12.${id}`, { redisCommandImpl: redis.command }));
  }
  assert.equal((await guestQuotaStatus(req, res, { redisCommandImpl: redis.command })).remainingGuestQuota, 0);
  await assert.rejects(reserveGuestAnalysis(req, res, 'https://shopee.vn/product-i.12.1000000014', { redisCommandImpl: redis.command }),
    { code: 'GUEST_QUOTA_EXHAUSTED' });
  await tickets[0].refund();
  assert.equal((await guestQuotaStatus(req, res, { redisCommandImpl: redis.command })).remainingGuestQuota, 1);
  for (const ticket of tickets.slice(1)) await ticket.refund();
});

test('expired reservation releases its slot without changing lifetime count', async () => {
  const redis = fakeRedis();
  const req = request(7);
  const res = response();
  const ticket = await reserveGuestAnalysis(req, res, 'https://shopee.vn/product-i.12.1000000041', { redisCommandImpl: redis.command });
  for (const records of redis.pending.values()) for (const id of records.keys()) records.set(id, 0);
  assert.equal((await guestQuotaStatus(req, res, { redisCommandImpl: redis.command })).remainingGuestQuota, 3);
  await ticket.refund();
});

test('TikTok tracking parameters do not consume another guest slot for the same product', async () => {
  const redis = fakeRedis();
  const req = request(8);
  const res = response();
  const base = 'https://shop.tiktok.com/vn/pdp/sample-product/1731238970187483121';
  const first = await reserveGuestAnalysis(req, res, `${base}?source=share`, { redisCommandImpl: redis.command });
  await first.confirm({ ...result('1731238970187483121'), product: { ...result('1731238970187483121').product, platform: 'TikTok Shop', productId: '1731238970187483121' } });
  const repeated = await reserveGuestAnalysis(req, res, `${base}?source=other`, { redisCommandImpl: redis.command });
  assert.equal(await repeated.confirm({ ...result('1731238970187483121'), product: { ...result('1731238970187483121').product, platform: 'TikTok Shop', productId: '1731238970187483121' } }), 2);
});

test('guest history can be claimed after registration by the same cookie', async () => {
  const redis = fakeRedis();
  const req = request(3);
  const res = response();
  const ticket = await reserveGuestAnalysis(req, res, 'https://shopee.vn/product-i.12.1000000021', { redisCommandImpl: redis.command });
  await ticket.confirm(result(1000000021));
  const claimed = [];
  const count = await claimGuestHistory(req, res, 'account-a', {
    redisCommandImpl: redis.command,
    saveAccountHistoryImpl: async (userId, item) => claimed.push({ userId, item })
  });
  assert.equal(count, 1);
  assert.equal(claimed[0].userId, 'account-a');
  assert.equal(claimed[0].item.fullReport.product.title, 'Product 1000000021');
});

test('more than twenty new devices on one IP requires login', async () => {
  const redis = fakeRedis();
  for (let device = 1; device <= guestQuotaConfig.ipDeviceLimit; device += 1) {
    const ticket = await reserveGuestAnalysis(request(device, '203.0.113.9'), response(), `https://shopee.vn/product-i.12.${1000000100 + device}`, { redisCommandImpl: redis.command });
    await ticket.refund();
  }
  await assert.rejects(reserveGuestAnalysis(request(21, '203.0.113.9'), response(), 'https://shopee.vn/product-i.12.1000000999', { redisCommandImpl: redis.command }),
    { code: 'GUEST_IP_DEVICE_LIMIT', statusCode: 429 });
});
