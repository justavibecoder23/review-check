import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const pages = [
  'index.html',
  'results.html',
  'criteria.html',
  'contact.html',
  'blog.html',
  'blog/cach-doc-review-thong-minh.html'
];
const oldHeadsetPath = 'M4 14v-2a8 8 0 0 1 16 0v2';

test('các trang dùng logo RV thay cho biểu tượng tai nghe', async () => {
  const logo = await readFile(new URL('../public/assets/realview-logo-v1.jpg', import.meta.url));
  assert.equal(logo.subarray(0, 3).toString('hex'), 'ffd8ff');
  assert.ok(logo.byteLength < 10_000, 'logo JPG phải nhỏ hơn 10 KB');

  for (const page of pages) {
    const html = await readFile(new URL(`../public/${page}`, import.meta.url), 'utf8');
    assert.match(html, /<span class="brand-mark"[^>]*>\s*<img src="\/assets\/realview-logo-v1\.jpg"[^>]+width="128"[^>]+height="75"/);
    assert.doesNotMatch(html, new RegExp(oldHeadsetPath));
  }
});
test('nút và avatar trợ lý dùng cùng logo RV', async () => {
  const chatbot = await readFile(new URL('../public/chatbot.js', import.meta.url), 'utf8');
  assert.match(chatbot, /class="chatbot-logo" src="\/assets\/realview-logo-v1\.jpg"/);
  assert.match(chatbot, /class="chatbot-avatar"[\s\S]*?<img src="\/assets\/realview-logo-v1\.jpg"/);
  assert.doesNotMatch(chatbot, /M12 3a8 8 0 0 0-8 8v5/);
});

test('các trang dùng favicon JPG đồng nhất với logo RV', async () => {
  for (const page of pages) {
    const html = await readFile(new URL(`../public/${page}`, import.meta.url), 'utf8');
    assert.match(html, /rel="icon" type="image\/jpeg" sizes="32x32" href="\/assets\/favicon-v1-32\.jpg"/);
    assert.match(html, /rel="icon" type="image\/jpeg" sizes="48x48" href="\/assets\/favicon-v1-48\.jpg"/);
    assert.match(html, /rel="apple-touch-icon" sizes="180x180" href="\/assets\/apple-touch-icon-v1\.jpg"/);
    assert.doesNotMatch(html, /favicon-v1-(?:32|48)\.(?:png|webp|svg)/);
  }
});
