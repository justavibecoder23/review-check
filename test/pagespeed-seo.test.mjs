import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const pages = ['index.html', 'results.html', 'criteria.html', 'contact.html'];

test('critical image and shared branding assets are optimized', async () => {
  const homepage = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(homepage, /open-doodles-laying-v1\.svg[^>]+fetchpriority="high"[^>]+loading="eager"[^>]+decoding="async"/);

  const logo = await stat(new URL('../public/assets/realview-logo-v1.webp', import.meta.url));
  assert.ok(logo.size < 10_000, `optimized logo is unexpectedly large: ${logo.size} bytes`);

  for (const page of pages) {
    const html = await readFile(new URL(`../public/${page}`, import.meta.url), 'utf8');
    assert.match(html, /realview-logo-v1\.webp/);
    assert.match(html, /apple-touch-icon-v1\.png/);
  }
});

test('indexable pages declare canonical metadata and results remain out of the index', async () => {
  const expectedCanonicals = new Map([
    ['index.html', 'https://www.realview.com.vn/'],
    ['criteria.html', 'https://www.realview.com.vn/criteria.html'],
    ['contact.html', 'https://www.realview.com.vn/contact.html']
  ]);

  for (const [page, canonical] of expectedCanonicals) {
    const html = await readFile(new URL(`../public/${page}`, import.meta.url), 'utf8');
    assert.match(html, new RegExp(`<link rel="canonical" href="${canonical.replaceAll('.', '\\.')}`));
    assert.match(html, /<meta name="robots" content="index, follow"/);
    assert.match(html, /<meta property="og:title"/);
  }

  const results = await readFile(new URL('../public/results.html', import.meta.url), 'utf8');
  assert.match(results, /<meta name="robots" content="noindex, follow"/);
  assert.doesNotMatch(results, /rel="canonical"/);
});

test('robots, sitemap, cache and accessibility policies are explicit', async () => {
  const [robots, sitemap, vercel, auth, styles] = await Promise.all([
    readFile(new URL('../public/robots.txt', import.meta.url), 'utf8'),
    readFile(new URL('../public/sitemap.xml', import.meta.url), 'utf8'),
    readFile(new URL('../vercel.json', import.meta.url), 'utf8'),
    readFile(new URL('../public/auth.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/styles.css', import.meta.url), 'utf8')
  ]);

  assert.match(robots, /Disallow: \/api\//);
  assert.match(robots, /Sitemap: https:\/\/www\.realview\.com\.vn\/sitemap\.xml/);
  assert.match(sitemap, /https:\/\/www\.realview\.com\.vn\/criteria\.html/);
  assert.doesNotMatch(sitemap, /results\.html/);
  assert.match(vercel, /realview-logo-v1\.webp/);
  assert.doesNotMatch(vercel, /source": "\/api\/[^"]+"[\s\S]{0,160}immutable/);
  assert.match(auth, /aria-label="Đăng nhập \/ Đăng ký"/);
  assert.match(styles, /--orange-text: #b44300/);
  assert.match(styles, /\.footer-links a \{\s*min-height: 44px/);
});
