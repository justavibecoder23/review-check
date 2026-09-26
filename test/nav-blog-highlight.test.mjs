import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [nav, styles] = await Promise.all([
  readFile(new URL('../public/nav.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/styles.css', import.meta.url), 'utf8'),
]);

test('item Blog có viền cam-gold tĩnh và badge New metallic nhưng vẫn là liên kết', () => {
  assert.match(nav, /<div class="nav-blog-wrapper\$\{isBlog \? ' is-active' : ''\}">/);
  assert.match(nav, /<a class="nav-link nav-blog\$\{isBlog \? ' is-active' : ''\}" href="\/bai-viet"/);
  assert.match(nav, /<div class="nav-blog-content">Blog<\/div>/);
  assert.match(nav, /<span class="nav-blog-badge">New<\/span>/);
  assert.match(styles, /\.nav-blog-wrapper \{[^}]*padding:\s*1\.5px;[^}]*border-radius:\s*16px;/);
  assert.match(styles, /\.nav-blog-wrapper::before \{[^}]*linear-gradient\(120deg, #ff7652 0%, #ee4d2d 42%, #fde0a3 100%\);/);
  assert.doesNotMatch(styles, /nav-blog-border-shimmer/);
  assert.match(styles, /\.nav-blog-wrapper::after \{[^}]*inset:\s*1\.5px;[^}]*border-radius:\s*14\.5px;[^}]*background:\s*#f3f4f6;/);
  assert.match(styles, /\.nav-blog-badge \{[^}]*top:\s*-10px;[^}]*right:\s*-12px;[^}]*linear-gradient\(135deg, #fffaf4 0%, #efd8bd 50%, #fffaf4 100%\);/);
  assert.match(styles, /\.nav-blog-badge::after \{[^}]*animation:\s*nav-blog-badge-glare 4s ease-in-out infinite;/);
});

test('item Blog bỏ viền khi active, giữ active state, responsive và reduced motion', () => {
  assert.match(styles, /\.nav-blog-wrapper\.is-active \{ padding:\s*0; \}/);
  assert.match(styles, /\.nav-blog-wrapper\.is-active::before, \.nav-blog-wrapper\.is-active::after \{ display:\s*none; \}/);
  assert.match(styles, /\.main-nav \.nav-blog\.is-active,[\s\S]*?\.main-nav \.nav-blog\[aria-current="page"\]:hover \{[^}]*background:\s*var\(--orange\);[^}]*box-shadow:/);
  assert.match(styles, /@media \(max-width: 1024px\) \{[\s\S]*?\.nav-blog-wrapper \{ width:\s*100%; min-height:\s*44px; \}[\s\S]*?\.nav-blog-badge \{ top:\s*-6px; right:\s*10px; \}/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{\s*\.nav-blog-badge::after \{ animation:\s*none !important; \}\s*\}/);
});
