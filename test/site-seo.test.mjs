import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const indexablePages = new Map([
  ['index.html', 'https://www.realview.com.vn/'],
  ['criteria.html', 'https://www.realview.com.vn/tieu-chi-loc'],
  ['contact.html', 'https://www.realview.com.vn/lien-he'],
  ['blog.html', 'https://www.realview.com.vn/bai-viet'],
  ['blog/trustscore-la-gi.html', 'https://www.realview.com.vn/bai-viet/trustscore-la-gi'],
  ['blog/kiem-tra-do-tin-cay-review-truoc-khi-mua-hang.html', 'https://www.realview.com.vn/bai-viet/kiem-tra-do-tin-cay-review-truoc-khi-mua-hang'],
  ['blog/shopee-hay-tiktok-shop-mua-hang-o-dau-tot-hon.html', 'https://www.realview.com.vn/bai-viet/shopee-hay-tiktok-shop-mua-hang-o-dau-tot-hon'],
  ['blog/shopee-mall-la-gi-co-nen-mua-khong.html', 'https://www.realview.com.vn/bai-viet/shopee-mall-la-gi-co-nen-mua-khong'],
  ['blog/tiktok-shop-la-gi-mua-hang-tren-tiktok-co-an-toan-khong.html', 'https://www.realview.com.vn/bai-viet/tiktok-shop-la-gi-mua-hang-tren-tiktok-co-an-toan-khong'],
  ['blog/cach-tim-shop-uy-tin-tren-shopee.html', 'https://www.realview.com.vn/bai-viet/cach-tim-shop-uy-tin-tren-shopee']
]);

test('every indexable public page uses one canonical www URL', async () => {
  for (const [page, canonical] of indexablePages) {
    const html = await readFile(new URL(`../public/${page}`, import.meta.url), 'utf8');
    assert.equal((html.match(/rel="canonical"/g) || []).length, 1, `${page} must have one canonical`);
    assert.match(html, new RegExp(`<link rel="canonical" href="${canonical.replaceAll('.', '\\.')}"`));
    assert.match(html, /<meta name="robots" content="index,follow,max-image-preview:large"/);
    assert.match(html, /<meta property="og:url" content="https:\/\/www\.realview\.com\.vn\//);
    assert.match(html, /<meta property="og:image" content="https:\/\/www\.realview\.com\.vn\//);
    assert.match(html, /<meta property="og:image:alt" content="[^"]+"/);
    assert.match(html, /<meta name="twitter:card" content="summary_large_image"/);
    assert.match(html, /<meta name="twitter:image" content="https:\/\/www\.realview\.com\.vn\//);
    assert.match(html, /<meta name="twitter:image:alt" content="[^"]+"/);
  }
});

test('dynamic result pages are crawlable for discovery but excluded from the index', async () => {
  const html = await readFile(new URL('../public/results.html', import.meta.url), 'utf8');
  assert.match(html, /<meta name="robots" content="noindex,follow"/);
  assert.doesNotMatch(html, /rel="canonical"/);
});

test('Vietnamese public routes keep permanent redirects from legacy English URLs', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  const redirects = new Map(config.redirects.map(({ source, destination, permanent }) => [source, { destination, permanent }]));
  const expected = new Map([
    ['/criteria.html', '/tieu-chi-loc'],
    ['/contact.html', '/lien-he'],
    ['/blog.html', '/bai-viet'],
    ['/blog/trustscore-la-gi.html', '/bai-viet/trustscore-la-gi'],
    ['/blog/kiem-tra-do-tin-cay-review-truoc-khi-mua-hang.html', '/bai-viet/kiem-tra-do-tin-cay-review-truoc-khi-mua-hang'],
    ['/blog/shopee-hay-tiktok-shop-mua-hang-o-dau-tot-hon.html', '/bai-viet/shopee-hay-tiktok-shop-mua-hang-o-dau-tot-hon'],
    ['/blog/shopee-mall-la-gi-co-nen-mua-khong.html', '/bai-viet/shopee-mall-la-gi-co-nen-mua-khong'],
    ['/blog/tiktok-shop-la-gi-mua-hang-tren-tiktok-co-an-toan-khong.html', '/bai-viet/tiktok-shop-la-gi-mua-hang-tren-tiktok-co-an-toan-khong'],
    ['/blog/cach-tim-shop-uy-tin-tren-shopee.html', '/bai-viet/cach-tim-shop-uy-tin-tren-shopee'],
    ['/results.html', '/ket-qua'],
  ]);

  for (const [source, destination] of expected) {
    assert.deepEqual(redirects.get(source), { destination, permanent: true });
  }
});
