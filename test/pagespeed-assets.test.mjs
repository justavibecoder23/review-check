import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const publicPages = [
  'index.html',
  'results.html',
  'criteria.html',
  'contact.html',
  'blog.html',
  'blog/cach-doc-review-thong-minh.html'
];

test('critical images and shared branding assets are optimized', async () => {
  const homepage = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(homepage, /open-doodles-laying-v1\.jpg[^>]+fetchpriority="high"[^>]+loading="eager"[^>]+decoding="async"/);

  const logo = await stat(new URL('../public/assets/realview-logo-v1.jpg', import.meta.url));
  assert.ok(logo.size < 10_000, `optimized logo is unexpectedly large: ${logo.size} bytes`);

  for (const page of publicPages) {
    const html = await readFile(new URL(`../public/${page}`, import.meta.url), 'utf8');
    assert.match(html, /realview-logo-v1\.jpg/);
    assert.match(html, /apple-touch-icon-v1\.jpg/);
    assert.match(html, /<script defer src="\/analytics\.js"><\/script>/);
  }
});
test('only versioned static assets receive immutable caching', async () => {
  const vercel = await readFile(new URL('../vercel.json', import.meta.url), 'utf8');
  assert.match(vercel, /realview-logo-v1\.jpg/);
  assert.match(vercel, /open-doodles-laying-v1\.jpg/);
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

test('mọi ảnh tĩnh mà giao diện tải đều dùng định dạng JPG', async () => {
  for (const page of publicPages) {
    const html = await readFile(new URL(`../public/${page}`, import.meta.url), 'utf8');
    assert.doesNotMatch(html, /(?:src|href|content)="[^"]+\.(?:png|webp|svg)(?:\?|\")/i);
  }
  for (const script of ['auth.js', 'chatbot.js', 'criteria-section.js']) {
    const source = await readFile(new URL(`../public/${script}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\/assets\/[^"]+\.(?:png|webp|svg)/i);
  }
});
