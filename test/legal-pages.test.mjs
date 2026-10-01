import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { LEGAL_PAGES, LEGAL_CONTACT, LEGAL_UPDATED } from '../src/legal-content.mjs';
import { renderLegalPage } from '../tools/build-legal-pages.mjs';
import { STATIC_SITEMAP_ENTRIES } from '../src/blog-public-config.mjs';

const publicFile = (name) => new URL(`../public/${name}`, import.meta.url);
const home = await readFile(publicFile('index.html'), 'utf8');
const footer = home.match(/<footer class="site-footer">[\s\S]*?<\/footer>/)[0];
const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
const sitemap = await readFile(publicFile('blog/snapshots/sitemap-snapshot.xml'), 'utf8');
const robots = await readFile(publicFile('robots.txt'), 'utf8');
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

test('landing adds exactly two ordinary links in a separate footer row', () => {
  const legal = footer.match(/<nav class="container footer-legal"[\s\S]*?<\/nav>/)[0];
  assert.equal([...legal.matchAll(/<a /g)].length, 2);
  for (const page of LEGAL_PAGES) assert.ok(legal.includes(`href="${page.path}"`));
  assert.ok(!home.slice(0, home.indexOf('<footer')).includes('/legal.css'));
  assert.ok(!home.includes('/legal.js'));
  assert.ok(footer.includes('footer-grid'));
  assert.ok(!footer.includes('Illustration: Open Doodles'));
});

for (const page of LEGAL_PAGES) {
  test(`${page.path}: report hierarchy preserves every source paragraph and clause`, async () => {
    const html = await readFile(publicFile(page.file), 'utf8');
    assert.ok(!html.includes('legal-eyebrow'));
    assert.ok(html.includes(escapeHtml(page.lead)));
    for (const summary of page.summary) assert.ok(html.includes(escapeHtml(summary)));
    page.sections.forEach((section, index) => {
      assert.ok(html.includes(`<h2 id="title-${section.id}">${index + 1}. ${escapeHtml(section.title)}</h2>`));
      assert.ok(html.includes(`href="#${section.id}">${escapeHtml(section.title)}</a>`));
      for (const paragraph of [...(section.paragraphs || []), ...(section.paragraphsAfter || [])]) {
        assert.ok(html.includes(`<p>${escapeHtml(paragraph)}</p>`));
      }
      if (section.bullets?.every((item) => item.label)) {
        section.bullets.forEach((item, subIndex) => {
          assert.ok(html.includes(`<h3>${index + 1}.${subIndex + 1}. ${escapeHtml(item.label)}</h3>`));
          assert.ok(html.includes(`<p>${escapeHtml(item.text)}</p>`));
        });
      } else if (section.bullets) {
        assert.ok(html.includes('<ol class="legal-letter-list">'));
        for (const item of section.bullets) assert.ok(html.includes(escapeHtml(item.text)));
      }
      if (section.table) {
        for (const cell of [section.table.caption, ...section.table.columns, ...section.table.rows.flat()]) {
          assert.ok(html.includes(escapeHtml(cell)));
        }
      }
    });
  });
  test(`${page.path}: static content, metadata, links and reproducible build`, async () => {
    const html = await readFile(publicFile(page.file), 'utf8');
    assert.equal(html, renderLegalPage(page, footer));
    assert.equal([...html.matchAll(/<h1(?:\s|>)/g)].length, 1);
    assert.ok(html.includes('<html lang="vi">'));
    assert.ok(html.includes(`<link rel="canonical" href="https://www.realview.com.vn${page.path}"`));
    assert.ok(html.includes('<meta name="robots" content="index,follow"'));
    assert.ok(html.includes(`href="mailto:${LEGAL_CONTACT}"`));
    assert.ok(html.includes(`datetime="${LEGAL_UPDATED}"`));
    assert.ok(html.includes('https://www.threads.com/@real.viewueh'));
    assert.ok(!html.includes('data-auth-controls'));
    assert.ok(!html.includes('type="module"'));
    assert.ok(!html.includes('noindex'));
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(ids.length, new Set(ids).size, 'IDs must be unique');
    for (const section of page.sections) {
      assert.ok(html.includes(`href="#${section.id}"`));
      assert.ok(html.includes(`id="${section.id}"`));
      assert.ok(html.includes(section.title));
    }
    const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    const graph = JSON.parse(scripts[0][1])['@graph'];
    assert.equal(graph[0].url, `https://www.realview.com.vn${page.path}`);
    assert.equal(graph[1].itemListElement[1].item, graph[0].url);
    for (const asset of [...html.matchAll(/(?:src|href)="(\/(?:assets\/[^"?#]+|[^"/]+\.(?:css|js)))"/g)]) {
      await access(publicFile(asset[1].slice(1)));
    }
  });
  test(`${page.path}: public route and sitemap permit crawler discovery`, () => {
    assert.ok(config.rewrites.some((route) => route.source === page.path && route.destination === `/${page.file}`));
    assert.ok(config.redirects.some((route) => route.source === `/${page.file}` && route.destination === page.path && route.permanent));
    assert.ok(sitemap.includes(`<loc>https://www.realview.com.vn${page.path}</loc>`));
    assert.ok(STATIC_SITEMAP_ENTRIES.some((entry) => entry.path === page.path));
    assert.ok(!robots.includes(`Disallow: ${page.path}`));
    assert.ok(!config.headers.some((rule) => rule.source === page.path && rule.headers.some((h) => /noindex/i.test(h.value))));
  });
}

test('report stylesheet is page-scoped, single-column and includes print rules', async () => {
  const css = await readFile(publicFile('legal.css'), 'utf8');
  assert.ok(css.includes('.legal-page .legal-layout { display: block; }'));
  assert.ok(!css.includes('border-radius'));
  assert.ok(!css.includes('position: sticky'));
  assert.ok(css.includes('@media print'));
  assert.ok(css.includes('break-after: avoid'));
  assert.ok(css.includes('list-style-type: lower-alpha'));
  assert.ok(css.includes('prefers-reduced-motion'));
});
