import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  articleViewInternals,
  articleVisitorKey,
  normalizeArticleSlug,
  readArticleViews,
  recordArticleView
} from '../src/article-views.mjs';

test.beforeEach(() => {
  articleViewInternals.memoryCounts.clear();
  articleViewInternals.memoryVisitors.clear();
});

test('lượt xem chỉ tăng một lần cho cùng người đọc trong cửa sổ sáu giờ', async () => {
  const slug = normalizeArticleSlug('cach-doc-review-thong-minh');
  assert.equal(await recordArticleView(slug, 'visitor-a'), 1);
  assert.equal(await recordArticleView(slug, 'visitor-a'), 1);
  assert.equal(await recordArticleView(slug, 'visitor-b'), 2);
  assert.equal(await readArticleViews(slug), 2);
});

test('khóa người đọc không lưu trực tiếp IP hay user agent', () => {
  const key = articleVisitorKey({
    headers: { 'x-forwarded-for': '203.0.113.7', 'user-agent': 'Real Browser' },
    socket: {}
  }, 'cach-doc-review-thong-minh');
  assert.match(key, /^[a-f0-9]{32}$/);
  assert.doesNotMatch(key, /203\.0\.113\.7|Real Browser/);
});

test('mã bài viết bị giới hạn để không tạo khóa Redis tùy ý', () => {
  assert.throws(() => normalizeArticleSlug('../admin'), /không hợp lệ/);
});

test('blog hiển thị lượt xem và gọi API trên trang bài viết', async () => {
  const [hub, article, client, vercel] = await Promise.all([
    readFile(new URL('../public/blog.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/blog/cach-doc-review-thong-minh.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/article-views.js', import.meta.url), 'utf8'),
    readFile(new URL('../vercel.json', import.meta.url), 'utf8')
  ]);
  assert.match(hub, /data-article-view-count/);
  assert.match(article, /data-article-slug="cach-doc-review-thong-minh"/);
  assert.match(client, /\/api\/article-views/);
  assert.match(vercel, /"source": "\/api\/article-views"/);
});
