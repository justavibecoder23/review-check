import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const articles = [
  ['shopee-hay-tiktok-shop-mua-hang-o-dau-tot-hon', 'shopee-hay-tiktok-shop.jpg', 1900],
  ['shopee-mall-la-gi-co-nen-mua-khong', 'shopee-mall-la-gi.jpg', 2200],
  ['tiktok-shop-la-gi-mua-hang-tren-tiktok-co-an-toan-khong', 'tiktok-shop-la-gi.jpg', 1950],
  ['cach-tim-shop-uy-tin-tren-shopee', 'cach-tim-shop-uy-tin-tren-shopee.jpg', 2900],
];

test('four new SEO articles expose complete long-form content and valid metadata', async () => {
  for (const [slug, thumbnail, minimumWords] of articles) {
    const page = await readFile(new URL(`../public/blog/${slug}.html`, import.meta.url), 'utf8');
    assert.equal((page.match(/<h1\b/g) || []).length, 1);
    assert.match(page, new RegExp(`<link rel="canonical" href="https://www\\.realview\\.com\\.vn/bai-viet/${slug}"`));
    assert.match(page, new RegExp(`class="article-lead-image" src="/assets/blog/${thumbnail.replace('.', '\\.')}`));
    assert.ok(Number(page.match(/data-source-word-count="(\d+)"/)?.[1]) >= minimumWords);
    assert.doesNotMatch(page, /Bài SEO \d+|Cụm chủ đề|Gắn link bài/);
    const jsonLd = [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) => JSON.parse(match[1]));
    const posting = jsonLd.find((item) => item['@type'] === 'BlogPosting');
    assert.equal(posting.mainEntityOfPage, `https://www.realview.com.vn/bai-viet/${slug}`);
    assert.ok(jsonLd.some((item) => item['@type'] === 'BreadcrumbList'));
    assert.ok(jsonLd.some((item) => item['@type'] === 'FAQPage'));
  }
});

test('all four article thumbnails are real JPEG files', async () => {
  for (const [, thumbnail] of articles) {
    const image = await readFile(new URL(`../public/assets/blog/${thumbnail}`, import.meta.url));
    assert.equal(image[0], 0xff);
    assert.equal(image[1], 0xd8);
    assert.equal(image.at(-2), 0xff);
    assert.equal(image.at(-1), 0xd9);
  }
});
