import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshShopeeProductMetadata } from '../public/shopee-metadata-loader.js';
import handler from '../api/match-counterpart.mjs';
const product = { platform: 'Shopee', url: 'https://shopee.vn/product-i.233692311.4819028193', shopId: '233692311', itemId: '4819028193' };

test('late image polling reads metadata only and verifies exact product identity', async () => {
  let calls = 0;
  const result = await refreshShopeeProductMetadata(product, {
    pauseImpl: async () => {},
    fetchImpl: async (url) => {
      assert.match(url, /operation=product-metadata/);
      return new Response(JSON.stringify(++calls === 1 ? { status: 'pending' } : {
        status: 'ready', product: { ...product, image: 'https://down-vn.img.susercontent.com/file/verified-cover' }
      }));
    }
  });
  assert.equal(calls, 2);
  assert.ok(result.image);
  assert.equal(await refreshShopeeProductMetadata(product, {
    fetchImpl: async () => new Response(JSON.stringify({ product: { itemId: '999', shopId: product.shopId, image: 'wrong' } }))
  }), null);
});

test('image polling stops on unavailable metadata and never restarts actor work', async () => {
  let calls = 0;
  assert.equal(await refreshShopeeProductMetadata(product, {
    fetchImpl: async () => { calls++; return new Response(JSON.stringify({ status: 'unavailable' })); }
  }), null);
  assert.equal(calls, 1);
});

test('metadata endpoint is a read-only GET and rejects foreign URLs', async () => {
  for (const [method, query, expected] of [
    ['GET', product.url, 200], ['GET', 'https://example.com/product-i.233692311.4819028193', 400], ['POST', product.url, 405]
  ]) {
    let value;
    const response = { setHeader() {}, end(body) { value = JSON.parse(body); } };
    await handler({ method, headers: {}, url: '/api/match-counterpart?operation=product-metadata&sourceUrl=' + encodeURIComponent(query) }, response);
    assert.equal(response.statusCode, expected);
    if (expected === 200) assert.equal(value.product.itemId, product.itemId);
  }
});
