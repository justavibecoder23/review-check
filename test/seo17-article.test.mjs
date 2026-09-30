import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const slug = 'check-review-truoc-khi-mua-hang';
const root = new URL('../public/', import.meta.url);
const html = await readFile(new URL(`blog/snapshots/${slug}.html`, root), 'utf8');

test('SEO 17 is published as a complete and indexable article with its requested outline', async () => {
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.match(html, new RegExp(`<link rel="canonical" href="https://www\\.realview\\.com\\.vn/bai-viet/${slug}"`));
  assert.match(html, /name="description" content="Khi nào nên check review trước khi mua\?/);
  assert.match(html, /data-article-toc/);
  const toc = html.match(/<nav class="article-toc-links"[^>]*><ol>([\s\S]*?)<\/ol><\/nav>/)?.[1] || '';
  const tocHeadings = [...toc.matchAll(/<a href="#[^"]+">([^<]+)<\/a>/g)].map((match) => match[1]);
  assert.deepEqual(tocHeadings, [
    'Check review trước khi mua là gì?',
    'Khi nào nên check review trước khi mua?',
    'Có nên check review của mọi sản phẩm trước khi mua?',
    '5 bước check review trước khi quyết định mua',
    'Check review có thay thế việc tự đọc review không?',
    'RealView có thể dùng như một bước kiểm tra bổ sung',
    'FAQ – Câu hỏi thường gặp về check review trước khi mua',
    'Bài viết liên quan'
  ]);
  for (const heading of tocHeadings) assert.ok(html.includes(heading), `Missing section: ${heading}`);
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
  for (const [, target] of html.matchAll(/<a href="#([^"]+)"/g)) assert.ok(ids.has(target), `Broken TOC anchor: ${target}`);
  const schemas = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) => JSON.parse(match[1]));
  assert.ok(schemas.some((schema) => schema['@type'] === 'BlogPosting'));
  const faq = schemas.find((schema) => schema['@type'] === 'FAQPage');
  assert.ok(faq);
  assert.equal(faq.mainEntity.length, 5);
  assert.match(html, /TrustScore không phải điểm chất lượng sản phẩm/);
});

test('SEO 17 images are local WebP assets and the article appears in the index, sitemap and Vercel route', async () => {
  const imagePaths = [...new Set([...html.matchAll(/src="(\/assets\/blog\/seo17\/[^\"]+\.webp)"/g)].map((match) => match[1]))];
  assert.ok(imagePaths.length >= 10);
  for (const imagePath of imagePaths) {
    const image = await readFile(new URL(imagePath.slice(1), root));
    assert.equal(image.toString('ascii', 0, 4), 'RIFF');
    assert.equal(image.toString('ascii', 8, 12), 'WEBP');
  }
  const [index, sitemap, manifest, config] = await Promise.all([
    readFile(new URL('blog/snapshots/index-snapshot.html', root), 'utf8'),
    readFile(new URL('blog/snapshots/sitemap-snapshot.xml', root), 'utf8'),
    readFile(new URL('blog/snapshots/snapshot-manifest.json', root), 'utf8'),
    readFile(new URL('../vercel.json', import.meta.url), 'utf8')
  ]);
  assert.match(index, new RegExp(`/bai-viet/${slug}`));
  assert.match(sitemap, new RegExp(`/bai-viet/${slug}`));
  assert.ok(JSON.parse(manifest).articles.some((article) => article.path === `blog/snapshots/${slug}.html`));
  assert.match(config, new RegExp(`"source": "/bai-viet/${slug}"`));
});
