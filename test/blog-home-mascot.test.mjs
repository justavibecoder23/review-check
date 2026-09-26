import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const script = fs.readFileSync(path.join(root, 'public/blog.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public/blog.css'), 'utf8');
const assetRoot = path.join(root, 'public/assets/mascot');

test('mascot trang chủ Blog có đủ ba pose tóc vàng cầm giỏ', () => {
  for (const file of [
    'realviewee-blog-home-dazed-v1.png',
    'realviewee-blog-home-alert-v1.png',
    'realviewee-blog-home-point-v1.png',
  ]) {
    const buffer = fs.readFileSync(path.join(assetRoot, file));
    assert.equal(buffer.subarray(1, 4).toString(), 'PNG');
    assert.ok(buffer.length > 100_000);
    assert.match(script, new RegExp(file.replaceAll('.', '\\.')));
  }
});

test('mascot rơi một lần, choáng, tỉnh lại rồi chỉ vào bài nổi bật', () => {
  assert.match(script, /heading\.dataset\.mascotReady === 'true'/);
  assert.match(script, /mascot\.dataset\.pose = 'dazed'/);
  assert.match(script, /event\.animationName !== 'blog-home-mascot-drop'/);
  assert.match(script, /classList\.add\('is-landed'\)[\s\S]*?classList\.remove\('is-dropping'\)/);
  assert.match(script, /setPose\('alert'\)/);
  assert.match(script, /setPose\('point'\)/);
  assert.match(script, /setPose\('alert'\);\s*\}, 2700\);/);
  assert.match(script, /setPose\('point'\);[\s\S]*?bubble\.classList\.add\('is-visible'\);\s*\}, 5400\);/);
  assert.match(script, /Cùng mình đọc blog nào!/);
  assert.doesNotMatch(script, /(?:local|session)Storage/);
  assert.match(styles, /@keyframes blog-home-mascot-drop/);
  assert.match(styles, /\.blog-home-mascot\.is-dropping \{[^}]*blog-home-mascot-drop 2s/);
  assert.match(styles, /@keyframes blog-home-mascot-dazed/);
  assert.match(styles, /\.blog-home-mascot\.is-landed \{[^}]*transform:\s*translateY\(0\);/);
});

test('mascot Blog không tương tác và có bố cục responsive', () => {
  assert.match(styles, /\.blog-home-mascot \{[^}]*pointer-events:\s*none;/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.blog-home-mascot \{ position:\s*relative;/);
  assert.match(styles, /@media \(max-width: 430px\)[\s\S]*?\.blog-home-mascot \{ width:\s*84px; height:\s*84px;/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.blog-home-mascot[^}]*transform:\s*translateY\(0\);/);
});
