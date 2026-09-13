import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const pages = [
  'index.html',
  'results.html',
  'criteria.html',
  'contact.html',
  'blog.html',
  'blog/trustscore-la-gi.html',
  'blog/kiem-tra-do-tin-cay-review-truoc-khi-mua-hang.html'
];
const oldHeadsetPath = 'M4 14v-2a8 8 0 0 1 16 0v2';

test('các trang dùng logo RV thay cho biểu tượng tai nghe', async () => {
  const logo = await readFile(new URL('../public/assets/realview-logo-v1.webp', import.meta.url));
  assert.equal(logo.subarray(0, 4).toString(), 'RIFF');
  assert.equal(logo.subarray(8, 12).toString(), 'WEBP');
  assert.ok(logo.byteLength < 10_000, 'logo WebP phải nhỏ hơn 10 KB');

  for (const page of pages) {
    const html = await readFile(new URL(`../public/${page}`, import.meta.url), 'utf8');
    assert.match(html, /<span class="brand-mark"[^>]*>\s*<img src="\/assets\/realview-logo-v1\.webp"[^>]+width="128"[^>]+height="75"/);
    assert.doesNotMatch(html, new RegExp(oldHeadsetPath));
  }
});

test('nút và avatar trợ lý dùng cùng logo RV', async () => {
  const chatbot = await readFile(new URL('../public/chatbot.js', import.meta.url), 'utf8');
  assert.match(chatbot, /class="chatbot-logo" src="\/assets\/realview-logo-v1\.webp"/);
  assert.match(chatbot, /class="chatbot-avatar"[\s\S]*?<img src="\/assets\/realview-logo-v1\.webp"/);
  assert.doesNotMatch(chatbot, /M12 3a8 8 0 0 0-8 8v5/);
});

test('các trang dùng logo RV trong suốt làm favicon và không tham chiếu icon nền vuông', async () => {
  for (const page of pages) {
    const html = await readFile(new URL(`../public/${page}`, import.meta.url), 'utf8');
    assert.match(html, /rel="icon" type="image\/png" sizes="32x32" href="\/assets\/favicon-v1-32\.png"/);
    assert.match(html, /rel="icon" type="image\/png" sizes="48x48" href="\/assets\/favicon-v1-48\.png"/);
    assert.match(html, /rel="apple-touch-icon" sizes="180x180" href="\/assets\/apple-touch-icon-v1\.png"/);
    assert.doesNotMatch(html, /favicon\.svg/);
  }
});
