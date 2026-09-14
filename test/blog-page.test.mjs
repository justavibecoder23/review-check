import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const blogHtml = await readFile(new URL('../public/blog.html', import.meta.url), 'utf8');
const trustScoreArticleHtml = await readFile(new URL('../public/blog/trustscore-la-gi.html', import.meta.url), 'utf8');
const reviewReliabilityArticleHtml = await readFile(new URL('../public/blog/kiem-tra-do-tin-cay-review-truoc-khi-mua-hang.html', import.meta.url), 'utf8');
const blogStyles = await readFile(new URL('../public/blog.css', import.meta.url), 'utf8');
const blogPostJs = await readFile(new URL('../public/blog-post.js', import.meta.url), 'utf8');
const navJs = await readFile(new URL('../public/nav.js', import.meta.url), 'utf8');
const robotsTxt = await readFile(new URL('../public/robots.txt', import.meta.url), 'utf8');
const sitemapXml = await readFile(new URL('../public/sitemap.xml', import.meta.url), 'utf8');
const articleDirectory = new URL('../public/blog/', import.meta.url);
const articleFiles = (await readdir(articleDirectory)).filter((name) => name.endsWith('.html')).sort();
const allArticlePages = await Promise.all(articleFiles.map(async (name) => ({
  name,
  html: await readFile(new URL(name, articleDirectory), 'utf8'),
})));

function structuredData(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((match) => JSON.parse(match[1]));
}

test('blog hub publishes six articles and features the five-star review article', () => {
  assert.match(blogHtml, /<link rel="canonical" href="https:\/\/www\.realview\.com\.vn\/bai-viet"/);
  assert.equal((blogHtml.match(/<h1\b/g) || []).length, 1);
  assert.equal((blogHtml.match(/data-blog-card/g) || []).length, 6);
  assert.match(blogHtml, /class="featured-post"[\s\S]*?href="\/bai-viet\/kiem-tra-do-tin-cay-review-truoc-khi-mua-hang"/);
  assert.match(blogHtml, /Review 5 sao có đáng tin không\?/);
  assert.match(blogHtml, /href="\/bai-viet\/trustscore-la-gi"/);
  assert.doesNotMatch(blogHtml, /cach-doc-review-thong-minh/);
  assert.doesNotMatch(blogHtml, /Bài viết sắp xuất bản/);
  const collection = structuredData(blogHtml).find((item) => item['@type'] === 'CollectionPage');
  assert.equal(collection.mainEntity.numberOfItems, 6);
  assert.equal(collection.mainEntity.itemListElement.length, 6);
});

test('blog images fit their frames and article CTA is a centered orange action', () => {
  assert.match(blogStyles, /\.blog-hero h1 \{[^}]*line-height: 1\.08;/);
  assert.match(blogStyles, /\.featured-post-image img \{[^}]*object-fit: contain;[^}]*object-position: center;/);
  assert.match(blogStyles, /\.post-card > img,[^}]*object-fit: contain;[^}]*object-position: center;/);
  assert.match(blogStyles, /\.article-sidebar-cta \{[^}]*width: min\(100%, 260px\);[^}]*margin: 28px auto 0;[^}]*display: flex;[^}]*justify-content: center;[^}]*border: 1\.5px solid #111827;[^}]*border-radius: 999px;[^}]*background: #fc781f;/);
  for (const { html } of allArticlePages) {
    assert.match(html, /class="article-sidebar-cta"[^>]*>Sử dụng RealView ngay/);
  }
});

test('article pages use an asymmetric reading grid with responsive metadata and scrollspy TOC', () => {
  assert.equal(allArticlePages.length, 6);
  for (const { name, html } of allArticlePages) {
    assert.match(html, /class="article-reading-grid"[\s\S]*?<h1 class="article-title">[\s\S]*?<aside class="article-sidebar"[\s\S]*?<details class="article-toc" data-article-toc>[\s\S]*?<p class="article-deck">[\s\S]*?<div class="article-body-column">/);
    assert.match(html, /<script src="\/blog-post\.js" defer><\/script>/);
    assert.doesNotMatch(html, /class="article-header"/);
    assert.match(html, /class="article-category"/);
    assert.match(html, /class="article-author"/);
    assert.match(html, /class="article-date"/);
    assert.match(html, /class="article-content"/, `${name} must use the shared Blog Post structure`);
  }
  assert.match(blogStyles, /\.article-shell \{[^}]*width: min\(1322px, calc\(100% - 48px\)\);[^}]*max-width: 1322px;[^}]*padding: 64px 80px;/);
  assert.match(blogStyles, /\.article-reading-grid \{[^}]*grid-template-columns: 280px minmax\(0, 800px\);[^}]*column-gap: 80px;/);
  assert.match(blogStyles, /\.article-sidebar \{[^}]*position: sticky;[^}]*top: 100px;[^}]*align-self: start;/);
  assert.match(blogStyles, /\.article-title \{[^}]*font-size: clamp\(48px, 4\.4vw, 56px\);[^}]*font-weight: 800;[^}]*line-height: 1\.2;/);
  assert.match(blogStyles, /\.article-content \{[^}]*max-width: 800px;[^}]*color: #374151;[^}]*font-size: 18px;[^}]*line-height: 1\.8;/);
  assert.match(blogStyles, /@media \(max-width: 1024px\) \{[\s\S]*?\.article-reading-grid \{[^}]*grid-template-columns: minmax\(0, 1fr\);[^}]*grid-template-rows: auto auto auto auto;/);
  assert.match(blogStyles, /\.article-toc-links a\.is-active \{[^}]*border-left-color: #fc781f;[^}]*color: #fc781f;[^}]*font-weight: 600;/);
  assert.match(blogPostJs, /IntersectionObserver/);
  assert.match(blogPostJs, /matchMedia\('\(min-width: 1025px\)'\)/);
  assert.match(blogPostJs, /toc\.removeAttribute\('open'\)/);
  assert.match(blogPostJs, /tocScroller\.scrollTo\(/);
  assert.match(blogPostJs, /lockActiveHeading\(heading\.id\)/);
  assert.match(blogPostJs, /distanceFromAnchor > 32/);
  assert.match(blogPostJs, /heading\.getBoundingClientRect\(\)\.top <= 180/);
});

test('article category and embedded content graphics retain their original formats', () => {
  assert.match(blogStyles, /\.article-category \{[^}]*padding: 7px 12px;[^}]*display: inline-flex;[^}]*border-radius: 999px;[^}]*background: #fff0e5;[^}]*color: var\(--orange-dark\);/);
  assert.match(blogStyles, /\.article-source-callout \{[^}]*padding: 24px 26px;[^}]*border: 1px solid rgba\(223,89,0,\.2\);[^}]*border-radius: 18px;[^}]*background: #fff8f2;/);
  assert.match(blogStyles, /\.article-table-wrap \{[^}]*border: 1px solid rgba\(22,22,22,\.1\);[^}]*border-radius: 18px;[^}]*background: white;/);
  assert.match(blogStyles, /\.article-table th \{[^}]*background: #fff3e9;/);
  assert.match(blogStyles, /\.article-formula \{[^}]*padding: 18px 20px;[^}]*border: 1px solid rgba\(223,89,0,\.22\);[^}]*border-radius: 16px;[^}]*background: #fff8f2;/);
  assert.match(blogStyles, /\.article-figure img \{[^}]*border: 1px solid rgba\(22,22,22,\.09\);[^}]*border-radius: 20px;[^}]*background: #f7f7f3;/);
});

test('article reading area is packaged as a responsive analysis file', () => {
  assert.match(blogStyles, /\.article-main \{[^}]*background: #f3f4f6;/);
  assert.match(blogStyles, /\.article-shell \{[^}]*border: 1px solid #e5e5e5;[^}]*border-top: 4px solid #fc781f;[^}]*border-radius: 4px;[^}]*background-color: #fff;[^}]*box-shadow: 0 4px 20px rgba\(0,0,0,\.03\);/);
  assert.match(blogStyles, /@media \(max-width: 1024px\) \{[\s\S]*?\.article-shell \{[^}]*width: min\(840px, calc\(100% - 32px\)\);[^}]*padding: 32px 24px;/);
});

test('review reliability figures 7 and 8 use the toolbar-free JPG assets', () => {
  assert.match(reviewReliabilityArticleHtml, /src="\/assets\/blog\/ket-qua-trustscore-realview\.jpg"[^>]*width="2027"[^>]*height="1166"/);
  assert.match(reviewReliabilityArticleHtml, /src="\/assets\/blog\/thanh-phan-trustscore-realview\.jpg"[^>]*width="2027"[^>]*height="1163"/);
});

test('five-star review article uses the dedicated thumbnail without replacing its in-article example', () => {
  assert.match(blogHtml, /src="\/assets\/blog\/review-5-sao-co-dang-tin-thumbnail\.jpg"/);
  assert.match(reviewReliabilityArticleHtml, /class="article-lead-image" src="\/assets\/blog\/review-5-sao-co-dang-tin-thumbnail\.jpg"/);
  assert.match(reviewReliabilityArticleHtml, /class="article-figure"><img src="\/assets\/blog\/review-5-sao-it-thong-tin\.jpg"/);
});

test('blog library uses the streamlined aligned layout', () => {
  assert.doesNotMatch(blogHtml, /Nội dung tập trung vào cách kiểm chứng/);
  assert.doesNotMatch(blogHtml, /Chủ đề nổi bật|data-sidebar-filter/);
  assert.equal((blogHtml.match(/class="blog-list-item" data-blog-card/g) || []).length, 6);
  assert.match(blogStyles, /\.blog-tools \{[^}]*display: grid;[^}]*grid-template-columns: minmax\(0, 1fr\) 310px;[^}]*align-items: center;[^}]*column-gap: 72px;/);
  assert.match(blogStyles, /\.blog-search \{[^}]*width: 100%;[^}]*height: 48px;[^}]*padding: 0 16px;[^}]*box-sizing: border-box;[^}]*border: 1px solid #d1d5db;[^}]*background-color: #fff;[^}]*box-shadow: 0 1px 2px rgba\(0,0,0,\.05\);/);
  assert.match(blogStyles, /\.blog-search svg \{[^}]*width: 21px;[^}]*height: 21px;/);
  assert.match(blogStyles, /\.blog-search input \{[^}]*width: 100%;[^}]*font-size: 15px;/);
  assert.match(blogStyles, /\.blog-layout \{[^}]*grid-template-columns: minmax\(0, 1fr\) 310px;[^}]*column-gap: 72px;/);
  assert.match(blogStyles, /\.blog-list-item \{[^}]*margin-bottom: 32px;[^}]*padding-bottom: 32px;[^}]*border-bottom: 1px solid #e5e5e5;/);
  assert.match(blogStyles, /\.featured-post h3 \{[^}]*font-size: 24px;[^}]*line-height: 1\.25;/);
  assert.match(blogStyles, /\.post-card h3 \{[^}]*font-size: 24px;[^}]*line-height: 1\.25;/);
  assert.match(blogStyles, /@media \(max-width: 1024px\) \{[\s\S]*?\.blog-tools \{[^}]*grid-template-columns: 1fr;[^}]*row-gap: 18px;/);
});

test('review checklist is presented as an elevated card', () => {
  assert.match(blogStyles, /\.start-card \{[^}]*border: 0;[^}]*border-radius: 16px;[^}]*background-color: #fff;[^}]*box-shadow: 0 4px 20px rgba\(0,0,0,\.05\);/);
});

test('blog editorial card uses icons, dividers, and balanced alignment', () => {
  assert.match(blogHtml, /<h2 id="editorial-title">Blog RealView<br>được biên tập<br>như thế nào\?<\/h2>/);
  assert.equal((blogHtml.match(/class="editorial-icon"/g) || []).length, 3);
  assert.match(blogHtml, /class="editorial-icon"[^>]*aria-hidden="true"[\s\S]*?<h3>Ai thực hiện<\/h3>/);
  assert.match(blogHtml, /class="editorial-icon"[^>]*aria-hidden="true"[\s\S]*?<h3>Cách thực hiện<\/h3>/);
  assert.match(blogHtml, /class="editorial-icon"[^>]*aria-hidden="true"[\s\S]*?<h3>Mục đích<\/h3>/);
  assert.match(blogStyles, /\.blog-editorial-shell \{[^}]*display: grid;[^}]*grid-template-columns: max-content repeat\(3, minmax\(0, 1fr\)\);[^}]*align-items: center;[^}]*gap: 40px;/);
  assert.match(blogStyles, /\.editorial-principles \{[^}]*display: contents;/);
  assert.match(blogStyles, /\.editorial-principles article \{[^}]*min-width: 0;[^}]*align-self: stretch;/);
  assert.match(blogStyles, /\.editorial-principles article:nth-child\(n \+ 2\) \{[^}]*padding-left: 24px;[^}]*border-left: 1px solid #e5e5e5;/);
  assert.match(blogStyles, /\.editorial-icon \{[^}]*width: 28px;[^}]*height: 28px;[^}]*margin-bottom: 12px;[^}]*color: #fc781f;/);
  assert.match(blogStyles, /\.editorial-principles p \{[^}]*color: #4b5563;[^}]*line-height: 1\.6;/);
  assert.match(blogStyles, /@media \(max-width: 760px\) \{[\s\S]*?\.editorial-principles \{[^}]*display: grid;[^}]*grid-template-columns: 1fr;[^}]*gap: 20px;[^}]*\}[\s\S]*?\.editorial-principles article:nth-child\(n \+ 2\) \{[^}]*padding-left: 0;[^}]*border-left: 0;/);
});

test('mobile lead image stays contained and the individual score uses MathML', () => {
  assert.match(reviewReliabilityArticleHtml, /class="article-lead-image"/);
  assert.match(trustScoreArticleHtml, /class="article-lead-image"/);
  assert.doesNotMatch(reviewReliabilityArticleHtml, /article-lead-image--review-reliability/);
  assert.match(blogStyles, /@media \(max-width: 760px\) \{[\s\S]*?\.article-lead-image \{[^}]*width: 100%;[^}]*max-width: 100%;[^}]*height: auto;[^}]*max-height: none;[^}]*object-fit: contain;/);
  assert.match(trustScoreArticleHtml, /class="article-math"[^>]*role="img"[^>]*aria-label=/);
  assert.match(trustScoreArticleHtml, /<math display="block"[^>]*>[\s\S]*?<mi>S<\/mi><mo>\(<\/mo><mi>r<\/mi><mo>\)<\/mo>[\s\S]*?<mfrac>/);
  assert.doesNotMatch(trustScoreArticleHtml, /<msub>|<mtext>text<\/mtext>|<sub>text<\/sub>/);
  assert.doesNotMatch(trustScoreArticleHtml, /<p>S_text\(r\)/);
  assert.match(blogStyles, /\.article-math \{[^}]*max-width: 100%;[^}]*overflow-x: auto;[^}]*overflow-y: hidden;/);
});

test('both long-form articles retain complete source content and SEO metadata', () => {
  const articles = [
    {
      html: trustScoreArticleHtml,
      canonical: 'https://www.realview.com.vn/bai-viet/trustscore-la-gi',
      otherPath: '/bai-viet/kiem-tra-do-tin-cay-review-truoc-khi-mua-hang',
      minimumWords: 3300,
      required: ['Công thức điểm cá thể', '5 điều cần nhớ về TrustScore', 'Thông tin xuất bản'],
    },
    {
      html: reviewReliabilityArticleHtml,
      canonical: 'https://www.realview.com.vn/bai-viet/kiem-tra-do-tin-cay-review-truoc-khi-mua-hang',
      otherPath: '/bai-viet/trustscore-la-gi',
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
  assert.match(navJs, /href="\/bai-viet"/);
  assert.doesNotMatch(navJs, /Blog <small>Sắp ra mắt<\/small>/);
});

test('sitemap and robots expose all six published Blog articles', () => {
  assert.match(robotsTxt, /Sitemap: https:\/\/www\.realview\.com\.vn\/sitemap\.xml/);
  assert.match(sitemapXml, /https:\/\/www\.realview\.com\.vn\/bai-viet/);
  assert.match(sitemapXml, /https:\/\/www\.realview\.com\.vn\/bai-viet\/trustscore-la-gi/);
  assert.match(sitemapXml, /https:\/\/www\.realview\.com\.vn\/bai-viet\/kiem-tra-do-tin-cay-review-truoc-khi-mua-hang/);
  assert.match(sitemapXml, /shopee-hay-tiktok-shop-mua-hang-o-dau-tot-hon/);
  assert.match(sitemapXml, /shopee-mall-la-gi-co-nen-mua-khong/);
  assert.match(sitemapXml, /tiktok-shop-la-gi-mua-hang-tren-tiktok-co-an-toan-khong/);
  assert.match(sitemapXml, /cach-tim-shop-uy-tin-tren-shopee/);
  assert.doesNotMatch(sitemapXml, /cach-doc-review-thong-minh/);
  assert.doesNotMatch(sitemapXml, /https:\/\/realview\.com\.vn\//);
  assert.doesNotMatch(sitemapXml, /results\.html/);
  assert.match(sitemapXml, /xmlns:image="http:\/\/www\.google\.com\/schemas\/sitemap-image\/1\.1"/);
});
