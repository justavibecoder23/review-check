#!/usr/bin/env node
// Freeze today's public HTML and exactly referenced image bytes in the deploy.
// This is a read-only export from production: no Blob list(), put(), or Redis writes.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

const origin = 'https://www.realview.com.vn';
const root = new URL('../public/', import.meta.url).pathname;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const blobPattern = /https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\/[^\s"'<>]+/gi;
const fetchFresh = async (path) => {
  const response = await fetch(`${origin}${path}${path.includes('?') ? '&' : '?'}snapshot=${Date.now()}`, {
    headers: { accept: 'text/html,application/xml;q=0.9,*/*;q=0.8' },
    signal: AbortSignal.timeout(25_000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${path}`);
  return response.text();
};
const writeVerified = async (pathname, bytes) => {
  await mkdir(join(root, posix.dirname(pathname)), { recursive: true });
  const target = join(root, pathname);
  try {
    const prior = await readFile(target);
    if (hash(prior) !== hash(bytes)) throw new Error(`File đã tồn tại nhưng nội dung khác: ${pathname}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await writeFile(target, bytes, { flag: 'wx' });
  }
};

const api = await fetch(`${origin}/api/blog-public`, { signal: AbortSignal.timeout(25_000) });
if (!api.ok) throw new Error(`Không đọc được danh sách blog: ${api.status}`);
const listing = await api.json();
if (!listing.cmsAvailable || !Array.isArray(listing.posts)) throw new Error('CMS public không sẵn sàng.');
const posts = listing.posts;
if (!posts.length) throw new Error('Không có bài published để snapshot.');
let existing = { articles: [], images: [] };
try {
  existing = JSON.parse(await readFile(join(root, 'blog/snapshots/snapshot-manifest.json'), 'utf8'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const existingArticles = new Set(existing.articles.map((item) => item.path));
const existingImages = new Map(existing.images.map((item) => [item.source, item]));
const htmlByPath = new Map();
for (const post of posts) {
  if (!/^[a-z0-9-]+$/.test(post.slug)) throw new Error(`Slug không hợp lệ: ${post.slug}`);
  const path = `/bai-viet/${post.slug}`;
  const snapshotPath = `blog/snapshots/${post.slug}.html`;
  if (existingArticles.has(snapshotPath)) continue;
  const html = await fetchFresh(path);
  if (!/<!doctype html/i.test(html) || !html.includes(`rel="canonical" href="${origin}${path}"`)) {
    throw new Error(`HTML hoặc canonical không khớp: ${post.slug}`);
  }
  htmlByPath.set(snapshotPath, html);
  console.log(JSON.stringify({ event: 'article_read', slug: post.slug, bytes: Buffer.byteLength(html), sha256: hash(html) }));
}
if (!existingArticles.has('blog/snapshots/index-snapshot.html')) {
  const index = await fetchFresh('/bai-viet');
  if (!posts.every((post) => index.includes(`/bai-viet/${post.slug}`))) throw new Error('Index thiếu bài published.');
  htmlByPath.set('blog/snapshots/index-snapshot.html', index);
}
if (!existingArticles.has('blog/snapshots/sitemap-snapshot.xml')) {
  const sitemap = await fetchFresh('/sitemap.xml');
  if (!posts.every((post) => sitemap.includes(`${origin}/bai-viet/${post.slug}`))) throw new Error('Sitemap thiếu bài published.');
  htmlByPath.set('blog/snapshots/sitemap-snapshot.xml', sitemap);
}

const urls = new Set();
for (const html of htmlByPath.values()) {
  for (const match of html.matchAll(blobPattern)) urls.add(match[0].replace(/&amp;/g, '&'));
}
const replacement = new Map();
const images = [];
for (const url of [...urls].sort()) {
  if (existingImages.has(url)) {
    replacement.set(url, `${origin}${existingImages.get(url).local}`);
    continue;
  }
  const parsed = new URL(url);
  const pathname = posix.normalize(decodeURIComponent(parsed.pathname).replace(/^\//, ''));
  if (!pathname.startsWith('blog/assets/') || pathname.includes('..')) {
    throw new Error(`Ảnh ngoài phạm vi blog: ${pathname}`);
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(25_000) });
  if (!response.ok) throw new Error(`Không tải được ảnh ${response.status}: ${pathname}`);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.startsWith('image/')) throw new Error(`Content-Type ảnh không hợp lệ: ${pathname}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new Error(`Kích thước ảnh không hợp lệ: ${pathname}`);
  const local = `assets/blog-recovered/${pathname}`;
  await writeVerified(local, bytes);
  replacement.set(url, `${origin}/${local}`);
  images.push({ source: url, local: `/${local}`, sha256: hash(bytes), bytes: bytes.length });
}

const articles = [...existing.articles];
for (const [path, original] of htmlByPath) {
  const rewritten = original.replace(blobPattern, (value) => {
    const match = replacement.get(value.replace(/&amp;/g, '&'));
    if (!match) throw new Error(`Thiếu ảnh trong manifest: ${value}`);
    return match;
  });
  if (rewritten.match(blobPattern)) throw new Error(`Còn URL Blob trong HTML: ${path}`);
  await writeVerified(path, Buffer.from(rewritten));
  articles.push({ path, originalSha256: hash(original), deployedSha256: hash(rewritten), bytes: Buffer.byteLength(rewritten) });
}
const allImages = [...existing.images, ...images];
await writeFile(join(root, 'blog/snapshots/snapshot-manifest.json'), `${JSON.stringify({ exportedAt: new Date().toISOString(), articles, images: allImages }, null, 2)}\n`);
console.log(JSON.stringify({ event: 'snapshot_complete', posts: posts.length, pages: articles.length, images: allImages.length, imageBytes: allImages.reduce((sum, image) => sum + image.bytes, 0) }));
