import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import blogPostHandler from '../src/blog-post-route.mjs';
import blogIndexHandler from '../src/blog-index-route.mjs';
import blogSitemapHandler from '../src/blog-sitemap-route.mjs';
import { blogAdminRouteInternals } from '../src/blog-admin-route.mjs';

const root = new URL('../public/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('blog/snapshots/snapshot-manifest.json', root), 'utf8'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function responseMock() {
  const headers = new Map();
  return {
    statusCode: 200,
    body: '',
    setHeader(name, value) { headers.set(name.toLowerCase(), value); },
    getHeader(name) { return headers.get(name.toLowerCase()); },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = JSON.stringify(value); return this; },
    end(value = '') { this.body += value || ''; }
  };
}

test('bản tĩnh giữ nguyên từng byte HTML ngoại trừ URL ảnh đã mirror', async () => {
  assert.equal(manifest.articles.length, 19);
  assert.equal(manifest.articles.filter((article) => article.path.endsWith('.html')).length, 18);
  for (const article of manifest.articles) {
    const html = await readFile(new URL(article.path, root), 'utf8');
    assert.equal(sha256(html), article.deployedSha256, article.path);
    assert.doesNotMatch(html, /\.public\.blob\.vercel-storage\.com/);
    let original = html;
    for (const image of manifest.images) {
      original = original.replaceAll(`https://www.realview.com.vn${image.local}`, image.source);
    }
    assert.equal(sha256(original), article.originalSha256, article.path);
  }
  for (const image of manifest.images) {
    const bytes = await readFile(new URL(image.local.replace(/^\//, ''), root));
    assert.equal(bytes.length, image.bytes, image.local);
    assert.equal(sha256(bytes), image.sha256, image.local);
  }
});

test('toàn bộ bài published, index và sitemap đọc bản tĩnh mà không cần Redis/Blob', async () => {
  const previous = process.env.BLOG_PUBLIC_SNAPSHOT;
  delete process.env.BLOG_PUBLIC_SNAPSHOT;
  try {
    for (const article of manifest.articles.filter((item) => item.path.endsWith('.html') && !item.path.endsWith('index-snapshot.html'))) {
      const slug = article.path.split('/').at(-1).replace(/\.html$/, '');
      const response = responseMock();
      await blogPostHandler({ method: 'GET', query: { slug } }, response);
      assert.equal(response.statusCode, 200, slug);
      assert.equal(sha256(response.body), article.deployedSha256, slug);
      const head = responseMock();
      await blogPostHandler({ method: 'HEAD', query: { slug } }, head);
      assert.equal(head.statusCode, 200, slug);
      assert.equal(head.body, '');
    }
    const index = responseMock();
    await blogIndexHandler({ method: 'GET' }, index);
    assert.equal(index.statusCode, 200);
    assert.equal(sha256(index.body), manifest.articles.find((item) => item.path.endsWith('index-snapshot.html')).deployedSha256);
    const sitemap = responseMock();
    await blogSitemapHandler({ method: 'GET' }, sitemap);
    assert.equal(sitemap.statusCode, 200);
    assert.equal(sha256(sitemap.body), manifest.articles.find((item) => item.path.endsWith('sitemap-snapshot.xml')).deployedSha256);
  } finally {
    if (previous === undefined) delete process.env.BLOG_PUBLIC_SNAPSHOT;
    else process.env.BLOG_PUBLIC_SNAPSHOT = previous;
  }
});

test('rewrites công khai trỏ đúng 17 bài và không gọi function', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  for (const article of manifest.articles.filter((item) => item.path.endsWith('.html') && !item.path.endsWith('index-snapshot.html'))) {
    const slug = article.path.split('/').at(-1).replace(/\.html$/, '');
    assert.deepEqual(
      config.rewrites.filter((rule) => rule.source === `/bai-viet/${slug}`).map((rule) => rule.destination),
      [`/${article.path}`],
      slug
    );
  }
  assert.equal(config.rewrites.find((rule) => rule.source === '/bai-viet')?.destination, '/blog/snapshots/index-snapshot.html');
  assert.equal(config.rewrites.find((rule) => rule.source === '/sitemap.xml')?.destination, '/blog/snapshots/sitemap-snapshot.xml');
});

test('Studio không báo xuất bản thành công khi bản công khai đang đóng băng', async () => {
  const previous = process.env.BLOG_PUBLIC_SNAPSHOT;
  delete process.env.BLOG_PUBLIC_SNAPSHOT;
  try {
    for (const action of ['publish', 'unpublish', 'archive', 'import_legacy']) {
      const response = responseMock();
      await blogAdminRouteInternals.handlePost({}, response, { action }, { role: 'admin' });
      assert.equal(response.statusCode, 409, action);
      assert.equal(JSON.parse(response.body).code, 'BLOG_PUBLIC_SNAPSHOT_FROZEN', action);
    }
  } finally {
    if (previous === undefined) delete process.env.BLOG_PUBLIC_SNAPSHOT;
    else process.env.BLOG_PUBLIC_SNAPSHOT = previous;
  }
});
