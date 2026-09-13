import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const nav = readFileSync(new URL('../public/nav.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const publicPages = [
  '../public/index.html',
  '../public/contact.html',
  '../public/results.html',
  '../public/criteria.html',
  '../public/blog.html',
  '../public/blog/trustscore-la-gi.html',
  '../public/blog/kiem-tra-do-tin-cay-review-truoc-khi-mua-hang.html'
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

test('hero illustration has no square dot decoration and keeps a responsive ratio', () => {
  assert.doesNotMatch(index, /dot-grid/);
  assert.doesNotMatch(styles, /\.dot-grid/);
  assert.match(styles, /\.hero-visual \{ width: min\(100%, 560px\); aspect-ratio: 4 \/ 3; height: auto;/);
  assert.match(styles, /\.hero-visual > \.hero-illustration \{ inset: 0; width: 100%; height: 100%; object-fit: contain;/);
});

test('about decoration stays clear of copy across responsive layouts', () => {
  assert.match(styles, /\.about-section::before \{[^}]*top: -60px;[^}]*right: -200px;[^}]*width: 280px; height: 280px;[^}]*pointer-events: none;/);
  assert.match(styles, /@media \(max-width: 1024px\) \{[\s\S]*?\.about-section::before \{ top: -40px; right: -160px; width: 220px; height: 220px; \}/);
  assert.match(styles, /@media \(max-width: 700px\) \{[\s\S]*?\.about-section::before \{ top: -30px; right: -105px; width: 150px; height: 150px; \}/);
});

test('contact and every page footer expose responsive Facebook and TikTok links', () => {
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
  assert.match(styles, /\.contact-social-links \{[^}]*gap: 12px;/);
  assert.match(styles, /\.contact-social-links svg \{[^}]*width: 20px; height: 20px;/);
  assert.match(styles, /\.footer-social a \{[^}]*color: #666666;[^}]*font-size: 11px;[^}]*text-decoration: none;[^}]*transition:/);
  assert.match(styles, /\.footer-social a:hover, \.footer-social a:focus-visible \{ color: #FC781F; \}/);
  assert.match(styles, /\.footer-grid \{[^}]*grid-template-columns: minmax\(210px, \.7fr\) minmax\(0, 1\.8fr\);[^}]*align-items: flex-start;/);
  assert.match(styles, /\.footer-brand \{ height: 100%; \}/);
  assert.match(styles, /\.footer-menu-group \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);[^}]*gap: 28px;[^}]*padding-left: 60px;[^}]*border-left: 2px solid var\(--orange\);[^}]*align-items: flex-start;/);
  assert.match(styles, /\.footer-links \{ display: contents; \}/);
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
