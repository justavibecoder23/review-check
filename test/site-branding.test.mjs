import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const pages = ['index.html', 'results.html', 'criteria.html', 'contact.html'];
const oldHeadsetPath = 'M4 14v-2a8 8 0 0 1 16 0v2';

test('các trang dùng logo RV thay cho biểu tượng tai nghe', async () => {
  await access(new URL('../public/assets/realview-rv.png', import.meta.url));

  for (const page of pages) {
    const html = await readFile(new URL(`../public/${page}`, import.meta.url), 'utf8');
    assert.match(html, /<span class="brand-mark"[^>]*>\s*<img src="\/assets\/realview-rv\.png"/);
    assert.doesNotMatch(html, new RegExp(oldHeadsetPath));
  }
});

test('nút và avatar trợ lý dùng cùng logo RV', async () => {
  const chatbot = await readFile(new URL('../public/chatbot.js', import.meta.url), 'utf8');
  assert.match(chatbot, /class="chatbot-logo" src="\/assets\/realview-rv\.png"/);
  assert.match(chatbot, /class="chatbot-avatar"[\s\S]*?<img src="\/assets\/realview-rv\.png"/);
  assert.doesNotMatch(chatbot, /M12 3a8 8 0 0 0-8 8v5/);
});
