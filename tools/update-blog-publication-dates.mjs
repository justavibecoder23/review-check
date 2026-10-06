// Mechanical date-only rewrite. Record reversible edits to preserve snapshot provenance.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { BLOG_PUBLICATION_DATES } from '../src/blog-publication-dates.mjs';
const root = new URL('../public/', import.meta.url);
const manifestUrl = new URL('blog/snapshots/snapshot-manifest.json', root);
const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
const label = value => `${Number(value.slice(8, 10))} tháng ${Number(value.slice(5, 7))}, ${value.slice(0, 4)}`;
const hash = text => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
const paths = ['blog.html', 'blog/snapshots/index-snapshot.html',
  ...(await readdir(new URL('blog/', root))).filter(f => f.endsWith('.html')).map(f => `blog/${f}`),
  ...Object.keys(BLOG_PUBLICATION_DATES).map(slug => `blog/snapshots/${slug}.html`)
];
for (const path of paths) {
  const target = new URL(path, root);
  const before = await readFile(target, 'utf8');
  let html = before;
  const replacements = [];
  const record = (from, to) => { if (from !== to) replacements.push({ from, to }); return to; };
  if (path === 'blog.html' || path.endsWith('index-snapshot.html')) {
    html = html.replace(/<article class="(?:post-card|featured-post)">[\s\S]*?<\/article>/g, card => {
      const slug = card.match(/href="\/bai-viet\/([^"]+)"/)?.[1];
      const date = BLOG_PUBLICATION_DATES[slug];
      assert.ok(date, `Unscheduled card: ${slug}`);
      return card.replace(/<time datetime="[^"]+">[^<]*<\/time>/, time => record(time, `<time datetime="${date.slice(0, 10)}">${label(date)}</time>`));
    });
  } else {
    const slug = path.split('/').at(-1).replace(/\.html$/, '');
    const date = BLOG_PUBLICATION_DATES[slug];
    assert.ok(date, `Unscheduled article: ${slug}`);
    html = html.replace(/("datePublished"\s*:\s*")[^"]+("|$)/g, (all, start, end) => record(all, start + date + end));
    html = html.replace(/(<meta property="article:published_time" content=")[^"]+("\s*\/?>)/g, (all, start, end) => record(all, start + date + end));
    html = html.replace(/<time datetime="[^"]+">(?!Cập nhật)[^<]*<\/time>/, all => record(all, `<time datetime="${date.slice(0, 10)}">${label(date)}</time>`));
    // An updated timestamp cannot precede publication. Leave later updates intact.
    html = html.replace(/("dateModified"\s*:\s*")([^"]+)(")/g, (all, start, old, end) => Date.parse(old) < Date.parse(date) ? record(all, start + date + end) : all);
    html = html.replace(/<time datetime="([^"]+)">Cập nhật[^<]*<\/time>/g, (all, old) => old.slice(0,10) < date.slice(0,10) ? record(all, `<time datetime="${date.slice(0,10)}">Cập nhật ${label(date)}</time>`) : all);
  }
  if (html === before) continue;
  await writeFile(target, html, 'utf8');
  const entry = manifest.articles.find(item => item.path === path);
  if (entry) {
    assert.ok(!entry.publicationDateReplacements, 'Date migration has already run');
    entry.publicationDateReplacements = replacements;
    entry.deployedSha256 = hash(html);
    entry.bytes = Buffer.byteLength(html);
  }
  console.log(path);
}
await writeFile(manifestUrl, JSON.stringify(manifest, null, 2) + '\n');
