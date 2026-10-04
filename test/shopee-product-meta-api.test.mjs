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

test('Actor chi tiết chỉ chạy sau khi các nguồn công khai không có metadata', async () => {
  const oldSecret = process.env.RESULT_CONTEXT_SIGNING_SECRET;
  process.env.RESULT_CONTEXT_SIGNING_SECRET = 'test-shopee-metadata-ticket-secret';
  const calls = [];
  const actorFirst = createShopeeProductMetaHandler({
    fetchPublic: async () => ({ status: 'empty' }),
    fetchSeo: async () => ({ status: 'disabled' }),
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
    assert.deepEqual(calls, ['page', 'api', 'actor:1358301775:28661346083']);
  } finally {
    if (oldSecret === undefined) delete process.env.RESULT_CONTEXT_SIGNING_SECRET;
    else process.env.RESULT_CONTEXT_SIGNING_SECRET = oldSecret;
  }
});

test('public exact-ID metadata is primary, cached and bypasses Actor/page/API/search', async () => {
  const oldSecret = process.env.RESULT_CONTEXT_SIGNING_SECRET;
  process.env.RESULT_CONTEXT_SIGNING_SECRET = 'public-metadata-route-test';
  let cached = null;
  let publicCalls = 0;
  const unexpected = async () => { throw new Error('Unexpected fallback call'); };
  const route = createShopeeProductMetaHandler({
    getMetadata: async () => cached,
    saveMetadata: async (shopId, itemId, metadata, options) => {
      cached = { shopId, itemId, title: metadata.title, image: metadata.image, source: options.source };
      return { saved: true, metadata: cached };
    },
    fetchPublic: async () => { publicCalls++; return { status: 'resolved', metadata: {
      title: 'Kính camera', image: 'https://down-vn.img.susercontent.com/file/product-cover-123456789' } }; },
    fetchPage: unexpected, fetchItemApi: unexpected, fetchActor: unexpected, fetchSeo: unexpected
  });
  const request = { method: 'POST', headers: { host: 'realview.com.vn' }, body: {
    url: 'https://shopee.vn/product/452200291/17701438002', metadataTicket: createShopeeMetadataTicket('452200291', '17701438002')
  } };
  const response = () => ({ setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } });
  try {
    const first = response(); await route(request, first);
    assert.equal(first.body.status, 'resolved');
    assert.equal(first.body.metadata.source, 'bangiare-exact-id');
    const second = response(); await route(request, second);
    assert.equal(second.body.status, 'cached');
    assert.equal(publicCalls, 1);
    const read = response(); await route({ method: 'GET', headers: {}, url: `/api/shopee-product-meta?url=${encodeURIComponent(request.body.url)}` }, read);
    assert.equal(read.body.metadata.image, cached.image);
    assert.equal(publicCalls, 1);
  } finally {
    if (oldSecret === undefined) delete process.env.RESULT_CONTEXT_SIGNING_SECRET;
    else process.env.RESULT_CONTEXT_SIGNING_SECRET = oldSecret;
  }
});

test('invalid ticket, cross-origin and unsafe URLs cannot start metadata requests', async () => {
  let publicCalls = 0;
  const route = createShopeeProductMetaHandler({
    getMetadata: async () => null,
    fetchPublic: async () => { publicCalls++; return { status: 'empty' }; }
  });
  const base = { method: 'POST', headers: { host: 'realview.com.vn' },
    body: { url: 'https://shopee.vn/product/452200291/17701438002', metadataTicket: 'invalid' } };
  const cases = [
    [base, 403],
    [{ ...base, headers: { ...base.headers, origin: 'https://other.example' } }, 403],
    [{ ...base, body: { ...base.body, url: 'https://user:pass@shopee.vn/product/452200291/17701438002' } }, 400],
    [{ ...base, body: { ...base.body, url: 'https://shopee.vn:8443/product/452200291/17701438002' } }, 400],
    [{ ...base, body: { ...base.body, url: 'https://shopee.vn/product/452200291/12345678901234567890123456' } }, 400]
  ];
  for (const [request, expected] of cases) {
    const response = { setHeader() {}, status(code) { this.statusCode = code; return this; }, json() {} };
    await route(request, response);
    assert.equal(response.statusCode, expected);
  }
  assert.equal(publicCalls, 0);
});

test('verified metadata still reaches result if the cache write fails', async () => {
  const oldSecret = process.env.RESULT_CONTEXT_SIGNING_SECRET;
  process.env.RESULT_CONTEXT_SIGNING_SECRET = 'public-metadata-cache-failure-test';
  let actorCalls = 0;
  const metadata = { title: 'Kính camera', image: 'https://down-vn.img.susercontent.com/file/product-cover-123456789' };
  const route = createShopeeProductMetaHandler({
    getMetadata: async () => null,
    saveMetadata: async () => { throw new Error('Cache unavailable'); },
    fetchPublic: async () => ({ status: 'resolved', metadata }),
    fetchActor: async () => { actorCalls++; return { status: 'empty' }; }
  });
  const response = { setHeader() {}, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; } };
  try {
    await route({ method: 'POST', headers: { host: 'realview.com.vn' }, body: {
      url: 'https://shopee.vn/product/452200291/17701438002',
      metadataTicket: createShopeeMetadataTicket('452200291', '17701438002')
    } }, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body.metadata, metadata);
    assert.equal(actorCalls, 0);
  } finally {
    if (oldSecret === undefined) delete process.env.RESULT_CONTEXT_SIGNING_SECRET;
    else process.env.RESULT_CONTEXT_SIGNING_SECRET = oldSecret;
  }
});
