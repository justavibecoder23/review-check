import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const blogHtml = await readFile(new URL('../public/blog.html', import.meta.url), 'utf8');
const articleHtml = await readFile(new URL('../public/blog/cach-doc-review-thong-minh.html', import.meta.url), 'utf8');
const navJs = await readFile(new URL('../public/nav.js', import.meta.url), 'utf8');
const robotsTxt = await readFile(new URL('../public/robots.txt', import.meta.url), 'utf8');
const sitemapXml = await readFile(new URL('../public/sitemap.xml', import.meta.url), 'utf8');

test('blog hub has crawlable metadata and one primary heading', () => {
  assert.match(blogHtml, /<link rel="canonical" href="https:\/\/www\.realview\.com\.vn\/blog\.html"/);
  assert.match(blogHtml, /"@type": "CollectionPage"/);
  assert.equal((blogHtml.match(/<h1\b/g) || []).length, 1);
  assert.match(blogHtml, /href="\/blog\/cach-doc-review-thong-minh\.html"/);
  assert.match(blogHtml, /property="og:image"/);
  assert.match(blogHtml, /name="twitter:card" content="summary_large_image"/);
});

test('published article has Article and breadcrumb structured data', () => {
  assert.match(articleHtml, /"@type": "BlogPosting"/);
  assert.match(articleHtml, /"@type": "BreadcrumbList"/);
  assert.equal((articleHtml.match(/<h1\b/g) || []).length, 1);
  assert.match(articleHtml, /"publisher"[\s\S]+"logo"/);
  assert.match(articleHtml, /property="og:image"/);
  assert.doesNotMatch(articleHtml, /https:\/\/realview\.com\.vn\//);
});

test('shared navigation exposes the Blog route', () => {
  assert.match(navJs, /href="\/blog\.html"/);
  assert.doesNotMatch(navJs, /Blog <small>Sắp ra mắt<\/small>/);
});

test('sitemap and robots use the canonical www host and expose published Blog URLs', () => {
  assert.match(robotsTxt, /Disallow: \/api\//);
  assert.match(robotsTxt, /Sitemap: https:\/\/www\.realview\.com\.vn\/sitemap\.xml/);
  assert.match(sitemapXml, /https:\/\/www\.realview\.com\.vn\/blog\.html/);
  assert.match(sitemapXml, /https:\/\/www\.realview\.com\.vn\/blog\/cach-doc-review-thong-minh\.html/);
  assert.doesNotMatch(sitemapXml, /https:\/\/realview\.com\.vn\//);
  assert.doesNotMatch(sitemapXml, /results\.html/);
});
