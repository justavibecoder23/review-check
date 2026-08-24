import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractMarketplaceUrl,
  getShopeeProductIds,
  resolveShopeeProductUrl
} from '../src/shopee-url.mjs';

test('đọc link sản phẩm dài có hậu tố -i.shopId.itemId', async () => {
  const result = await resolveShopeeProductUrl(
    'https://shopee.vn/Kinh-cuong-luc-i.452200291.17701438002?extraParams=demo'
  );

  assert.equal(result.shopId, '452200291');
  assert.equal(result.itemId, '17701438002');
  assert.equal(result.canonicalUrl, 'https://shopee.vn/product-i.452200291.17701438002');
  assert.equal(result.wasShortened, false);
});

test('đọc URL /product/shopId/itemId', () => {
  assert.deepEqual(
    getShopeeProductIds('https://shopee.vn/product/452200291/17701438002'),
    { shopId: '452200291', itemId: '17701438002' }
  );
});

test('đọc URL đích di động /ten-shop/shopId/itemId', () => {
  assert.deepEqual(
    getShopeeProductIds('https://shopee.vn/opaanlp/186608798/27571059813?__mobile__=1'),
    { shopId: '186608798', itemId: '27571059813' }
  );
});

test('tách URL khi nội dung sao chép từ ứng dụng có kèm văn bản', () => {
  assert.equal(
    extractMarketplaceUrl('Sản phẩm đang giảm giá: https://s.shopee.vn/4AyF5bMwAe Mua ngay!'),
    'https://s.shopee.vn/4AyF5bMwAe'
  );
});

test('theo redirect s.shopee.vn và chuẩn hóa URL đích mới', async () => {
  const fetchImpl = async (url, options) => {
    assert.equal(url.href, 'https://s.shopee.vn/4AyF5bMwAe');
    assert.equal(options.redirect, 'manual');
    return new Response(null, {
      status: 301,
      headers: { location: 'https://shopee.vn/opaanlp/186608798/27571059813?utm_source=share' }
    });
  };

  const result = await resolveShopeeProductUrl('https://s.shopee.vn/4AyF5bMwAe', { fetchImpl });
  assert.equal(result.canonicalUrl, 'https://shopee.vn/product-i.186608798.27571059813');
  assert.equal(result.redirectCount, 1);
  assert.equal(result.wasShortened, true);
});

test('theo nhiều redirect của vn.shp.ee', async () => {
  const responses = new Map([
    ['https://vn.shp.ee/demo', 'https://s.shopee.vn/demo2'],
    ['https://s.shopee.vn/demo2', 'https://shopee.vn/product/452200291/17701438002']
  ]);
  const fetchImpl = async (url) => new Response(null, {
    status: 302,
    headers: { location: responses.get(url.href) }
  });

  const result = await resolveShopeeProductUrl('https://vn.shp.ee/demo', { fetchImpl });
  assert.equal(result.canonicalUrl, 'https://shopee.vn/product-i.452200291.17701438002');
  assert.equal(result.redirectCount, 2);
});

test('đọc origin_link trong link affiliate mà không cần gọi mạng', async () => {
  let called = false;
  const origin = encodeURIComponent('https://shopee.vn/product/452200291/17701438002');
  const result = await resolveShopeeProductUrl(
    `https://shope.ee/an_redir?origin_link=${origin}`,
    { fetchImpl: async () => { called = true; throw new Error('không được gọi'); } }
  );

  assert.equal(called, false);
  assert.equal(result.canonicalUrl, 'https://shopee.vn/product-i.452200291.17701438002');
});

test('chặn redirect ra ngoài miền Shopee', async () => {
  const fetchImpl = async () => new Response(null, {
    status: 302,
    headers: { location: 'https://example.com/private' }
  });

  await assert.rejects(
    resolveShopeeProductUrl('https://s.shopee.vn/demo', { fetchImpl }),
    /ra ngoài miền Shopee/
  );
});

test('không chấp nhận link rút gọn dẫn đến trang shop thay vì sản phẩm', async () => {
  const fetchImpl = async () => new Response(null, {
    status: 301,
    headers: { location: 'https://shopee.vn/moc2moc92?utm_source=share' }
  });

  await assert.rejects(
    resolveShopeeProductUrl('https://s.shopee.vn/shop-demo', { fetchImpl }),
    /không dẫn đến một sản phẩm/
  );
});
