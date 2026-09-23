import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [chatbot, styles, home, results, sprite] = await Promise.all([
  readFile(new URL('../public/chatbot.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/chatbot.css', import.meta.url), 'utf8'),
  readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../public/results.html', import.meta.url), 'utf8'),
  readFile(new URL('../public/assets/mascot/realviewee-sprite-v2.png', import.meta.url)),
]);

test('sprite RealViewee giữ nền trong suốt và đúng lưới tám trạng thái', () => {
  assert.deepEqual([...sprite.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(sprite.readUInt32BE(16), 1672);
  assert.equal(sprite.readUInt32BE(20), 941);
  assert.equal(sprite[25], 6, 'PNG phải dùng RGBA để giữ nền trong suốt');
  assert.match(styles, /background-image:\s*url\('\/assets\/mascot\/realviewee-sprite-v2\.png'\)/);
  assert.match(styles, /background-size:\s*400% 200%/);
});

test('mascot homepage và các mascot ngữ cảnh result cùng mở chatbot hiện có', () => {
  assert.match(home, /<script src="\/chatbot\.js" defer><\/script>/);
  assert.match(results, /<script src="\/chatbot\.js" defer><\/script>/);
  assert.match(chatbot, /createHomepageMascot/);
  assert.match(chatbot, /createResultMascots/);
  assert.match(chatbot, /Mình giúp bạn check review nhé\?/);
  assert.match(chatbot, /setOpen\(true, false\)/);
  assert.match(chatbot, /Chat with RealViewee/);
  assert.match(chatbot, /Your AI shopping &amp; review assistant/);
});

test('chỉ triển khai các biểu cảm đã duyệt và khung chạy, không có Suspicious hoặc Thinking', () => {
  for (const state of ['default', 'happy', 'curious', 'surprised', 'confident', 'excited', 'concerned', 'running']) {
    assert.match(chatbot, new RegExp(`['"]${state}['"]`));
    assert.match(styles, new RegExp(`data-mascot-state="${state}"`));
  }
  assert.doesNotMatch(chatbot, /suspicious/i);
  assert.doesNotMatch(styles, /suspicious/i);
  assert.doesNotMatch(chatbot, /thinking/i);
  assert.doesNotMatch(styles, /thinking/i);
  assert.match(styles, /data-mascot-state="default"[^}]*sprite-v1\.png/);
  assert.match(chatbot, /progressHead, 'curious', 'loading'/);
  assert.match(chatbot, /trustPanel, 'confident', 'trust'/);
  assert.match(chatbot, /keptSummary, 'surprised', 'kept'/);
  assert.match(chatbot, /excludedSummary, 'concerned', 'excluded'/);
  assert.match(chatbot, /counterpartHeading, 'excited', 'counterpart'/);
});

test('chỉ mascot homepage chuyển động; mascot result đứng yên và responsive', () => {
  assert.match(styles, /@keyframes realviewee-patrol/);
  assert.match(styles, /\.realviewee-companion\.is-interacting,[\s\S]*animation-play-state:\s*paused/);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*--mascot-width:\s*104px/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.realviewee-companion\.is-patrolling[\s\S]*animation:\s*none/);
  assert.match(chatbot, /character\.addEventListener\('pointerenter'/);
  assert.match(chatbot, /character\.addEventListener\('focus'/);
  assert.match(chatbot, /homeHost\.classList\.add\('has-realviewee-stage'\)/);
  assert.match(styles, /\.realviewee-stage--home \{[\s\S]*?height:\s*169px;[\s\S]*?margin:\s*30px auto 0;[\s\S]*?background:\s*transparent;/);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*?\.realviewee-stage--home \{ height:\s*136px; margin-top:\s*16px; \}/);
  assert.match(styles, /\.realviewee-stage \{[\s\S]*?overflow:\s*visible;/);
  assert.doesNotMatch(styles, /realviewee-static[^}]*animation:/);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*?\.realviewee-static--counterpart \{ --static-mascot-width:\s*82px; \}/);
});
