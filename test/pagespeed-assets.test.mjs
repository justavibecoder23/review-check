import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const publicPages = [
  'index.html',
  'results.html',
  'criteria.html',
  'contact.html',
  'blog.html',
  'blog/trustscore-la-gi.html',
  'blog/kiem-tra-do-tin-cay-review-truoc-khi-mua-hang.html',
  'blog/shopee-hay-tiktok-shop-mua-hang-o-dau-tot-hon.html',
  'blog/shopee-mall-la-gi-co-nen-mua-khong.html',
  'blog/tiktok-shop-la-gi-mua-hang-tren-tiktok-co-an-toan-khong.html',
  'blog/cach-tim-shop-uy-tin-tren-shopee.html'
];

test('critical images and shared branding assets are optimized', async () => {
  const homepage = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(homepage, /open-doodles-laying-v1\.svg[^>]+fetchpriority="high"[^>]+loading="eager"[^>]+decoding="async"/);

  const logo = await stat(new URL('../public/assets/realview-logo-v1.webp', import.meta.url));
  assert.ok(logo.size < 10_000, `optimized logo is unexpectedly large: ${logo.size} bytes`);

  for (const page of publicPages) {
    const html = await readFile(new URL(`../public/${page}`, import.meta.url), 'utf8');
    assert.match(html, /realview-logo-v1\.webp/);
    assert.match(html, /apple-touch-icon-v1\.png/);
    assert.match(html, /<script defer src="\/analytics\.js"><\/script>/);
  }
});

test('only versioned static assets receive immutable caching', async () => {
  const vercel = await readFile(new URL('../vercel.json', import.meta.url), 'utf8');
  assert.match(vercel, /realview-logo-v1\.webp/);
  assert.match(vercel, /open-doodles-laying-v1\.svg/);
  assert.doesNotMatch(vercel, /source": "\/api\/[^\"]+"[\s\S]{0,160}immutable/);
});

test('interactive controls retain accessible mobile targets and labels', async () => {
  const [auth, styles] = await Promise.all([
    readFile(new URL('../public/auth.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/styles.css', import.meta.url), 'utf8')
  ]);
  assert.match(auth, /aria-label="Đăng nhập \/ Đăng ký"/);
  assert.match(styles, /\.footer-links a \{\s*min-height: 44px/);
});

test('homepage reserves mascot and account controls before JavaScript starts', async () => {
  const [html, styles, chatbot] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/chatbot.js', import.meta.url), 'utf8')
  ]);
  assert.equal((html.match(/class="realviewee-stage realviewee-stage--home"/g) || []).length, 1);
  assert.match(html, /class="header-auth" data-auth-controls/);
  assert.match(html, /class="header-actions"/);
  assert.match(chatbot, /homeHost\.querySelector\('\.realviewee-stage--home'\)/);
  assert.match(styles, /\.guest-quota-status \{[^}]*min-height:/);
  assert.doesNotMatch(styles, /\.guest-quota-status:empty\s*\{\s*display:\s*none/);
});

test('mobile critical CSS is current and full widget CSS stays blocking on desktop', async () => {
  execFileSync(process.execPath, [new URL('../tools/build-home-widget-css.mjs', import.meta.url).pathname, '--check']);
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /href="\/home-widgets\.css" media="\(max-width: 700px\)"/);
  for (const file of ['auth.css', 'history.css', 'chatbot.css']) {
    assert.ok(html.includes(`href="/${file}" media="(min-width: 701px)" onload="this.media='all'"`));
  }
  for (const file of ['app.js', 'auth.js', 'history-ui.js']) {
    const js = await readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
    assert.match(js, /matchMedia\('\(max-width: 700px\)'\)/);
    assert.match(js, /window\.requestAnimationFrame\(\(\) => window\.requestAnimationFrame/);
    assert.match(js, /window\.addEventListener\('load'/);
  }
});

test('homepage mobile uses compact frames while desktop keeps complete WebP atlases', async () => {
  let initialBytes = 0;
  for (const name of ['realviewee-happy-mobile-v1', 'realviewee-running-mobile-v1', 'realviewee-running-default-step-b-v2']) {
    initialBytes += (await stat(new URL(`../public/assets/mascot/${name}.webp`, import.meta.url))).size;
  }
  assert.ok(initialBytes < 90_000, `initial mobile mascot images are too large: ${initialBytes}`);
  const css = await readFile(new URL('../public/chatbot.css', import.meta.url), 'utf8');
  assert.match(css, /realviewee-sprite-v2\.webp/);
  assert.match(css, /@media \(max-width: 700px\) \{[\s\S]*realviewee-running-mobile-v1\.webp/);
  assert.doesNotMatch(css, /url\([^)]*realviewee-sprite-v[12]\.png/);
});
