import test from 'node:test';
import assert from 'node:assert/strict';
import handler, { createShopeeProductMetaHandler } from '../src/shopee-product-meta-route.mjs';
import { createShopeeMetadataTicket } from '../src/shopee-metadata-ticket.mjs';

test('khi Actor tắt, metadata nền vẫn có thể lấy đúng sản phẩm từ HTML', async () => {
  const oldFetch = globalThis.fetch;
  const oldUrl = process.env.UPSTASH_REDIS_REST_URL;
  const oldToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const oldFlag = process.env.SHOPEE_DETAIL_ACTOR_ENABLED;
  const oldSecret = process.env.RESULT_CONTEXT_SIGNING_SECRET;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test';
  process.env.SHOPEE_DETAIL_ACTOR_ENABLED = 'false';
  process.env.RESULT_CONTEXT_SIGNING_SECRET = 'test-shopee-metadata-ticket-secret';
  const values = new Map();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).startsWith('https://redis.test')) {
      const command = JSON.parse(init.body);
      let result = null;
      if (command[0] === 'GET') result = values.get(command[1]) || null;
      if (command[0] === 'SET') { values.set(command[1], command[2]); result = 'OK'; }
      if (command[0] === 'INCR') {
        result = Number(values.get(command[1]) || 0) + 1;
        values.set(command[1], String(result));
      }
      if (command[0] === 'EXPIRE') result = 1;
      return { ok: true, async json() { return { result }; } };
    }
    if (String(url).includes('/api/v4/item/get')) return { ok: false, status: 403, headers: { get: () => '' } };
    const html = `<script type="text/mfe-initial-data">${JSON.stringify({
      initialState: { item: { items: { 456: {
        shop_id: 123, item_id: 456, name: 'Tên sản phẩm thật', image: 'vn-11134207-product-cover-123'
      } } } }
    })}</script>`;
    return { ok: true, status: 200, headers: { get: () => 'text/html' }, async text() { return html; } };
  };
  const response = {
    setHeader() {}, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  try {
    await handler({ method: 'POST', headers: { host: 'realview.com.vn' },
      body: { url: 'https://shopee.vn/product-i.123.456',
        metadataTicket: createShopeeMetadataTicket('123', '456') } }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.metadata.title, 'Tên sản phẩm thật');
    assert.match(response.body.metadata.image, /down-vn\.img\.susercontent\.com/);
    assert.equal(response.body.itemId, '456');
    assert.equal(calls.some((url) => url.includes('api.apify.com')), false);
    assert.equal([...values.keys()].some((key) => key.includes('shopee:123:456')), true);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = oldUrl;
    if (oldToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = oldToken;
    if (oldFlag === undefined) delete process.env.SHOPEE_DETAIL_ACTOR_ENABLED;
    else process.env.SHOPEE_DETAIL_ACTOR_ENABLED = oldFlag;
    if (oldSecret === undefined) delete process.env.RESULT_CONTEXT_SIGNING_SECRET;
    else process.env.RESULT_CONTEXT_SIGNING_SECRET = oldSecret;
  }
});

test('Actor chi tiết là nguồn chính và không gọi HTML/API khi đã có đủ metadata', async () => {
  const oldSecret = process.env.RESULT_CONTEXT_SIGNING_SECRET;
  process.env.RESULT_CONTEXT_SIGNING_SECRET = 'test-shopee-metadata-ticket-secret';
  const calls = [];
  const actorFirst = createShopeeProductMetaHandler({
    actorEnabled: () => true,
    fetchActor: async (_url, ids) => {
      calls.push(`actor:${ids.shopId}:${ids.itemId}`);
      return { status: 'resolved', metadata: { title: 'Tai nghe JBL', image: 'https://down-vn.img.susercontent.com/file/hero' }, latencyMs: 750 };
    },
    fetchPage: async () => { calls.push('page'); return {}; },
    fetchItemApi: async () => { calls.push('api'); return {}; }
  });
  const response = { setHeader() {}, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
  try {
    await actorFirst({ method: 'POST', headers: { host: 'realview.com.vn' }, body: {
      url: 'https://shopee.vn/example-i.1358301775.28661346083',
      metadataTicket: createShopeeMetadataTicket('1358301775', '28661346083')
    } }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.status, 'resolved');
    assert.equal(response.body.metadata.title, 'Tai nghe JBL');
    assert.deepEqual(calls, ['actor:1358301775:28661346083']);
  } finally {
    if (oldSecret === undefined) delete process.env.RESULT_CONTEXT_SIGNING_SECRET;
    else process.env.RESULT_CONTEXT_SIGNING_SECRET = oldSecret;
  }
});
