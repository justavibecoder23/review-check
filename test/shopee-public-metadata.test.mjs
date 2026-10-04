import test from 'node:test';
import assert from 'node:assert/strict';
import { extractShopeePublicMetadata, fetchShopeePublicMetadata, fetchShopeeSeoMetadata } from '../src/shopee-public-metadata.mjs';
import { PUBLIC_SHOP_ID as shopId, PUBLIC_ITEM_ID as itemId, PUBLIC_IMAGE as image, PUBLIC_TITLE as title,
  publicProductNode, publicProductHtml } from './fixtures/shopee-public-metadata.mjs';

const originalUrl = `https://shopee.vn/kinh-camera-i.${shopId}.${itemId}?extraParams=%7B%22display_model_id%22%3A276619436884%7D`;

test('public source binds title and product image to exact SKU, seller and canonical', () => {
  const metadata = extractShopeePublicMetadata(publicProductHtml(), shopId, itemId);
  assert.equal(metadata.title, title);
  assert.equal(metadata.image, image);
  assert.equal(metadata.source, 'bangiare-exact-id');
  assert.equal(extractShopeePublicMetadata(publicProductHtml(), '1', itemId), null);
  assert.equal(extractShopeePublicMetadata(publicProductHtml(), shopId, '1'), null);
});

test('rejects wrong SKU, wrong seller, missing identity and recommendation-only pages', () => {
  for (const node of [
    publicProductNode({ sku: `1__${itemId}__99` }),
    publicProductNode({ offers: { seller: { url: `https://shopee.vn/shop/${shopId}` } } }),
    publicProductNode({ offers: { seller: { url: 'https://shopee.vn/shop/99',
      identifier: { propertyID: 'Shopee shop ID', value: shopId } } } }),
    publicProductNode({ url: 'https://bangiare.com/other-zk1.1.2.html' }),
    { '@type': 'ItemList', itemListElement: [publicProductNode()] }
  ]) assert.equal(extractShopeePublicMetadata(publicProductHtml(node), shopId, itemId), null);
  assert.equal(extractShopeePublicMetadata(publicProductHtml(undefined, 'https://bangiare.com/category.html'), shopId, itemId), null);
});

test('only valid main Product is accepted in @graph; malformed JSON is harmless', () => {
  const graph = { '@graph': [publicProductNode({ sku: 'other', image: ['https://example.com/review.jpg'] }), publicProductNode()] };
  assert.equal(extractShopeePublicMetadata(publicProductHtml(graph), shopId, itemId).image, image);
  assert.equal(extractShopeePublicMetadata('<script type="application/ld+json">{broken</script>', shopId, itemId), null);
});

test('rejects challenge, title-only data, shop logos, Blob and credentialed images', () => {
  for (const override of [
    { name: 'Security Check' }, { name: '<img src=x onerror=alert(1)>' }, { image: [] },
    { image: ['https://example.com/review.jpg'] }, { image: ['https://abc.public.blob.vercel-storage.com/image.webp'] },
    { image: ['https://down-vn.img.susercontent.com/logo.svg'] },
    { image: ['https://user:pass@down-vn.img.susercontent.com/file/valid-image-123456789'] }
  ]) assert.equal(extractShopeePublicMetadata(publicProductHtml(publicProductNode(override)), shopId, itemId), null);
});

test('fetches fixed ID URL only, never downloads images or follows source redirects', async () => {
  const calls = [];
  const result = await fetchShopeePublicMetadata(originalUrl, { fetchImpl: async (url, init) => {
    calls.push(url);
    assert.equal(init.redirect, 'manual');
    return new Response(publicProductHtml(), { headers: { 'content-type': 'text/html' } });
  } });
  assert.equal(result.metadata.image, image);
  assert.deepEqual(calls, [`https://bangiare.com/san-pham-zk1.${itemId}.${shopId}.html`]);
  const redirect = await fetchShopeePublicMetadata(originalUrl, { fetchImpl: async () => new Response('', {
    status: 302, headers: { location: 'http://127.0.0.1/private' }
  }) });
  assert.equal(redirect.status, 'failed');
});

test('invalid input/identity and disabled flag never issue a request', async () => {
  const fetchImpl = () => { throw new Error('Unexpected request'); };
  assert.equal((await fetchShopeePublicMetadata('https://evil.example/product/1/2', { fetchImpl })).status, 'id_mismatch');
  assert.equal((await fetchShopeePublicMetadata(originalUrl, { shopId: '99', fetchImpl })).status, 'id_mismatch');
  assert.equal((await fetchShopeePublicMetadata(originalUrl, { env: { SHOPEE_PUBLIC_METADATA_ENABLED: 'false' }, fetchImpl })).status, 'disabled');
});

test('bounded streamed response and timeout return failures without accepting metadata', async () => {
  const large = await fetchShopeePublicMetadata(originalUrl, { fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1), { headers: { 'content-type': 'text/html' } }) });
  assert.equal(large.status, 'failed');
  const timeout = await fetchShopeePublicMetadata(originalUrl, { fetchImpl: async () => { throw new DOMException('Timed out', 'TimeoutError'); } });
  assert.equal(timeout.status, 'timeout');
  const wrong = await fetchShopeePublicMetadata(originalUrl, { fetchImpl: async () => new Response(publicProductHtml(publicProductNode({ sku: 'wrong' })), { headers: { 'content-type': 'text/html' } }) });
  assert.equal(wrong.status, 'empty');
});

test('SEO is opt-in and revalidates candidate HTML; similar products are rejected', async () => {
  const calls = [];
  const env = { SHOPEE_METADATA_SEO_ENABLED: 'true', SERPAPI_API_KEY: 'private-test-key' };
  const diagnostics = [];
  const result = await fetchShopeeSeoMetadata(originalUrl, { env, onDiagnostic: (entry) => diagnostics.push(entry), fetchImpl: async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('https://serpapi.com/')) return Response.json({ organic_results: [
      { link: 'https://bangiare.com/similar-zk1.99.88.html', title: title, thumbnail: image },
      { link: publicProductNode().url, title: 'Untrusted snippet', thumbnail: 'https://example.com/wrong.jpg' }
    ] });
    return new Response(publicProductHtml(), { headers: { 'content-type': 'text/html' } });
  } });
  assert.equal(result.metadata.title, title);
  assert.equal(calls.length, 2);
  assert.equal(JSON.stringify(diagnostics).includes('private-test-key'), false);
  const disabled = await fetchShopeeSeoMetadata(originalUrl, { env: { SERPAPI_API_KEY: 'test' },
    fetchImpl: () => { throw new Error('Must not spend search quota'); } });
  assert.equal(disabled.status, 'disabled');
});

test('SEO limits two queries and three verified-host candidate fetches', async () => {
  let queries = 0;
  let pages = 0;
  const result = await fetchShopeeSeoMetadata(originalUrl, { env: { SHOPEE_METADATA_SEO_ENABLED: 'true', SERPAPI_API_KEY: 'test' }, fetchImpl: async (url) => {
    if (String(url).startsWith('https://serpapi.com/')) {
      queries++;
      return Response.json({ organic_results: Array.from({ length: 5 }, (_, i) => ({
        link: `https://bangiare.com/candidate-${i}-zk1.${itemId}.${shopId}.html`
      })) });
    }
    pages++;
    return new Response('<title>No verified product</title>');
  } });
  assert.equal(result.status, 'empty');
  assert.ok(queries <= 2);
  assert.equal(pages, 3);
});
