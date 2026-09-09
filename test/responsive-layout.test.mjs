import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const nav = readFileSync(new URL('../public/nav.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('tablet portrait uses the collapsed navigation layout', () => {
  assert.match(styles, /@media \(max-width: 1024px\) \{[\s\S]*?\.main-nav \{ position: absolute;/);
  assert.match(styles, /\.header-inner > \.main-nav \{ justify-self: stretch; \}/);
  assert.match(styles, /\.main-nav \{ position: absolute;[^}]*width: auto;[^}]*min-width: 0;/);
  assert.match(nav, /matchMedia\('\(max-width: 1024px\)'\)/);
  assert.match(app, /window\.innerWidth > 1024/);
});

test('phone refinements win over the later readability overrides', () => {
  const refinement = styles.lastIndexOf('@media (max-width: 700px)');
  const readability = styles.indexOf('main .hero-description { font-size: 16px; }');

  assert.ok(refinement > readability);
  assert.match(styles.slice(refinement), /main \.hero-description \{ font-size: 15px;/);
  assert.match(styles.slice(refinement), /main \.supported \{ font-size: clamp\(10px, 2\.8vw, 11px\);/);
});
