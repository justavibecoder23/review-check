import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const blogHtml = await readFile(new URL('../public/blog.html', import.meta.url), 'utf8');
const trustScoreArticleHtml = await readFile(new URL('../public/blog/trustscore-la-gi.html', import.meta.url), 'utf8');
const reviewReliabilityArticleHtml = await readFile(new URL('../public/blog/kiem-tra-do-tin-cay-review-truoc-khi-mua-hang.html', import.meta.url), 'utf8');
const blogStyles = await readFile(new URL('../public/blog.css', import.meta.url), 'utf8');
const navJs = await readFile(new URL('../public/nav.js', import.meta.url), 'utf8');
const robotsTxt = await readFile(new URL('../public/robots.txt', import.meta.url), 'utf8');
const sitemapXml = await readFile(new URL('../public/sitemap.xml', import.meta.url), 'utf8');

function structuredData(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((match) => JSON.parse(match[1]));
}

test('blog hub publishes exactly two articles and features the five-star review article', () => {
  assert.match(blogHtml, /<link rel="canonical" href="https:\/\/www\.realview\.com\.vn\/blog\.html"/);
  assert.equal((blogHtml.match(/<h1\b/g) || []).length, 1);
  assert.equal((blogHtml.match(/data-blog-card/g) || []).length, 2);
  assert.match(blogHtml, /class="featured-post"[\s\S]*?href="\/blog\/kiem-tra-do-tin-cay-review-truoc-khi-mua-hang\.html"/);
  assert.match(blogHtml, /Review 5 sao có đáng tin không\?/);
  assert.match(blogHtml, /href="\/blog\/trustscore-la-gi\.html"/);
  assert.doesNotMatch(blogHtml, /cach-doc-review-thong-minh/);
  assert.doesNotMatch(blogHtml, /Bài viết sắp xuất bản/);
  const collection = structuredData(blogHtml).find((item) => item['@type'] === 'CollectionPage');
  assert.equal(collection.mainEntity.numberOfItems, 2);
  assert.equal(collection.mainEntity.itemListElement.length, 2);
});

test('blog images fit their frames and the article CTA uses RealView orange', () => {
  assert.match(blogStyles, /\.blog-hero h1 \{[^}]*line-height: 1\.08;/);
  assert.match(blogStyles, /\.featured-post-image img \{[^}]*object-fit: contain;[^}]*object-position: center;/);
  assert.match(blogStyles, /\.post-card > img,[^}]*object-fit: contain;[^}]*object-position: center;/);
  assert.match(blogStyles, /\.article-content \.article-source-cta \{[^}]*width: fit-content;[^}]*max-width: calc\(100% - 32px\);[^}]*margin: 0 auto 19px;[^}]*background: var\(--orange\);[^}]*color: var\(--ink\);/);
  assert.match(blogStyles, /\.article-source-cta a \{[^}]*color: var\(--ink\);[^}]*text-decoration: none;/);
});

test('both long-form articles retain complete source content and SEO metadata', () => {
  const articles = [
    {
      html: trustScoreArticleHtml,
      canonical: 'https://www.realview.com.vn/blog/trustscore-la-gi.html',
      otherPath: '/blog/kiem-tra-do-tin-cay-review-truoc-khi-mua-hang.html',
      minimumWords: 3300,
      required: ['Công thức điểm cá thể', '5 điều cần nhớ về TrustScore', 'Thông tin xuất bản'],
    },
    {
      html: reviewReliabilityArticleHtml,
      canonical: 'https://www.realview.com.vn/blog/kiem-tra-do-tin-cay-review-truoc-khi-mua-hang.html',
      otherPath: '/blog/trustscore-la-gi.html',
      minimumWords: 3500,
      required: ['5 dấu hiệu giúp kiểm tra độ tin cậy của review', 'Cách sử dụng RealView', 'Thông tin xuất bản'],
    },
  ];

  for (const { html, canonical, otherPath, minimumWords, required } of articles) {
    const data = structuredData(html);
    const article = data.find((item) => item['@type'] === 'BlogPosting');
    assert.ok(article);
    assert.equal(article.mainEntityOfPage, canonical);
    assert.equal((html.match(/<h1\b/g) || []).length, 1);
    assert.match(html, new RegExp(`href="${otherPath.replaceAll('/', '\\/')}"`));
    assert.match(html, /property="og:image"/);
    assert.match(html, /name="twitter:card" content="summary_large_image"/);
    const wordCount = Number(html.match(/data-source-word-count="(\d+)"/)?.[1]);
    assert.ok(wordCount >= minimumWords, `source content unexpectedly short: ${wordCount}`);
    for (const text of required) assert.match(html, new RegExp(text));
  }
});

test('shared navigation exposes the Blog route', () => {
  assert.match(navJs, /href="\/blog\.html"/);
  assert.doesNotMatch(navJs, /Blog <small>Sắp ra mắt<\/small>/);
});

test('sitemap and robots expose only the two published Blog articles', () => {
  assert.match(robotsTxt, /Sitemap: https:\/\/www\.realview\.com\.vn\/sitemap\.xml/);
  assert.match(sitemapXml, /https:\/\/www\.realview\.com\.vn\/blog\.html/);
  assert.match(sitemapXml, /https:\/\/www\.realview\.com\.vn\/blog\/trustscore-la-gi\.html/);
  assert.match(sitemapXml, /https:\/\/www\.realview\.com\.vn\/blog\/kiem-tra-do-tin-cay-review-truoc-khi-mua-hang\.html/);
  assert.doesNotMatch(sitemapXml, /cach-doc-review-thong-minh/);
  assert.doesNotMatch(sitemapXml, /https:\/\/realview\.com\.vn\//);
  assert.doesNotMatch(sitemapXml, /results\.html/);
  assert.match(sitemapXml, /xmlns:image="http:\/\/www\.google\.com\/schemas\/sitemap-image\/1\.1"/);
});
