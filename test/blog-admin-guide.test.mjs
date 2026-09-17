import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('Blog Studio có hướng dẫn năm chương, mục lục neo và ví dụ trực quan', async () => {
  const html = await readFile(new URL('public/admin-blog.html', root), 'utf8');
  assert.match(html, /data-view-link="guide"/);
  assert.match(html, /data-view="guide"/);
  for (const id of ['guide-content', 'guide-seo', 'guide-media', 'guide-settings', 'guide-revisions']) {
    assert.match(html, new RegExp(`href="#${id}"`));
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const term of ['Alt mô tả nội dung ảnh là gì?', 'Slug là gì?', 'Canonical URL là gì?', 'Search intent', 'Revision là gì?']) {
    assert.match(html, new RegExp(term.replace(/[?]/g, '\\?')));
  }
  assert.match(html, /\/assets\/blog\/review-5-sao-co-dang-tin-thumbnail\.jpg/);
  assert.match(html, /\/assets\/blog\/seo08-27-image5\.jpg/);
  assert.match(html, /data-guide-new/);
});

test('hướng dẫn có điều hướng an toàn và responsive riêng', async () => {
  const [script, css] = await Promise.all([
    readFile(new URL('public/admin-blog.js', root), 'utf8'),
    readFile(new URL('public/admin-blog.css', root), 'utf8')
  ]);
  assert.match(script, /function openGuide\(\)/);
  assert.match(script, /Bạn đang có thay đổi chưa được lưu/);
  assert.match(script, /showView\('guide'\)/);
  assert.match(css, /\.admin-guide-layout/);
  assert.match(css, /\.admin-guide-toc \{ position: static/);
  assert.match(css, /\.admin-guide-grid \{ grid-template-columns: 1fr/);
});
