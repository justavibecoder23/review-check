import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getTikTokProductId, resolveTikTokProductUrl } from '../src/tiktok-url.mjs';

test('đọc product ID từ link TikTok Shop đầy đủ', async () => {
  const result = await resolveTikTokProductUrl('https://www.tiktok.com/shop/pdp/tai-nghe/1729384756102938475?region=VN');
  assert.equal(result.productId, '1729384756102938475');
  assert.equal(result.wasShortened, false);
});

test('đọc product ID từ link TikTok Shop Việt Nam có tiền tố /vn/pdp', async () => {
  const result = await resolveTikTokProductUrl(
    'https://shop.tiktok.com/vn/pdp/binh-nuoc-lucky-1000ml-hinh-cho-va-meo-giu-nhiet-4-6-tieng/1732811145572746350?source=ecommerce_mall'
  );
  assert.equal(result.productId, '1732811145572746350');
  assert.equal(result.wasShortened, false);
});

test('đọc product ID từ query của link TikTok', () => {
  assert.equal(
    getTikTokProductId('https://www.tiktok.com/view/product/landing?product_id=1729384756102938475'),
    '1729384756102938475'
  );
});

test('khôi phục product ID sau redirect của vt.tiktok.com', async () => {
  const fetchImpl = async (url, options) => {
    assert.equal(url.href, 'https://vt.tiktok.com/ZSFdemo/');
    assert.equal(options.redirect, 'manual');
    return new Response(null, {
      status: 302,
      headers: { location: 'https://www.tiktok.com/view/product/1729384756102938475?region=VN' }
    });
  };
  const result = await resolveTikTokProductUrl('https://vt.tiktok.com/ZSFdemo/', { fetchImpl });
  assert.equal(result.productId, '1729384756102938475');
  assert.equal(result.wasShortened, true);
  assert.equal(result.redirectCount, 1);
});

test('theo tiếp redirect trung gian www.tiktok.com/t để lấy product ID', async () => {
  const targets = new Map([
    ['https://vm.tiktok.com/demo/', 'https://www.tiktok.com/t/ZTdemo/'],
    ['https://www.tiktok.com/t/ZTdemo/', 'https://shop.tiktok.com/view/product/1729384756102938475']
  ]);
  const result = await resolveTikTokProductUrl('https://vm.tiktok.com/demo/', {
    fetchImpl: async (url) => new Response(null, { status: 302, headers: { location: targets.get(url.href) } })
  });
  assert.equal(result.productId, '1729384756102938475');
  assert.equal(result.redirectCount, 2);
});

test('chặn link rút gọn TikTok chuyển hướng ra ngoài TikTok', async () => {
  await assert.rejects(
    resolveTikTokProductUrl('https://vm.tiktok.com/demo/', {
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://example.com/private' } })
    }),
    /ra ngoài miền TikTok/
  );
});

test('form chấp nhận link share thiếu HTTPS để backend tự chuẩn hóa', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="product-url"[^>]+type="text"[^>]+inputmode="url"/);
  assert.match(html, /Shopee hoặc TikTok Shop/);
});
