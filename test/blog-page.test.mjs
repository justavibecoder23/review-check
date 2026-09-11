import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const blogHtml = await readFile(new URL('../public/blog.html', import.meta.url), 'utf8');
const articleHtml = await readFile(new URL('../public/blog/cach-doc-review-thong-minh.html', import.meta.url), 'utf8');
const navJs = await readFile(new URL('../public/nav.js', import.meta.url), 'utf8');
const robotsTxt = await readFile(new URL('../public/robots.txt', import.meta.url), 'utf8');
const sitemapXml = await readFile(new URL('../public/sitemap.xml', import.meta.url), 'utf8');

function structuredData(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((match) => JSON.parse(match[1]));
}

test('blog hub has crawlable metadata and one primary heading', () => {
  assert.match(blogHtml, /<link rel="canonical" href="https:\/\/www\.realview\.com\.vn\/blog\.html"/);
  assert.match(blogHtml, /"@type": "CollectionPage"/);
  assert.equal((blogHtml.match(/<h1\b/g) || []).length, 1);
  assert.match(blogHtml, /href="\/blog\/cach-doc-review-thong-minh\.html"/);
  assert.match(blogHtml, /property="og:image"/);
  assert.match(blogHtml, /name="twitter:card" content="summary_large_image"/);
  assert.match(blogHtml, /<h1 id="blog-title">Đọc review rõ hơn<br \/><span>Cân nhắc tốt hơn<\/span><\/h1>/);
  assert.match(blogHtml, /class="featured-post-image"[\s\S]*?<img[^>]+alt="Người dùng đọc review sản phẩm trước khi mua hàng online"/);
  assert.match(blogHtml, /id="gioi-thieu-blog"/);
});

test('published article has BlogPosting and breadcrumb structured data', () => {
  const data = structuredData(articleHtml);
  const article = data.find((item) => item['@type'] === 'BlogPosting');
  const breadcrumbs = data.find((item) => item['@type'] === 'BreadcrumbList');
  assert.ok(article);
  assert.ok(breadcrumbs);
  assert.equal((articleHtml.match(/<h1\b/g) || []).length, 1);
  assert.match(articleHtml, /"publisher"[\s\S]+"logo"/);
  assert.match(articleHtml, /property="og:image"/);
  const modifiedMeta = articleHtml.match(/property="article:modified_time" content="([^"]+)"/)?.[1];
  const visibleModifiedDate = articleHtml.match(/<time datetime="([^"]+)">Cập nhật ngày/)?.[1];
  assert.equal(modifiedMeta, article.dateModified);
  assert.equal(visibleModifiedDate, article.dateModified.slice(0, 10));
  assert.match(articleHtml, /rel="author" href="\/blog\.html#gioi-thieu-blog"/);
  assert.match(articleHtml, /id="summary-title"/);
  assert.match(articleHtml, /Checklist 5 bước đối chiếu nhanh/);
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
  assert.match(sitemapXml, /xmlns:image="http:\/\/www\.google\.com\/schemas\/sitemap-image\/1\.1"/);
  assert.match(sitemapXml, /<image:loc>https:\/\/www\.realview\.com\.vn\/assets\/photos\/pexels-monstera-production-9429449\.jpg<\/image:loc>/);
  assert.doesNotMatch(sitemapXml, /<image:(?:title|caption)>/);
  const articleLastmod = sitemapXml.match(/<loc>https:\/\/www\.realview\.com\.vn\/blog\/cach-doc-review-thong-minh\.html<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/)?.[1];
  const article = structuredData(articleHtml).find((item) => item['@type'] === 'BlogPosting');
  assert.equal(articleLastmod, article.dateModified.slice(0, 10));
});
