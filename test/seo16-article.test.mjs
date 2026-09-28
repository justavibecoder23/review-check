import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const slug = 'tieu-chi-danh-gia-cong-cu-check-review';
const publicRoot = new URL('../public/', import.meta.url);
const html = await readFile(new URL(`blog/snapshots/${slug}.html`, publicRoot), 'utf8');

test('SEO 16 is published as a complete, indexable blog article', async () => {
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.match(html, new RegExp(`<link rel="canonical" href="https://www\\.realview\\.com\\.vn/bai-viet/${slug}"`));
  assert.match(html, /<title>Tiêu chí đánh giá công cụ check review hiệu quả<\/title>/);
  assert.match(html, /name="description" content="Đâu là tiêu chí đánh giá công cụ check review hiệu quả\?/);
  assert.match(html, /data-article-toc/);
  for (const heading of [
    'Công cụ check review hiệu quả là gì?',
    '6 tiêu chí đánh giá công cụ check review',
    'Có nên chọn công cụ chỉ dựa vào Trust Score?',
    'RealView đáp ứng những tiêu chí nào?',
    'Kiểm tra review hiệu quả không chỉ nằm ở một con số'
  ]) assert.ok(html.includes(heading), `Missing heading: ${heading}`);
  const schemas = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) => JSON.parse(match[1]));
  assert.ok(schemas.some((schema) => schema['@type'] === 'BlogPosting'));
  const faq = schemas.find((schema) => schema['@type'] === 'FAQPage');
  assert.ok(faq);
  assert.equal(faq.mainEntity.length, 5);
  assert.match(html, /bai-viet\/trustscore-la-gi/);
  assert.match(html, /Đoàn Phan Anh Hào/);
});

test('SEO 16 images are local, optimized WebP files and appear in blog discovery surfaces', async () => {
  const imagePaths = [...new Set([...html.matchAll(/src="(\/assets\/blog\/seo16-[^"]+\.webp)"/g)].map((match) => match[1]))];
  assert.equal(imagePaths.length, 10);
  for (const imagePath of imagePaths) {
    const image = await readFile(new URL(imagePath.slice(1), publicRoot));
    assert.equal(image.toString('ascii', 0, 4), 'RIFF');
    assert.equal(image.toString('ascii', 8, 12), 'WEBP');
  }
  const [index, sitemap, manifest, config] = await Promise.all([
    readFile(new URL('blog/snapshots/index-snapshot.html', publicRoot), 'utf8'),
    readFile(new URL('blog/snapshots/sitemap-snapshot.xml', publicRoot), 'utf8'),
    readFile(new URL('blog/snapshots/snapshot-manifest.json', publicRoot), 'utf8'),
    readFile(new URL('../vercel.json', import.meta.url), 'utf8')
  ]);
  assert.match(index, new RegExp(`/bai-viet/${slug}`));
  assert.match(sitemap, new RegExp(`/bai-viet/${slug}`));
  assert.ok(JSON.parse(manifest).articles.some((article) => article.path === `blog/snapshots/${slug}.html`));
  assert.match(config, new RegExp(`"source": "/bai-viet/${slug}"`));
});
