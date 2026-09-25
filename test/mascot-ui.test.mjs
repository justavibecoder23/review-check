import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [chatbot, styles, home, results, resultsScript, resultsStyles, sprite, progressMascot, progressStepB, homeStepB] = await Promise.all([
  readFile(new URL('../public/chatbot.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/chatbot.css', import.meta.url), 'utf8'),
  readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../public/results.html', import.meta.url), 'utf8'),
  readFile(new URL('../public/results.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/results-v2.css', import.meta.url), 'utf8'),
  readFile(new URL('../public/assets/mascot/realviewee-sprite-v2.png', import.meta.url)),
  readFile(new URL('../public/assets/mascot/realviewee-running-curious-v1.png', import.meta.url)),
  readFile(new URL('../public/assets/mascot/realviewee-running-curious-step-b-v1.png', import.meta.url)),
  readFile(new URL('../public/assets/mascot/realviewee-running-default-step-b-v2.png', import.meta.url)),
]);

test('sprite RealViewee giữ nền trong suốt và đúng lưới tám trạng thái', () => {
  assert.deepEqual([...sprite.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(sprite.readUInt32BE(16), 1672);
  assert.equal(sprite.readUInt32BE(20), 941);
  assert.equal(sprite[25], 6, 'PNG phải dùng RGBA để giữ nền trong suốt');
  assert.match(styles, /background-image:\s*url\('\/assets\/mascot\/realviewee-sprite-v2\.png'\)/);
  assert.match(styles, /background-size:\s*400% 200%/);
});

test('mascot Curious trên thanh tiến trình là ảnh ngang độc lập, trong suốt và bám tiến độ thật', () => {
  for (const image of [progressMascot, progressStepB, homeStepB]) {
    assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(image.readUInt32BE(16), 600);
    assert.equal(image[25], 6, 'Các khung chạy phải dùng RGBA để giữ nền trong suốt');
  }
  assert.equal(progressMascot.readUInt32BE(20), 530);
  assert.equal(progressStepB.readUInt32BE(20), 529);
  assert.equal(homeStepB.readUInt32BE(20), 529);
  assert.match(results, /class="analysis-progress-mascot"[\s\S]*?realviewee-running-curious-v1\.png/);
  assert.match(results, /data-mascot-state="curious"[\s\S]*?realviewee-running-curious-step-b-v1\.png/);
  assert.match(resultsScript, /progressTrack\.style\.setProperty\('--analysis-progress', `\$\{value\}%`\)/);
  assert.match(resultsScript, /progressMascot\.classList\.add\('is-moving'\)/);
  assert.match(resultsScript, /event\.propertyName === 'left'\)[\s\S]*?stopProgressMascot\(\)/);
  assert.match(resultsStyles, /\.analysis-progress-mascot \{[\s\S]*?pointer-events:\s*none;/);
  assert.match(resultsStyles, /left:\s*clamp\(0px, calc\(var\(--analysis-progress\) - 38px\), calc\(100% - 76px\)\)/);
  assert.match(resultsStyles, /\.analysis-progress-mascot\.is-moving \.analysis-progress-mascot-front \{ opacity: 0; \}/);
  assert.match(results, /class="analysis-progress-thinking-text">Đợi mình chút xíu nhé<\/span><span class="analysis-progress-thinking-dots"><i>\.<\/i><i>\.<\/i><i>\.<\/i>/);
  assert.match(results, /<small>Thời gian đã xử lý<\/small>/);
  assert.match(resultsStyles, /\.analysis-elapsed \{[\s\S]*?min-width:\s*138px/);
  assert.match(resultsStyles, /\.analysis-progress-track \{[\s\S]*?margin:\s*126px 0 28px/);
  assert.match(resultsStyles, /\.analysis-progress-mascot\.is-moving \.analysis-progress-mascot-bubble \{ opacity:\s*0/);
  assert.match(resultsStyles, /\.analysis-progress-mascot-bubble \{[\s\S]*?bottom:\s*calc\(100% \+ 3px\);[\s\S]*?border:\s*1px solid rgba\(252,120,31,\.3\);[\s\S]*?color:\s*var\(--orange-dark\);/);
  assert.match(resultsStyles, /\.analysis-progress-thinking-text \{[\s\S]*?background:\s*linear-gradient\(/);
  assert.match(resultsStyles, /\.analysis-progress-mascot:not\(\.is-moving\) \.analysis-progress-thinking-text \{[\s\S]*?animation:\s*analysis-thinking-shimmer 1\.8s ease-in-out infinite;/);
  assert.match(resultsStyles, /@keyframes analysis-thinking-shimmer[\s\S]*?background-position:\s*-125% 50%/);
  assert.match(resultsStyles, /\.analysis-progress-mascot\.is-moving \.analysis-progress-mascot-step-b \{ transform:\s*scale\(\.92\)/);
  assert.match(resultsStyles, /@keyframes analysis-mascot-leg-cycle-a[\s\S]*?0%, 32\.99%, 66%, 100% \{ opacity: 1; \}[\s\S]*?33%, 65\.99% \{ opacity: 0; \}/);
  assert.match(resultsStyles, /@keyframes analysis-mascot-leg-cycle[\s\S]*?0%, 32\.99%, 66%, 100% \{ opacity: 0; \}[\s\S]*?33%, 65\.99% \{ opacity: 1; \}/);
  assert.doesNotMatch(results, /id="analysis-guest-quota"/);
});

test('mascot homepage mở chatbot và mascot Confident đóng mở giải thích TrustScore', () => {
  assert.match(home, /<script src="\/chatbot\.js" defer><\/script>/);
  assert.match(results, /<script src="\/chatbot\.js" defer><\/script>/);
  assert.match(chatbot, /createHomepageMascot/);
  assert.match(chatbot, /createResultMascots/);
  assert.match(chatbot, /Mình giúp bạn check review nhé\?/);
  assert.match(chatbot, /setOpen\(true, false\)/);
  assert.match(chatbot, /staticMascot\.addEventListener\('click', toggleDetails\)/);
  assert.match(chatbot, /details\.open = !details\.open/);
  assert.match(chatbot, /staticMascot\.setAttribute\('aria-expanded', String\(details\.open\)\)/);
  assert.match(chatbot, /details\.id \|\|= 'trust-explanation-card'/);
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
  assert.match(chatbot, /trustCopy, 'confident', 'trust'/);
  assert.match(styles, /\.trust-copy \{ position: relative; \}/);
  assert.doesNotMatch(styles, /\.trust-copy \{[^}]*padding-right:/);
  assert.match(styles, /\.realviewee-static--trust \{ --static-mascot-width: 88px; position: absolute; top: 18px; right: 0; \}/);
  assert.match(chatbot, /keptSummary, 'surprised', 'kept'/);
  assert.match(chatbot, /excludedSummary, 'concerned', 'excluded'/);
  assert.match(chatbot, /counterpartHeading, 'excited', 'counterpart'/);
  assert.match(chatbot, /const staticMascot = document\.createElement\('div'\)/);
  assert.match(chatbot, /staticMascot\.setAttribute\('role', 'img'\)/);
  assert.match(chatbot, /connectMascotToDetails\(trustMascot, trustExplanation\)/);
  assert.match(styles, /\.realviewee-static \{[\s\S]*?cursor:\s*default;/);
  assert.match(styles, /\.realviewee-static--trust \{ cursor:\s*pointer; \}/);
  for (const speech of ['Xem chi tiết điểm nha!', 'Góc review chân thực!', 'Review này hơi ảo!', 'Bắt đúng sản phẩm!']) {
    assert.match(chatbot, new RegExp(speech.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(styles, /\.trust-copy > h2,[\s\S]*?\.trust-copy > p \{ max-width:\s*calc\(100% - 98px\); \}/);
  assert.match(styles, /\.realviewee-static--kept \.realviewee-static-speech,[\s\S]*?right:\s*calc\(100% \+ 5px\)/);
  assert.match(styles, /\.realviewee-static--counterpart \.realviewee-static-speech \{[\s\S]*?right:\s*calc\(100% - 22px\);[\s\S]*?bottom:\s*calc\(100% - 8px\)/);
  assert.match(styles, /\.realviewee-static--trust \.realviewee-static-speech \{[\s\S]*?bottom:\s*calc\(100% \+ 4px\)/);
  assert.match(styles, /\.realviewee-speech \{[\s\S]*?bottom:\s*calc\(100% \+ 10px\);[\s\S]*?border-radius:\s*12px;[\s\S]*?color:\s*var\(--orange-dark\);/);
});

test('chỉ mascot homepage chuyển động; mascot result đứng yên và responsive', () => {
  assert.match(styles, /@keyframes realviewee-patrol/);
  assert.match(styles, /realviewee-running-default-step-b-v2\.png/);
  assert.match(styles, /@keyframes realviewee-leg-cycle-a[\s\S]*?0%, 32\.99%, 66%, 100% \{ opacity: 1; \}[\s\S]*?33%, 65\.99% \{ opacity: 0; \}/);
  assert.match(styles, /@keyframes realviewee-leg-cycle[\s\S]*?0%, 32\.99%, 66%, 100% \{ opacity: 0; \}[\s\S]*?33%, 65\.99% \{ opacity: 1; \}/);
  assert.match(styles, /\.realviewee-companion\.is-interacting,[\s\S]*animation-play-state:\s*paused/);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*--mascot-width:\s*104px/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.realviewee-companion\.is-patrolling[\s\S]*animation:\s*none/);
  assert.match(chatbot, /character\.addEventListener\('pointerenter'/);
  assert.match(chatbot, /character\.addEventListener\('focus'/);
  assert.match(chatbot, /homeHost\.classList\.add\('has-realviewee-stage'\)/);
  assert.match(styles, /\.realviewee-stage--home \{[\s\S]*?height:\s*169px;[\s\S]*?margin:\s*30px auto 0;[\s\S]*?background:\s*transparent;/);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*?\.realviewee-stage--home \{ height:\s*136px; margin-top:\s*16px; \}/);
  assert.match(styles, /\.realviewee-stage \{[\s\S]*?overflow:\s*visible;/);
  assert.doesNotMatch(styles, /\.realviewee-static\s*\{[^}]*animation:/);
  assert.match(styles, /\.realviewee-character::before,[\s\S]*?radial-gradient\(ellipse at center,[\s\S]*?border-radius:\s*50%/);
  assert.match(styles, /\.realviewee-static:hover::before,[\s\S]*?opacity:\s*1; transform:\s*scale\(1\)/);
  assert.doesNotMatch(styles, /\.realviewee-static:hover\s*\{[^}]*filter:/);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*?\.realviewee-static--counterpart \{ --static-mascot-width:\s*82px; \}/);
  assert.match(chatbot, /const mascotPatrolDuration = 24_000/);
  assert.match(chatbot, /\[5_000, 'default'\][\s\S]*?\[9_000, 'running'\][\s\S]*?\[14_000, 'default'\][\s\S]*?\[18_000, 'running'\][\s\S]*?\[23_000, 'default'\]/);
  assert.match(styles, /20\.833%, 37\.5% \{ left: 31%; opacity: 1; \}[\s\S]*?58\.333%, 75% \{ left: 61%; opacity: 1; \}/);
  assert.match(styles, /realviewee-running-default-step-b-v2\.png'\) center bottom \/ 126% 99% no-repeat/);
  assert.doesNotMatch(styles, /realviewee-sprite\[data-mascot-state="running"\]::after\s*\{[^}]*filter:/s);
  assert.match(styles, /animation:\s*realviewee-leg-cycle-a 5s/);
  assert.doesNotMatch(styles, /is-chat-open[^}]*left:/);
  assert.match(styles, /\.realviewee-stage--home\.is-chat-open \{ z-index: 95; pointer-events: none; \}/);
  assert.match(styles, /\.realviewee-stage--home\.is-chat-open \.realviewee-character \{ pointer-events: auto; \}/);
  assert.match(chatbot, /mascot\.stage\.classList\.add\('is-chat-open'\)/);
  assert.match(chatbot, /mascot\.stage\.classList\.remove\('is-chat-open'\)/);
  assert.match(chatbot, /character\.addEventListener\('pointerenter',[\s\S]*?aria-expanded[\s\S]*?'happy'/);
  assert.match(chatbot, /character\.addEventListener\('focus',[\s\S]*?aria-expanded[\s\S]*?'happy'/);
});

test('bong bóng homepage đổi nội dung mượt theo trạng thái chạy và dừng', () => {
  assert.match(chatbot, /class="realviewee-state-speech is-running is-visible"[\s\S]*?>Chốt đơn, chốt đơn!</);
  assert.match(chatbot, /state === 'running' \? 'running' : state === 'default' \? 'stopped'/);
  assert.match(chatbot, /'Chốt đơn, chốt đơn!'/);
  assert.match(chatbot, /'Khoan! Check trên RealView đã!'/);
  assert.match(chatbot, /bubble\.classList\.remove\('is-visible'\)[\s\S]*?window\.setTimeout\(applySpeech, 200\)/);
  assert.match(styles, /\.realviewee-state-speech \{[\s\S]*?transform:\s*translate\(-50%, 5px\) scale\(0\);[\s\S]*?transition:\s*opacity \.2s ease, transform \.2s ease;/);
  assert.match(styles, /\.realviewee-state-speech\.is-visible \{[\s\S]*?scale\(1\);[\s\S]*?cubic-bezier\(\.34,1\.56,\.64,1\)/);
  assert.match(styles, /\.realviewee-state-speech\.is-stopped \{[\s\S]*?color:\s*#EE4D2D;[\s\S]*?font-weight:\s*700;/);
  assert.match(styles, /\.realviewee-state-speech\.is-running \{[\s\S]*?--state-speech-tail:\s*53%;[\s\S]*?left:\s*70%;/);
  assert.match(styles, /\.realviewee-state-speech::after \{[\s\S]*?border-right:\s*1px solid var\(--state-speech-border\);[\s\S]*?border-radius:\s*0 0 2px 0;/);
  assert.match(styles, /\.realviewee-state-speech\.is-running\.is-visible \{ animation:\s*realviewee-state-speech-run \.65s/);
  assert.match(styles, /\.realviewee-companion \{[\s\S]*?bottom:\s*-12px;/);
  assert.match(styles, /\.realviewee-companion\.is-chat-open \.realviewee-state-speech \{ opacity:\s*0;/);
});
