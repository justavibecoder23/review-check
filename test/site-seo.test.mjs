import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const indexablePages = new Map([
  ['index.html', 'https://www.realview.com.vn/'],
  ['criteria.html', 'https://www.realview.com.vn/criteria.html'],
  ['contact.html', 'https://www.realview.com.vn/contact.html'],
  ['blog.html', 'https://www.realview.com.vn/blog.html'],
  ['blog/cach-doc-review-thong-minh.html', 'https://www.realview.com.vn/blog/cach-doc-review-thong-minh.html']
]);

test('every indexable public page uses one canonical www URL', async () => {
  for (const [page, canonical] of indexablePages) {
    const html = await readFile(new URL(`../public/${page}`, import.meta.url), 'utf8');
    assert.equal((html.match(/rel="canonical"/g) || []).length, 1, `${page} must have one canonical`);
    assert.match(html, new RegExp(`<link rel="canonical" href="${canonical.replaceAll('.', '\\.')}"`));
    assert.match(html, /<meta name="robots" content="index,follow,max-image-preview:large"/);
    assert.match(html, /<meta property="og:url" content="https:\/\/www\.realview\.com\.vn\//);
    assert.match(html, /<meta property="og:image" content="https:\/\/www\.realview\.com\.vn\//);
    assert.match(html, /<meta property="og:image:alt" content="[^"]+"/);
    assert.match(html, /<meta name="twitter:card" content="summary_large_image"/);
    assert.match(html, /<meta name="twitter:image" content="https:\/\/www\.realview\.com\.vn\//);
    assert.match(html, /<meta name="twitter:image:alt" content="[^"]+"/);
  }
});

test('dynamic result pages are crawlable for discovery but excluded from the index', async () => {
  const html = await readFile(new URL('../public/results.html', import.meta.url), 'utf8');
  assert.match(html, /<meta name="robots" content="noindex,follow"/);
  assert.doesNotMatch(html, /rel="canonical"/);
});
