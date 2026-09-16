import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const nav = readFileSync(new URL('../public/nav.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const chatbotStyles = readFileSync(new URL('../public/chatbot.css', import.meta.url), 'utf8');
const criteriaStyles = readFileSync(new URL('../public/criteria.css', import.meta.url), 'utf8');
const criteriaSection = readFileSync(new URL('../public/criteria-section.js', import.meta.url), 'utf8');
const publicPages = [
  '../public/index.html',
  '../public/contact.html',
  '../public/results.html',
  '../public/criteria.html',
  '../public/blog.html',
  '../public/blog/trustscore-la-gi.html',
  '../public/blog/kiem-tra-do-tin-cay-review-truoc-khi-mua-hang.html',
  '../public/blog/shopee-hay-tiktok-shop-mua-hang-o-dau-tot-hon.html',
  '../public/blog/shopee-mall-la-gi-co-nen-mua-khong.html',
  '../public/blog/tiktok-shop-la-gi-mua-hang-tren-tiktok-co-an-toan-khong.html',
  '../public/blog/cach-tim-shop-uy-tin-tren-shopee.html'
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'));

test('tablet portrait uses the collapsed navigation layout', () => {
  assert.match(styles, /@media \(max-width: 1024px\) \{[\s\S]*?\.main-nav \{ position: absolute;/);
  assert.match(styles, /\.header-inner > \.main-nav \{ justify-self: stretch; \}/);
  assert.match(styles, /\.main-nav \{ position: absolute;[^}]*width: auto;[^}]*min-width: 0;/);
  assert.match(nav, /matchMedia\('\(max-width: 1024px\)'\)/);
  assert.match(app, /window\.innerWidth > 1024/);
});

test('phone refinements win over the later readability overrides', () => {
  const refinement = styles.lastIndexOf('@media (max-width: 700px)');
  const readability = styles.indexOf('main .hero-description { font-size: 16px; }');

  assert.ok(refinement > readability);
  assert.match(styles.slice(refinement), /main \.hero-description \{ font-size: 15px;/);
  assert.match(styles.slice(refinement), /main \.supported \{ font-size: clamp\(10px, 2\.8vw, 11px\);/);
});

test('chatbot giữ đúng khung khi context dài hoặc ẩn và không kích hoạt auto zoom lúc nhập', () => {
  assert.match(chatbotStyles, /grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(chatbotStyles, /\.chatbot-panel > \* \{ min-width: 0; \}/);
  assert.match(chatbotStyles, /\.chatbot-header \{ grid-row: 1;/);
  assert.match(chatbotStyles, /\.chatbot-context \{ grid-row: 2; max-width: calc\(100% - 28px\);/);
  assert.match(chatbotStyles, /\.chatbot-context span \{ min-width: 0; flex: 1 1 auto;[^}]*text-overflow: ellipsis;/);
  assert.match(chatbotStyles, /\.chatbot-messages \{ grid-row: 3; min-height: 0;/);
  assert.match(chatbotStyles, /\.chatbot-form \{ grid-row: 4;/);
  assert.match(chatbotStyles, /\.chatbot-input-shell textarea \{ min-height: 42px;[^}]*font-size: 16px;/);
});

test('hero illustration has no square dot decoration and keeps a responsive ratio', () => {
  assert.doesNotMatch(index, /dot-grid/);
  assert.doesNotMatch(styles, /\.dot-grid/);
  assert.match(styles, /\.hero-visual \{ width: min\(100%, 560px\); aspect-ratio: 4 \/ 3; height: auto;/);
  assert.match(styles, /\.hero-visual > \.hero-illustration \{ inset: 0; width: 100%; height: 100%; object-fit: contain;/);
});

test('desktop hero artwork is reduced around its existing center', () => {
  assert.match(styles, /\.orange-blob \{[^}]*transform: rotate\(-4deg\) scale\(\.94\); transform-origin: center center;/);
  assert.match(styles, /\.orange-blob::after \{[^}]*top: 9%; right: -5%; width: 34%;[^}]*aspect-ratio: 1;/);
  assert.match(styles, /\.hero-visual > \.hero-illustration \{[^}]*transform: translateX\(-12px\) rotate\(-2deg\) scale\(\.97\); transform-origin: center center;/);
  assert.match(styles, /@media \(max-width: 700px\) \{[\s\S]*?\.hero-visual > \.hero-illustration \{[^}]*transform: rotate\(-1\.2deg\) scale\(1\.02\);/);
});

test('about decoration stays clear of copy across responsive layouts', () => {
  assert.match(styles, /\.about-section::before \{[^}]*top: -60px;[^}]*right: -200px;[^}]*width: 280px; height: 280px;[^}]*pointer-events: none;/);
  assert.match(styles, /@media \(max-width: 1024px\) \{[\s\S]*?\.about-section::before \{ top: -40px; right: -160px; width: 220px; height: 220px; \}/);
  assert.match(styles, /@media \(max-width: 700px\) \{[\s\S]*?\.about-section::before \{ top: -30px; right: -105px; width: 150px; height: 150px; \}/);
});

test('criteria closing note stays on one desktop row without the artwork badge', () => {
  assert.doesNotMatch(criteriaSection, /criteria-art-tag|Cách chúng tôi đánh giá/i);
  assert.doesNotMatch(criteriaStyles, /\.criteria-art-tag/);
  assert.match(criteriaStyles, /\.criteria-closing \{ max-width: 1240px;[^}]*gap: 32px;/);
  assert.match(criteriaStyles, /\.criteria-closing p \{[^}]*flex: 1 1 auto;[^}]*white-space: nowrap;/);
  assert.match(criteriaStyles, /@media \(max-width: 980px\)[\s\S]*?\.criteria-closing p \{ white-space: normal; \}/);
});

test('contact and every page footer expose responsive social links', () => {
  for (const page of publicPages) {
    const footer = page.match(/<footer class="site-footer[\s\S]*?<\/footer>/)?.[0] || '';
    assert.match(footer, /class="[^"]*footer-grid[^"]*"[\s\S]*class="footer-brand"[\s\S]*class="footer-menu-group"/);
    assert.match(footer, /class="footer-menu-group"[\s\S]*class="footer-social"[\s\S]*class="footer-links"/);
    assert.match(footer, /class="footer-social"/);
    assert.match(footer, /href="https:\/\/www\.facebook\.com\/profile\.php\?id=61594093477895"/);
    assert.match(footer, /href="https:\/\/www\.tiktok\.com\/@realviewueh"/);
    assert.equal((footer.match(/<svg /g) || []).length >= 2, true);
    assert.doesNotMatch(footer, /footer-social[\s\S]*?<img /);
  }

  const contact = publicPages[1];
  assert.match(contact, /Phạm vi[\s\S]*Kết nối[\s\S]*contact-social-links/);
  assert.match(contact, /M10 13a5 5 0 0 0 7\.1\.1l2-2/);
  assert.match(nav, /https:\/\/www\.instagram\.com\/real\.viewueh\?stkn=em9tdjNmcTJ5OW91/);
  assert.match(nav, /https:\/\/www\.threads\.com\/@real\.viewueh/);
  assert.match(nav, /asset: '\/assets\/threads-logo\.svg'/);
  assert.match(nav, /document\.querySelectorAll\('\.footer-social'\)/);
  assert.match(nav, /document\.querySelector\('\.contact-social-links'\)/);
  assert.match(nav, /target = '_blank'/);
  assert.match(nav, /rel = 'noopener noreferrer'/);
  assert.match(styles, /\.contact-social-links \{[^}]*gap: 12px;/);
  assert.match(styles, /\.contact-social-links svg \{[^}]*width: 20px; height: 20px;/);
  assert.match(styles, /\.footer-social \.social-icon-outline \{ fill: none; stroke: currentColor;/);
  assert.match(styles, /\.footer-social \.social-icon-threads \{ display: inline-block; background-color: currentColor;/);
  assert.match(styles, /\.contact-social-links \.social-icon-threads \{ width: 20px; height: 20px; \}/);
  assert.match(styles, /\.footer-social a \{[^}]*color: #666666;[^}]*font-size: 11px;[^}]*text-decoration: none;[^}]*transition:/);
  assert.match(styles, /\.footer-social a:hover, \.footer-social a:focus-visible \{ color: #FC781F; \}/);
  assert.match(styles, /\.footer-grid \{[^}]*grid-template-columns: minmax\(210px, \.7fr\) minmax\(0, 1\.8fr\);[^}]*align-items: flex-start;/);
  assert.match(styles, /\.footer-brand \{ height: 100%; \}/);
  assert.match(styles, /\.footer-menu-group \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);[^}]*gap: 28px;[^}]*padding-left: 60px;[^}]*border-left: 2px solid var\(--orange\);[^}]*align-items: flex-start;/);
  assert.match(styles, /\.footer-links \{ display: contents; \}/);
  assert.match(styles, /\.footer-links a, \.footer-links span \{[^}]*min-height: 24px;[^}]*margin: 8px 0;[^}]*display: flex;[^}]*align-items: center;[^}]*line-height: 1\.4;/);
  assert.match(styles, /@media \(max-width: 1024px\) \{[\s\S]*?\.footer-grid \{ grid-template-columns: 1fr;/);
  assert.match(styles, /@media \(max-width: 1024px\) \{[\s\S]*?\.footer-menu-group \{[^}]*border-top: 2px solid var\(--orange\);[^}]*border-left: 0;/);
  assert.match(styles, /@media \(max-width: 768px\) \{[\s\S]*?\.site-footer \{ padding: 32px 16px; \}/);
  assert.match(styles, /@media \(max-width: 768px\) \{[\s\S]*?\.footer-grid \{ grid-template-columns: 1fr; gap: 24px; \}/);
  assert.match(styles, /@media \(max-width: 768px\) \{[\s\S]*?\.footer-menu-group \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);[^}]*gap: 24px 16px;[^}]*padding: 24px 0 0;[^}]*text-align: left;/);
  assert.match(styles, /@media \(max-width: 768px\) \{[\s\S]*?\.footer-menu-group > \.footer-social \{ grid-column: 2; grid-row: 1; \}[\s\S]*?\.footer-links > div:nth-child\(2\) \{ grid-column: 1; grid-row: 2; \}[\s\S]*?\.footer-links > div:nth-child\(3\) \{ grid-column: 2; grid-row: 2; \}/);
  assert.match(styles, /@media \(max-width: 768px\) \{[\s\S]*?\.footer-links h2,[\s\S]*?\.footer-social h3 \{ margin: 0 0 8px; \}/);
  assert.match(styles, /@media \(max-width: 768px\) \{[\s\S]*?\.footer-links a,[\s\S]*?\.footer-social a \{[^}]*min-height: 0;[^}]*margin: 0;[^}]*padding: 6px 0;[^}]*line-height: 1\.5;/);
  assert.match(styles, /@media \(max-width: 700px\) \{\s*\.footer-social a \{\s*min-height: 44px;/);
});
