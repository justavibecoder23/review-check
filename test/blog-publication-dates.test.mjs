import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { BLOG_PUBLICATION_DATES, BLOG_PUBLICATION_ORDER } from '../src/blog-publication-dates.mjs';
import { publicBlogSummary } from '../src/blog-public-data.mjs';

test('19 existing articles publish daily from TrustScore on 11 September', () => {
  assert.equal(BLOG_PUBLICATION_ORDER.length, 19);
  assert.equal(BLOG_PUBLICATION_ORDER[0], 'trustscore-la-gi');
  const dates = BLOG_PUBLICATION_ORDER.map(slug => BLOG_PUBLICATION_DATES[slug]);
  assert.equal(dates[0].slice(0,10), '2026-09-11');
  assert.equal(dates.at(-1).slice(0,10), '2026-09-29');
  dates.forEach((date, index) => {
    if (index) assert.equal(Date.parse(date) - Date.parse(dates[index - 1]), 86400000);
  });
});

test('public articles, index cards and JSON-LD agree on publication dates', async () => {
  const root = new URL('../public/', import.meta.url);
  const index = await readFile(new URL('blog/snapshots/index-snapshot.html', root), 'utf8');
  const cards = [...index.matchAll(/<article class="(?:post-card|featured-post)">[\s\S]*?<\/article>/g)];
  assert.equal(cards.length, 19);
  for (const [slug, date] of Object.entries(BLOG_PUBLICATION_DATES)) {
    const html = await readFile(new URL(`blog/snapshots/${slug}.html`, root), 'utf8');
    assert.equal(html.match(/"datePublished"\s*:\s*"([^"]+)"/)?.[1], date);
    const time = `<time datetime="${date.slice(0,10)}">${Number(date.slice(8,10))} tháng 9, 2026</time>`;
    assert.ok(html.includes(time), slug);
    const card = cards.find(([text]) => text.includes(`href="/bai-viet/${slug}"`))?.[0];
    assert.ok(card?.includes(time), slug);
    assert.equal(publicBlogSummary({ slug, publishedAt: '2026-01-01' }).publishedAt, date);
  }
});

test('snapshot provenance proves only documented date fields changed', async () => {
  const root = new URL('../public/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('blog/snapshots/snapshot-manifest.json', root), 'utf8'));
  const hash = text => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
  for (const item of manifest.articles.filter(a => a.publicationDateReplacements)) {
    let text = await readFile(new URL(item.path, root), 'utf8');
    assert.equal(hash(text), item.deployedSha256, item.path);
    for (const edit of [...item.publicationDateReplacements].reverse()) text = text.replaceAll(edit.to, edit.from);
    for (const image of manifest.images) text = text.replaceAll(`https://www.realview.com.vn${image.local}`, image.source);
    assert.equal(hash(text), item.originalSha256, item.path);
  }
});
