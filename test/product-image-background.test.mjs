import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mirrorTikTokProductImage,
  productImageBackgroundInternals,
  scheduleProductImageMirror
} from '../src/product-image-background.mjs';

function redisFake() {
  const values = new Map();
  return {
    values,
    async fetchImpl(_url, init) {
      const command = JSON.parse(init.body);
      if (command[0] === 'GET') return { ok: true, async json() { return { result: values.get(command[1]) || null }; } };
      if (command[0] === 'SET') {
        values.set(command[1], command[2]);
        return { ok: true, async json() { return { result: 'OK' }; } };
      }
      throw new Error(`Unsupported Redis command ${command[0]}`);
    }
  };
}

function enableRedis(context) {
  const previousUrl = process.env.UPSTASH_REDIS_REST_URL;
  const previousToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  context.after(() => {
    if (previousUrl) process.env.UPSTASH_REDIS_REST_URL = previousUrl;
    else delete process.env.UPSTASH_REDIS_REST_URL;
    if (previousToken) process.env.UPSTASH_REDIS_REST_TOKEN = previousToken;
    else delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });
}

test('mirror ảnh TikTok sang Blob public và ghi URL ổn định vào metadata overlay', async (context) => {
  enableRedis(context);
  const redis = redisFake();
  const sourceImage = Buffer.from('<svg width="20" height="20" xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20" fill="orange"/></svg>');
  let uploaded;
  const result = await mirrorTikTokProductImage({
    platform: 'TikTok Shop',
    productId: '1731846286968456663',
    title: 'Kẹo me cay sấy muối',
    url: 'https://shop.tiktok.com/vn/pdp/keo-me/1731846286968456663',
    image: 'https://p16-oec-sg.ibyteimg.com/product.webp'
  }, {
    redisFetchImpl: redis.fetchImpl,
    blobToken: 'public-token',
    fetchImpl: async () => new Response(sourceImage, { status: 200, headers: { 'content-type': 'image/svg+xml' } }),
    blobPutImpl: async (pathname, data, options) => {
      uploaded = { pathname, data, options };
      return { url: `https://realview.public.blob.vercel-storage.com/${pathname}` };
    }
  });
  assert.equal(result.status, 'ready');
  assert.match(result.metadata.image, /\.public\.blob\.vercel-storage\.com\/product-media\/tiktok\//);
  assert.equal(uploaded.options.access, 'public');
  assert.equal(uploaded.options.contentType, 'image/webp');
  assert.ok(uploaded.data.length > 0);
});

test('mirror từ chối URL ảnh ngoài CDN TikTok', () => {
  assert.equal(productImageBackgroundInternals.trustedProductImageUrl('https://evil.example/image.jpg'), '');
  assert.equal(productImageBackgroundInternals.trustedTikTokProductUrl('https://evil.example/pdp/123'), '');
  assert.match(productImageBackgroundInternals.trustedProductImageUrl('https://p16-oec-sg.ibyteimg.com/a.webp'), /^https:/);
});

test('scheduler giao promise cho waitUntil mà không chờ việc tải ảnh hoàn thành', async () => {
  let background;
  const startedAt = Date.now();
  const scheduled = scheduleProductImageMirror({ platform: 'Shopee', itemId: '1' }, {
    waitUntilImpl: (promise) => { background = promise; }
  });
  assert.equal(scheduled, true);
  assert.ok(Date.now() - startedAt < 50);
  assert.equal((await background).status, 'skipped');
});
