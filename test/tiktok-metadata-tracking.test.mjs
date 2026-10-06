import test from 'node:test';
import assert from 'node:assert/strict';
import { productMetadataUrls, fetchProductPageMetaCandidates } from '../src/sources.mjs';

const productId = '1731975048230963363';
const clean = `https://shop.tiktok.com/vn/pdp/${productId}`;
const tracked = `${clean}?source=ecommerce_category&enter_method=feed_list_category_products&first_entrance=bing&btm_pre=a18064.b8314&btm_transfer_id=session-id`;
const image = 'https://p16-oec-sg.ibyteimg.com/tos-alisg-i-aphluv4xwc-sg/1325cb80d5b24842abbbac32f88df98e~tplv-aphluv4xwc-resize-webp:800:800.webp';

test('tracking-free exact PDP is preferred without losing the original URL', () => {
  assert.deepEqual(productMetadataUrls(tracked, { platform: 'TikTok Shop', productId }), [clean, tracked]);
  const identity = `https://www.tiktok.com/view/product/${productId}?product_id=${productId}&sku_id=123&utm_source=share`;
  const urls = productMetadataUrls(identity, { platform: 'TikTok Shop', productId });
  assert.equal(new URL(urls[0]).searchParams.get('product_id'), productId);
  assert.equal(new URL(urls[0]).searchParams.get('sku_id'), '123');
  assert.equal(new URL(urls[0]).searchParams.has('utm_source'), false);
});

test('the reported product gets its cover instead of an HTTP 200 Security Check', async () => {
  const calls = [];
  const metadata = await fetchProductPageMetaCandidates(productMetadataUrls(tracked, { platform: 'TikTok Shop', productId }), {
    expectedProductId: productId, timeoutMs: 3000, totalTimeoutMs: 6500,
    fetchImpl: async url => {
      calls.push(url);
      return new Response(url === clean
        ? `<meta property="og:title" content="Quạt cầm tay 3 trong 1"><meta property="og:image" content="${image}">`
        : '<title>Security Check</title>', { headers: { 'Content-Type': 'text/html' } });
    }
  });
  assert.equal(metadata.image, image);
  assert.deepEqual(calls, [clean]);
});

test('a clean PDP redirecting to another product never contributes an image', async () => {
  const metadata = await fetchProductPageMetaCandidates([clean], {
    expectedProductId: productId,
    fetchImpl: async url => url === clean
      ? new Response('', { status: 302, headers: { location: 'https://shop.tiktok.com/vn/pdp/1731975048230963364' } })
      : new Response(`<meta property="og:image" content="${image}">`, { headers: { 'Content-Type': 'text/html' } })
  });
  assert.deepEqual(metadata, {});
});
