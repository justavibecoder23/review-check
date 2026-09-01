import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const pages = ['index.html', 'results.html', 'criteria.html', 'contact.html'];
const oldHeadsetPath = 'M4 14v-2a8 8 0 0 1 16 0v2';

test('các trang dùng logo RV thay cho biểu tượng tai nghe', async () => {
  const logo = await readFile(new URL('../public/assets/realview-rv.png', import.meta.url));
  assert.equal(logo.subarray(1, 4).toString(), 'PNG');
  assert.equal(logo.readUInt32BE(16), 1400);
  assert.equal(logo.readUInt32BE(20), 823);
  assert.equal(logo[25], 6, 'logo phải là PNG RGBA có kênh alpha');

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
