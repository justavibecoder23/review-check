import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const blogHtml = await readFile(new URL('../public/blog.html', import.meta.url), 'utf8');
const articleHtml = await readFile(new URL('../public/blog/cach-doc-review-thong-minh.html', import.meta.url), 'utf8');
const navJs = await readFile(new URL('../public/nav.js', import.meta.url), 'utf8');

test('blog hub has crawlable metadata and one primary heading', () => {
  assert.match(blogHtml, /<link rel="canonical" href="https:\/\/realview\.com\.vn\/blog\.html"/);
  assert.match(blogHtml, /"@type": "CollectionPage"/);
  assert.equal((blogHtml.match(/<h1\b/g) || []).length, 1);
  assert.match(blogHtml, /href="\/blog\/cach-doc-review-thong-minh\.html"/);
});

test('published article has Article and breadcrumb structured data', () => {
  assert.match(articleHtml, /"@type": "Article"/);
  assert.match(articleHtml, /"@type": "BreadcrumbList"/);
  assert.equal((articleHtml.match(/<h1\b/g) || []).length, 1);
});

test('shared navigation exposes the Blog route', () => {
  assert.match(navJs, /href="\/blog\.html"/);
  assert.doesNotMatch(navJs, /Blog <small>Sắp ra mắt<\/small>/);
});
