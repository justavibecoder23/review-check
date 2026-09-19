import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const blogHtml = await readFile(new URL('../public/blog.html', import.meta.url), 'utf8');
const trustScoreArticleHtml = await readFile(new URL('../public/blog/trustscore-la-gi.html', import.meta.url), 'utf8');
const reviewReliabilityArticleHtml = await readFile(new URL('../public/blog/kiem-tra-do-tin-cay-review-truoc-khi-mua-hang.html', import.meta.url), 'utf8');
const tiktokShopArticleHtml = await readFile(new URL('../public/blog/tiktok-shop-la-gi-mua-hang-tren-tiktok-co-an-toan-khong.html', import.meta.url), 'utf8');
const shopeeComparisonArticleHtml = await readFile(new URL('../public/blog/shopee-hay-tiktok-shop-mua-hang-o-dau-tot-hon.html', import.meta.url), 'utf8');
const shopeeMallArticleHtml = await readFile(new URL('../public/blog/shopee-mall-la-gi-co-nen-mua-khong.html', import.meta.url), 'utf8');
const trustedShopeeShopArticleHtml = await readFile(new URL('../public/blog/cach-tim-shop-uy-tin-tren-shopee.html', import.meta.url), 'utf8');
const productReviewArticleHtml = await readFile(new URL('../public/blog/review-san-pham-la-gi.html', import.meta.url), 'utf8');
const reliableReviewArticleHtml = await readFile(new URL('../public/blog/review-san-pham-co-dang-tin-khong.html', import.meta.url), 'utf8');
const fakeReviewArticleHtml = await readFile(new URL('../public/blog/review-gia-la-gi-dau-hieu-nhan-biet.html', import.meta.url), 'utf8');
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

function tocEntryIds(html) {
  return [...html.matchAll(/<h[23][^>]*id="([^"]+)"[^>]*data-toc-entry[^>]*>/g)]
    .map((match) => match[1]);
}

test('blog hub publishes nine articles and features the five-star review article', () => {
  assert.match(blogHtml, /<link rel="canonical" href="https:\/\/www\.realview\.com\.vn\/bai-viet"/);
  assert.equal((blogHtml.match(/<h1\b/g) || []).length, 1);
  assert.equal((blogHtml.match(/data-blog-card/g) || []).length, 9);
  assert.match(blogHtml, /class="featured-post"[\s\S]*?href="\/bai-viet\/kiem-tra-do-tin-cay-review-truoc-khi-mua-hang"/);
  assert.match(blogHtml, /Review 5 sao có đáng tin không\?/);
  assert.match(blogHtml, /href="\/bai-viet\/trustscore-la-gi"/);
  assert.doesNotMatch(blogHtml, /cach-doc-review-thong-minh/);
  assert.doesNotMatch(blogHtml, /Bài viết sắp xuất bản/);
  const collection = structuredData(blogHtml).find((item) => item['@type'] === 'CollectionPage');
  assert.equal(collection.mainEntity.numberOfItems, 9);
  assert.equal(collection.mainEntity.itemListElement.length, 9);
  assert.match(blogHtml, /href="\/bai-viet\/review-san-pham-la-gi"/);
  assert.match(blogHtml, /href="\/bai-viet\/review-san-pham-co-dang-tin-khong"/);
  assert.match(blogHtml, /href="\/bai-viet\/review-gia-la-gi-dau-hieu-nhan-biet"/);
});

test('fake-review article preserves the main source, words, and supplied nine-section outline', () => {
  assert.match(fakeReviewArticleHtml, /<h1 class="article-title">Review giả là gì\? Dấu hiệu nhận biết review không đáng tin<\/h1>/);
  assert.match(fakeReviewArticleHtml, /<img class="article-lead-image article-lead-image--seo07" src="\/assets\/blog\/review-gia-la-gi-dau-hieu-nhan-biet\.jpg"/);
  assert.equal((fakeReviewArticleHtml.match(/<h2 [^>]*data-toc-entry>/g) || []).length, 9);
  assert.match(fakeReviewArticleHtml, /article-figure--seo09-gallery/);
  assert.match(fakeReviewArticleHtml, /Review nhận xu có đáng tin không\?/);
  assert.match(fakeReviewArticleHtml, /☐ Review có mô tả trải nghiệm cụ thể không\?/);
  assert.doesNotMatch(fakeReviewArticleHtml, /<h2[^>]*>CTA<\/h2>/);
  assert.match(fakeReviewArticleHtml, /Đừng để vài ngôi sao quyết định thay bạn\./);
  assert.match(fakeReviewArticleHtml, /Kiểm tra độ tin cậy của review với RealView trước khi mua\./);
  assert.match(fakeReviewArticleHtml, /Hạ Thúy Ngân, Nguyễn Ngọc Thiện - SEO Content Member tại RealView/);
  assert.doesNotMatch(fakeReviewArticleHtml, /Bài SEO 9|Cụm chủ đề: Review sản phẩm|>Sapo</);
  assert.match(sitemapXml, /<loc>https:\/\/www\.realview\.com\.vn\/bai-viet\/review-gia-la-gi-dau-hieu-nhan-biet<\/loc>/);
});

test('reliable-review article uses the second source image as both thumbnail and lead image', () => {
  assert.match(reliableReviewArticleHtml, /<h1 class="article-title">Review sản phẩm có đáng tin không\? 7 yếu tố kiểm tra độ tin cậy trước khi đặt hàng<\/h1>/);
  assert.match(reliableReviewArticleHtml, /<img class="article-lead-image article-lead-image--seo07" src="\/assets\/blog\/review-san-pham-co-dang-tin-khong\.jpg"/);
  assert.match(reliableReviewArticleHtml, /<figure class="article-figure article-figure--seo08-source-crop"><img src="\/assets\/blog\/seo08-53-image1\.jpg"/);
  assert.match(blogStyles, /\.article-figure--seo08-source-crop \{[^}]*aspect-ratio: 5495722 \/ 2558737;/);
  assert.match(reliableReviewArticleHtml, /<link rel="canonical" href="https:\/\/www\.realview\.com\.vn\/bai-viet\/review-san-pham-co-dang-tin-khong"/);
  assert.match(reliableReviewArticleHtml, /Đánh giá thực bằng hình ảnh và video/);
  assert.match(reliableReviewArticleHtml, /Nguyễn Bạch Vy, Nguyễn Trần Khánh Linh - Team SEO Content tại RealView/);
  assert.doesNotMatch(reliableReviewArticleHtml, /Bài SEO 08|Cụm chủ đề: Kỹ năng phân tích|>Sapo</);
  assert.match(sitemapXml, /<loc>https:\/\/www\.realview\.com\.vn\/bai-viet\/review-san-pham-co-dang-tin-khong<\/loc>/);
});

test('product-review article keeps authored content and is discoverable', () => {
  assert.match(productReviewArticleHtml, /<h1 class="article-title">Review sản phẩm là gì\? Cách đọc review để ra quyết định tốt hơn<\/h1>/);
  assert.match(productReviewArticleHtml, /<link rel="canonical" href="https:\/\/www\.realview\.com\.vn\/bai-viet\/review-san-pham-la-gi"/);
  assert.match(productReviewArticleHtml, /Một bài review sản phẩm thường có những phần nào\?/);
  assert.match(productReviewArticleHtml, /Review 5 sao có phải lúc nào cũng đáng tin không\?/);
  assert.match(productReviewArticleHtml, /Nguyễn Bạch Vy, Nguyễn Trần Khánh Linh - Team SEO Content tại RealView/);
  assert.match(productReviewArticleHtml, /<img class="article-lead-image article-lead-image--seo07" src="\/assets\/blog\/review-san-pham-la-gi\.jpg"/);
  assert.match(productReviewArticleHtml, /<h3 id="3-hinh-anh-video-va-bang-chung-di-kem">[\s\S]*?<p>Hình ảnh và video giúp kiểm chứng/);
  assert.doesNotMatch(productReviewArticleHtml, /<p class="article-caption">Hình ảnh và video giúp/);
  assert.match(sitemapXml, /<loc>https:\/\/www\.realview\.com\.vn\/bai-viet\/review-san-pham-la-gi<\/loc>/);
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
  assert.equal(allArticlePages.length, 9);
  for (const { name, html } of allArticlePages) {
    assert.match(html, /class="article-reading-grid"[\s\S]*?<h1 class="article-title">[\s\S]*?<aside class="article-sidebar"[\s\S]*?<details class="article-toc" data-article-toc>[\s\S]*?<div class="article-body-column">/);
    assert.doesNotMatch(html, /class="article-deck"/, `${name} must not repeat SEO metadata in visible article content`);
    assert.match(html, /<script src="\/blog-post\.js" defer><\/script>/);
    assert.doesNotMatch(html, /class="article-header"/);
    assert.match(html, /class="article-category"/);
    assert.match(html, /class="article-author"/);
    assert.match(html, /class="article-date"/);
    assert.match(html, /class="article-content"/, `${name} must use the shared Blog Post structure`);
  }
  assert.match(blogStyles, /\.article-shell \{[^}]*width: min\(1322px, calc\(100% - 48px\)\);[^}]*max-width: 1322px;[^}]*padding: 64px 80px;/);
  assert.match(blogStyles, /\.article-reading-grid \{[^}]*grid-template-columns: 280px minmax\(0, 800px\);[^}]*grid-template-rows: auto auto;[^}]*column-gap: 80px;/);
  assert.match(blogStyles, /\.article-deck \{[^}]*max-width: 800px;[^}]*margin: -12px 0 42px;/);
  assert.match(blogStyles, /\.article-sidebar \{[^}]*grid-row: 1 \/ span 2;[^}]*position: sticky;[^}]*top: 100px;[^}]*align-self: start;/);
  assert.match(blogStyles, /\.article-body-column \{[^}]*grid-column: 2;[^}]*grid-row: 2;/);
  assert.match(blogStyles, /\.article-title \{[^}]*font-size: clamp\(48px, 4\.4vw, 56px\);[^}]*font-weight: 800;[^}]*line-height: 1\.2;/);
  assert.match(blogStyles, /\.article-content \{[^}]*max-width: 800px;[^}]*color: #374151;[^}]*font-size: 18px;[^}]*line-height: 1\.8;/);
  assert.match(blogStyles, /@media \(max-width: 1024px\) \{[\s\S]*?\.article-reading-grid \{[^}]*grid-template-columns: minmax\(0, 1fr\);[^}]*grid-template-rows: auto auto auto;/);
  assert.match(blogStyles, /@media \(max-width: 1024px\) \{[\s\S]*?\.article-sidebar \{[^}]*grid-column: 1;[^}]*grid-row: 2;/);
  assert.match(blogStyles, /@media \(max-width: 1024px\) \{[\s\S]*?\.article-body-column \{[^}]*grid-column: 1;[^}]*grid-row: 3;/);
  assert.match(blogStyles, /\.article-toc-links a\.is-active \{[^}]*border-left-color: #fc781f;[^}]*color: #fc781f;[^}]*font-weight: 600;/);
  assert.match(blogStyles, /\.article-toc-links \{[^}]*max-height: min\(52vh, 480px\);[^}]*overflow-y: auto;[^}]*scrollbar-width: none;[^}]*-webkit-mask-image: linear-gradient\(to bottom, transparent 0%, black 5%, black 95%, transparent 100%\);[^}]*mask-image: linear-gradient\(to bottom, transparent 0%, black 5%, black 95%, transparent 100%\);/);
  assert.match(blogStyles, /\.article-toc-links::\-webkit-scrollbar \{[^}]*display: none;/);
  assert.match(blogStyles, /@media \(max-width: 1024px\) \{[\s\S]*?\.article-toc-links \{[^}]*max-height: 360px;/);
  assert.match(blogPostJs, /IntersectionObserver/);
  assert.match(blogPostJs, /matchMedia\('\(min-width: 1025px\)'\)/);
  assert.match(blogPostJs, /toc\.removeAttribute\('open'\)/);
  assert.match(blogPostJs, /tocScroller\.scrollTo\(/);
  assert.match(blogPostJs, /lockActiveHeading\(heading\.id\)/);
  assert.match(blogPostJs, /event\.preventDefault\(\)/);
  assert.match(blogPostJs, /history\.pushState\(null, '', hash\)/);
  assert.match(blogPostJs, /scrollToHeading\(heading\)/);
  assert.match(blogPostJs, /if \(lockedId\) scheduleLockRelease\(\)/);
  assert.match(blogPostJs, /heading\.getBoundingClientRect\(\)\.top <= ACTIVE_HEADING_THRESHOLD/);
});

test('article tables of contents follow the supplied editorial outlines', () => {
  const expectedEntries = new Map([
    ['review-gia-la-gi-dau-hieu-nhan-biet.html', [
      'review-gia-la-gi',
      'nhung-dau-hieu-nhan-biet-review-gia',
      'vi-sao-chi-nhin-so-sao-la-chua-du',
      'cach-kiem-tra-review-san-pham-truoc-khi-mua',
      'review-ao-tren-shopee-va-tiktok-shop-can-kiem-tra-gi',
      'review-nhan-xu-co-dang-tin-khong',
      'checklist-nhan-biet-review-khong-dang-tin',
      'realview-phan-tich-review-nhu-the-nao',
      'trustscore-la-gi',
    ]],
    ['review-san-pham-co-dang-tin-khong.html', [
      'review-san-pham-co-the-dang-tin-den-muc-nao',
      '7-yeu-to-can-kiem-tra-de-xac-dinh-do-tin-cay-review',
      'dau-hieu-nen-canh-giac-voi-tep-danh-gia',
      'cach-doi-chieu-nhieu-nguon-de-tim-ra-danh-gia-that',
      'vai-tro-cua-cong-cu-check-review-trong-ky-nguyen-so',
      'faq-cau-hoi-thuong-gap',
      'bai-viet-lien-quan',
      'ket-luan',
      'thong-tin-xuat-ban',
    ]],
    ['review-san-pham-la-gi.html', [
      'review-san-pham-la-gi-hieu-dung-ban-chat-cua-mot-bai-review',
      'mot-bai-review-san-pham-thuong-co-nhung-phan-nao',
      'tips-doc-review-de-khong-chi-nhin-so-sao',
      'doc-review-san-pham-tren-shopee-va-tiktok-shop',
      'khi-nao-nen-check-review-truoc-khi-mua',
      'faq-cau-hoi-thuong-gap',
      'bai-viet-lien-quan',
      'ket-luan-doc-review-dung-cach-de-ra-quyet-dinh-tot-hon',
    ]],
    ['cach-tim-shop-uy-tin-tren-shopee.html', [
      'tai-sao-phai-biet-cach-tim-shop-uy-tin-tren-shopee',
      'checklist-6-buoc-tim-shop-uy-tin-tren-shopee',
      '4-dau-hieu-bat-thuong-cua-cac-shop-kem-uy-tin',
      'faq-cau-hoi-thuong-gap',
      'bai-viet-lien-quan',
    ]],
    ['kiem-tra-do-tin-cay-review-truoc-khi-mua-hang.html', [
      'review-5-sao-co-dang-tin-khong',
      '5-dau-hieu-giup-kiem-tra-do-tin-cay-cua-review',
      'cach-kiem-tra-do-tin-cay-cua-review-truoc-khi-mua',
      'cong-cu-kiem-tra-do-tin-cay-cua-review',
      'trustscore-chi-so-tong-hop-ve-do-tin-cay-cua-tap-review',
      'faq',
      'bai-viet-lien-quan',
    ]],
    ['shopee-hay-tiktok-shop-mua-hang-o-dau-tot-hon.html', [
      'shopee-hay-tiktok-shop-tot-hon',
      'shopee-hay-tiktok-shop-re-hon',
      'voucher-va-livestream-co-anh-huong-den-quyet-dinh-mua',
      'review-tren-shopee-va-tiktok-shop-co-dang-tin-khong',
      'review-nhieu-co-dong-nghia-san-pham-tot',
      'chon-shop-quan-trong-hon-chon-san',
      'nen-mua-hang-tren-shopee-hay-tiktok-shop',
      'bang-so-sanh-shopee-va-tiktok-shop',
      'vay-shopee-hay-tiktok-shop-tot-hon',
      'kiem-tra-review-truoc-khi-chot-don-cung-realview',
      'faq-cau-hoi-thuong-gap',
      'bai-viet-lien-quan',
    ]],
    ['shopee-mall-la-gi-co-nen-mua-khong.html', [
      'shopee-mall-la-gi-ban-chat-cua-nhan-mall',
      'vi-sao-nhieu-nguoi-uu-tien-mua-hang-shopee-mall',
      'nhung-han-che-khi-mua-hang-shopee-mall',
      'co-nen-mua-hang-shopee-mall-khong',
      '5-buoc-kiem-tra-shop-chinh-hang-va-uy-tin-truoc-khi-chot-don',
      'faq-cau-hoi-thuong-gap',
      'bai-viet-lien-quan',
    ]],
    ['tiktok-shop-la-gi-mua-hang-tren-tiktok-co-an-toan-khong.html', [
      'tiktok-shop-la-gi',
      'tiktok-shop-hoat-dong-nhu-the-nao',
      'tiktok-shop-co-an-toan-va-uy-tin-khong',
      '6-cach-kiem-tra-truoc-khi-mua-hang-tiktok-shop',
      'checklist-mua-hang-tren-tiktok-shop',
      'review-tiktok-shop-co-dang-tin-khong',
      'co-nen-mua-hang-tiktok-shop-chi-vi-livestream-giam-gia',
      'realview-ho-tro-kiem-tra-review-tiktok-shop-nhu-the-nao',
      'bai-viet-lien-quan',
      'kiem-tra-review-truoc-khi-chot-don',
    ]],
    ['trustscore-la-gi.html', [
      'trustscore-la-gi',
      'trustscore-khac-gi-so-sao-cua-san-pham',
      'trustscore-duoc-tinh-nhu-the-nao',
      'trustscore-bao-nhieu-la-dang-tin',
      'trustscore-cao-co-nghia-san-pham-tot-khong',
      'trustscore-co-phat-hien-review-gia-khong',
      'realview-phan-tich-tap-review-nhu-the-nao',
      'cach-doc-trustscore-khi-mua-hang-online',
      'trustscore-co-thay-the-viec-doc-review-khong',
      'faq-ve-trustscore',
      '5-dieu-can-nho-ve-trustscore',
      'bai-viet-lien-quan',
    ]],
  ]);

  for (const { name, html } of allArticlePages) {
    assert.deepEqual(tocEntryIds(html), expectedEntries.get(name), `${name} must follow its supplied outline`);
  }
  assert.match(blogPostJs, /configuredHeadings = \[\.\.\.content\.querySelectorAll\(':scope > \[data-toc-entry\]\[id\]'\)\]/);
});

test('TikTok Shop article preserves source headings, lists, emphasis, and internal links', () => {
  assert.match(tiktokShopArticleHtml, /<h3 id="3-so-sanh-gia-cuoi-cung">3\. So sánh giá cuối cùng<\/h3>/);
  assert.match(tiktokShopArticleHtml, /<h2 id="review-tiktok-shop-co-dang-tin-khong" data-toc-entry>Review TikTok Shop có đáng tin không\?<\/h2>/);
  assert.match(tiktokShopArticleHtml, /<h2 id="kiem-tra-review-truoc-khi-chot-don" data-toc-entry>Kiểm tra review trước khi chốt đơn<\/h2>/);
  assert.equal((tiktokShopArticleHtml.match(/<ul>/g) || []).length >= 6, true);
  assert.match(tiktokShopArticleHtml, /<ol>[\s\S]*?<li>Shop: [\s\S]*?<li>Đổi trả:/);
  assert.match(tiktokShopArticleHtml, /href="\/bai-viet\/kiem-tra-do-tin-cay-review-truoc-khi-mua-hang"/);
  assert.match(tiktokShopArticleHtml, /href="\/bai-viet\/trustscore-la-gi"/);
  assert.match(tiktokShopArticleHtml, /id="faq-tiktok-shop-la-gi"/);
  assert.match(tiktokShopArticleHtml, /id="faq-review-tiktok-shop-co-dang-tin-khong"/);
});

test('four supplied SEO articles preserve source lists, emphasis, dates, and standalone links', () => {
  const suppliedArticles = [
    reviewReliabilityArticleHtml,
    shopeeComparisonArticleHtml,
    shopeeMallArticleHtml,
    trustedShopeeShopArticleHtml,
  ];

  for (const html of suppliedArticles) {
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length, 'supplied article must not contain duplicate IDs');
    assert.match(html, /class="article-source-cta"/);
  }

  assert.equal((reviewReliabilityArticleHtml.match(/<ul>/g) || []).length >= 3, true);
  assert.match(reviewReliabilityArticleHtml, /<strong>Bước 1:<\/strong>/);
  assert.match(reviewReliabilityArticleHtml, /class="article-source-cta" id="tim-hieu-chi-tiet/);

  assert.equal((shopeeComparisonArticleHtml.match(/<ul>/g) || []).length >= 4, true);
  assert.match(shopeeComparisonArticleHtml, /<strong>Tổng thanh toán<\/strong>/);
  assert.match(shopeeComparisonArticleHtml, /class="article-source-cta"[\s\S]*?href="\/tieu-chi-loc"/);
  assert.match(shopeeComparisonArticleHtml, /<h2 id="bai-viet-lien-quan"[^>]*>[\s\S]*?<p><a href="\/bai-viet\//);

  assert.equal((shopeeMallArticleHtml.match(/<ul>/g) || []).length >= 4, true);
  assert.match(shopeeMallArticleHtml, /<h2 id="nguon-tham-khao">[\s\S]*?<ol>/);
  assert.match(shopeeMallArticleHtml, /datePublished": "2026-09-14T08:00:00\+07:00"/);
  assert.match(shopeeMallArticleHtml, /<time datetime="2026-09-14">14 tháng 9, 2026<\/time>/);

  assert.equal((trustedShopeeShopArticleHtml.match(/<ul>/g) || []).length >= 4, true);
  assert.doesNotMatch(trustedShopeeShopArticleHtml, /<p>nó<\/p>/);
  assert.match(trustedShopeeShopArticleHtml, /<p>RealView – Real Reviews – Real Value<\/p>\s*<p>Góc nhìn thật – Lựa chọn đúng\.<\/p>/);
  assert.match(trustedShopeeShopArticleHtml, /datePublished": "2026-09-14T08:00:00\+07:00"/);
  assert.match(trustedShopeeShopArticleHtml, /<time datetime="2026-09-14">14 tháng 9, 2026<\/time>/);

  assert.match(blogStyles, /\.article-content \.article-source-cta \{[^}]*width: 100%;[^}]*display: flex;[^}]*justify-content: center;[^}]*text-align: center;/);
  assert.match(blogStyles, /\.article-source-cta a \{[^}]*color: #fc781f;[^}]*text-decoration: underline;/);
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

test('selected tall article figures are compact and toolbar screenshots use the clean TrustScore image', () => {
  assert.match(blogStyles, /\.article-figure--compact img \{[^}]*width: auto;[^}]*max-width: 100%;[^}]*max-height: 720px;[^}]*margin: 0 auto;[^}]*object-fit: contain;/);
  assert.match(blogStyles, /@media \(max-width: 760px\) \{[\s\S]*?\.article-figure--compact img \{[^}]*max-height: 68vh;/);

  for (const [html, sources] of [
    [shopeeMallArticleHtml, ['seo04-6-1.jpg', 'seo04-51-1.jpg']],
    [tiktokShopArticleHtml, ['seo05-10-1.jpg', 'seo05-75-1.jpg']],
    [trustedShopeeShopArticleHtml, ['seo06-39-1.jpg', 'seo06-55-1.jpg']],
  ]) {
    for (const source of sources) {
      assert.match(html, new RegExp(`class="article-figure[^"]*article-figure--compact[^"]*"><img src="/assets/blog/${source.replace('.', '\\.')}`));
    }
  }

  assert.match(shopeeMallArticleHtml, /src="\/assets\/blog\/case-study-trustscore-64\.jpg"[^>]*width="2560"[^>]*height="1451"[\s\S]*?<p class="article-caption">Hình 3\. RealView phân tích tập review để bổ sung góc nhìn về độ tin cậy\.<\/p>/);
  assert.match(trustedShopeeShopArticleHtml, /src="\/assets\/blog\/case-study-trustscore-64\.jpg"[^>]*width="2560"[^>]*height="1451"[\s\S]*?<p class="article-caption">Hình 3\. RealView phân tích tập review để bổ sung góc nhìn về độ tin cậy\.<\/p>/);
  assert.doesNotMatch(shopeeMallArticleHtml, /seo04-61-1\.jpg/);
  assert.doesNotMatch(trustedShopeeShopArticleHtml, /seo06-45-1\.jpg/);
});

test('selected review examples and the Shopee seeding example use the reduced figure treatment', () => {
  assert.match(blogStyles, /\.article-figure--reduced img \{[^}]*width: 88%;[^}]*max-width: 680px;[^}]*margin-right: auto;[^}]*margin-left: auto;[^}]*object-fit: contain;/);
  assert.match(blogStyles, /@media \(max-width: 760px\) \{[\s\S]*?\.article-figure--reduced img \{[^}]*width: 92%;/);

  for (const source of [
    'review-5-sao-it-thong-tin.jpg',
    'review-ngan-co-thong-tin.jpg',
    'review-chi-noi-giao-hang.jpg',
  ]) {
    assert.match(reviewReliabilityArticleHtml, new RegExp(`class="article-figure article-figure--reduced"><img src="/assets/blog/${source.replace('.', '\\.')}`));
  }

  assert.match(trustedShopeeShopArticleHtml, /class="article-figure article-figure--compact article-figure--reduced article-figure--smaller"><img src="\/assets\/blog\/seo06-55-1\.jpg"/);
  assert.match(blogStyles, /\.article-figure--smaller img \{[^}]*width: 80%;[^}]*max-width: 620px;/);
  assert.match(blogStyles, /@media \(max-width: 760px\) \{[\s\S]*?\.article-figure--smaller img \{[^}]*width: 86%;/);
});

test('TikTok review reliability CTA is centered and has no square brackets', () => {
  assert.match(tiktokShopArticleHtml, /<p class="article-source-cta"><a href="\/bai-viet\/kiem-tra-do-tin-cay-review-truoc-khi-mua-hang">Cách kiểm tra độ tin cậy của review trước khi mua hàng<\/a><\/p>/);
  assert.doesNotMatch(tiktokShopArticleHtml, />\[Cách kiểm tra độ tin cậy của review trước khi mua hàng\]<\/a>/);
});

test('five-star review article uses the dedicated thumbnail without replacing its in-article example', () => {
  assert.match(blogHtml, /src="\/assets\/blog\/review-5-sao-co-dang-tin-thumbnail\.jpg"/);
  assert.match(reviewReliabilityArticleHtml, /class="article-lead-image" src="\/assets\/blog\/review-5-sao-co-dang-tin-thumbnail\.jpg"/);
  assert.match(reviewReliabilityArticleHtml, /class="article-figure[^"]*"><img src="\/assets\/blog\/review-5-sao-it-thong-tin\.jpg"/);
});

test('TrustScore article uses the dedicated thumbnail while preserving its first content figure', () => {
  assert.match(blogHtml, /href="\/bai-viet\/trustscore-la-gi"[^>]*><img src="\/assets\/blog\/trustscore-thumbnail\.jpg"[^>]*width="2752"[^>]*height="1536"/);
  assert.match(trustScoreArticleHtml, /property="og:image" content="https:\/\/www\.realview\.com\.vn\/assets\/blog\/trustscore-thumbnail\.jpg"/);
  assert.match(trustScoreArticleHtml, /name="twitter:image" content="https:\/\/www\.realview\.com\.vn\/assets\/blog\/trustscore-thumbnail\.jpg"/);
  assert.match(trustScoreArticleHtml, /"image": \{ "@type": "ImageObject", "url": "https:\/\/www\.realview\.com\.vn\/assets\/blog\/trustscore-thumbnail\.jpg", "width": 2752, "height": 1536 \}/);
  assert.match(trustScoreArticleHtml, /class="article-lead-image" src="\/assets\/blog\/trustscore-thumbnail\.jpg"[^>]*width="2752"[^>]*height="1536"/);
  assert.match(trustScoreArticleHtml, /class="article-figure"><img src="\/assets\/blog\/trustscore-giao-dien-realview\.jpg"/);
});

test('blog library uses the streamlined aligned layout', () => {
  assert.doesNotMatch(blogHtml, /Nội dung tập trung vào cách kiểm chứng/);
  assert.doesNotMatch(blogHtml, /Chủ đề nổi bật|data-sidebar-filter/);
  assert.equal((blogHtml.match(/class="blog-list-item" data-blog-card/g) || []).length, 9);
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

test('sitemap and robots expose all nine published Blog articles', () => {
  assert.match(robotsTxt, /Sitemap: https:\/\/www\.realview\.com\.vn\/sitemap\.xml/);
  assert.match(sitemapXml, /https:\/\/www\.realview\.com\.vn\/bai-viet/);
  assert.match(sitemapXml, /https:\/\/www\.realview\.com\.vn\/bai-viet\/trustscore-la-gi/);
  assert.match(sitemapXml, /https:\/\/www\.realview\.com\.vn\/bai-viet\/kiem-tra-do-tin-cay-review-truoc-khi-mua-hang/);
  assert.match(sitemapXml, /shopee-hay-tiktok-shop-mua-hang-o-dau-tot-hon/);
  assert.match(sitemapXml, /shopee-mall-la-gi-co-nen-mua-khong/);
  assert.match(sitemapXml, /tiktok-shop-la-gi-mua-hang-tren-tiktok-co-an-toan-khong/);
  assert.match(sitemapXml, /cach-tim-shop-uy-tin-tren-shopee/);
  assert.match(sitemapXml, /<loc>https:\/\/www\.realview\.com\.vn\/bai-viet\/review-san-pham-la-gi<\/loc>/);
  assert.match(sitemapXml, /<loc>https:\/\/www\.realview\.com\.vn\/bai-viet\/review-gia-la-gi-dau-hieu-nhan-biet<\/loc>/);
  assert.doesNotMatch(sitemapXml, /cach-doc-review-thong-minh/);
  assert.doesNotMatch(sitemapXml, /https:\/\/realview\.com\.vn\//);
  assert.doesNotMatch(sitemapXml, /results\.html/);
  assert.match(sitemapXml, /xmlns:image="http:\/\/www\.google\.com\/schemas\/sitemap-image\/1\.1"/);
});
