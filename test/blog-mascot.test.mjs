import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const [script, styles] = await Promise.all([
  readFile(new URL('../public/blog-post.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/blog.css', import.meta.url), 'utf8'),
]);

const assets = [
  'realviewee-blog-title-relaxed-v1.png',
  'realviewee-blog-title-inspect-v1.png',
  'realviewee-blog-title-surprised-v2.png',
  'realviewee-blog-cta-thinking-v1.png',
  'realviewee-blog-cta-point-v1.png',
  'realviewee-blog-cta-happy-v1.png',
];

test('bài đọc Blog có đủ sáu pose mascot tóc xanh đen', () => {
  assets.forEach((asset) => {
    assert.equal(existsSync(fileURLToPath(new URL(`../public/assets/mascot/${asset}`, import.meta.url))), true);
    assert.match(script, new RegExp(asset.replaceAll('.', '\\.')));
  });
});

test('mỗi action mascot Blog kéo dài bốn giây rồi CTA giữ pose cuối', () => {
  assert.match(script, /const BLOG_MASCOT_ACTION_DURATION = 4_000/);
  assert.match(script, /setPose\(titleMascot, 'relaxed'\)/);
  assert.match(script, /setPose\(titleMascot, 'inspect'\)/);
  assert.match(script, /setTitleSpeech\('Gì đây ta\?\?'\)/);
  assert.match(script, /setPose\(titleMascot, 'surprised'\)/);
  assert.match(script, /setTitleSpeech\('Woww, bài này hay ghê!'\)/);
  assert.match(script, /BLOG_MASCOT_ACTION_DURATION \* 3/);
  assert.match(script, /setPose\(ctaMascot, 'thinking'\)/);
  assert.match(script, /setPose\(ctaMascot, 'point'\), BLOG_MASCOT_ACTION_DURATION \* 4 \+ 400/);
  assert.match(script, /setPose\(ctaMascot, 'happy'\)/);
  assert.match(script, /Chúc bạn đọc blog vui vẻ, nhớ dùng RealView nha!/);
});

test('bubble có khoảng hở riêng, không che tóc và mascot responsive', () => {
  assert.match(styles, /\.article-cta-mascot-frame \{[^}]*margin-top:\s*64px;/);
  assert.match(styles, /\.article-title-mascot-bubble \{[^}]*color:\s*var\(--orange-dark\);/);
  assert.match(styles, /\.article-cta-mascot-bubble \{[^}]*top:\s*6px;[^}]*max-width:\s*244px;/);
  assert.match(styles, /@media \(max-width: 430px\)[\s\S]*?\.article-cta-mascot-frame \{ width:\s*104px; height:\s*122px; margin-top:\s*76px; \}/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?transition:\s*none !important/);
});

test('bubble title giữ lại khung bo tròn và đuôi viền cam gần nhất', () => {
  assert.doesNotMatch(script, /attachRightSpeechFrame/);
  assert.match(styles, /\.article-title-mascot-bubble \{[^}]*border:\s*1px solid rgba\(252,120,31,\.34\);[^}]*background:\s*#fff;/);
  assert.match(styles, /\.article-title-mascot-bubble::before \{ right:\s*-7px;[^}]*border-width:\s*7px 0 7px 8px;/);
  assert.match(styles, /\.article-title-mascot-bubble::after \{ right:\s*-5px;[^}]*border-width:\s*6px 0 6px 8px;/);
  assert.match(styles, /\.article-cta-mascot-bubble::before \{ bottom:\s*-8px;[^}]*border-width:\s*9px 8px 0;/);
  assert.match(styles, /\.article-cta-mascot-bubble::after \{ bottom:\s*-6px;[^}]*border-width:\s*8px 7px 0;/);
});

test('title giữ hàng gốc còn mascot được nâng lên trên với khoảng hở ổn định', () => {
  assert.match(styles, /\.article-title-zone \{[^}]*padding-top:\s*0;/);
  assert.match(styles, /\.article-title-mascot \{[^}]*top:\s*-112px;/);
  assert.match(styles, /@media \(max-width: 1024px\)[\s\S]*?\.article-title-mascot \{ top:\s*-110px;/);
  assert.match(styles, /@media \(max-width: 430px\)[\s\S]*?\.article-title-mascot \{ top:\s*-104px;/);
});
