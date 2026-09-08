import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../public/results.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/results.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/results-v2.css', import.meta.url), 'utf8');

function resultsHarness() {
  const roots = {
    '#results-empty': { classList: { remove() {} } },
    '#pros-list': { innerHTML: '' }
  };
  const context = vm.createContext({
    URL,
    document: {
      querySelector(selector) { return roots[selector] || null; },
      querySelectorAll() { return []; },
      addEventListener() {}
    },
    sessionStorage: { getItem() { return null; } }
  });
  vm.runInContext(script, context);
  return { context, roots };
}

test('lý do TrustScore luôn được chia thành ba nhóm theo đúng thứ tự', () => {
  const { context } = resultsHarness();
  const markup = context.renderDriverGroups([
    { impact: 'neutral', title: 'Bối cảnh mẫu', detail: 'Không đổi điểm.' },
    { impact: 'down', title: 'Tín hiệu yếu', detail: 'Làm giảm độ tin cậy.' },
    { impact: 'up', title: 'Tín hiệu tốt', detail: 'Củng cố kết quả.' }
  ]);

  const up = markup.indexOf('data-driver-group="up"');
  const down = markup.indexOf('data-driver-group="down"');
  const neutral = markup.indexOf('data-driver-group="neutral"');
  assert.ok(up >= 0 && up < down && down < neutral);
  assert.match(markup, /Yếu tố củng cố độ tin cậy/);
  assert.match(markup, /Yếu tố làm giảm độ tin cậy/);
  assert.match(markup, /Yếu tố trung lập/);
  assert.ok(markup.indexOf('>01<') < markup.indexOf('>02<'));
  assert.ok(markup.indexOf('>02<') < markup.indexOf('>03<'));
});

test('nhóm rỗng vẫn hiển thị trạng thái rõ ràng và dữ liệu được escape', () => {
  const { context } = resultsHarness();
  const emptyMarkup = context.renderDriverGroups([]);
  assert.equal((emptyMarkup.match(/driver-group-empty/g) || []).length, 3);
  assert.equal((emptyMarkup.match(/driver-group-count/g) || []).length, 3);

  const safeMarkup = context.renderDriverGroups([
    { impact: 'up', title: '<img src=x onerror=alert(1)>', detail: '<script>bad()</script>' }
  ]);
  assert.doesNotMatch(safeMarkup, /<script>|<img src=/);
  assert.match(safeMarkup, /&lt;img/);
  assert.match(safeMarkup, /&lt;script&gt;/);
});

test('phần tóm tắt chỉ giữ lưu ý không cộng lượt đề cập thành tổng mẫu', () => {
  assert.doesNotMatch(html, /insight-(?:scanned|kept|excluded)-count/);
  assert.doesNotMatch(script, /#insight-(?:scanned|kept|excluded)-count/);
  assert.match(html, /Một review có thể nhắc nhiều chủ đề/);
  assert.match(html, /không cộng thành tổng mẫu/);
  assert.match(css, /\.insight-sample-note/);
});

test('mỗi chủ đề hiển thị trên cùng mẫu review đáng tham khảo và không vượt quá mẫu', () => {
  const { context, roots } = resultsHarness();
  context.renderSentimentList('#pros-list', [
    { title: 'Chất lượng', detail: 'Nhiều người cùng đề cập.', mentions: 30 }
  ], 25);

  assert.match(roots['#pros-list'].innerHTML, /25 trên 25 review đáng tham khảo/);
  assert.match(roots['#pros-list'].innerHTML, />25<\/b><small>\/25 review<\/small>/);
  assert.doesNotMatch(roots['#pros-list'].innerHTML, />30<\/b>/);
});

test('bố cục nhóm có chế độ một cột cho màn hình nhỏ', () => {
  assert.match(css, /\.driver-groups \{ display: grid; gap:/);
  assert.match(css, /\.driver-grid \{ display: grid; grid-template-columns: repeat\(2/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.driver-grid \{ grid-template-columns: 1fr; \}/);
});

test('tóm tắt ưu nhược điểm hiển thị trực tiếp và số liệu liên kết review nguồn', () => {
  const { context, roots } = resultsHarness();
  context.renderSentimentList('#pros-list', [
    { title: 'Chất liệu', detail: 'Nội dung giải thích ngắn gọn.', mentions: 3, evidenceIds: ['r1', 'r2', 'r3'] }
  ], 20);
  const driverMarkup = context.renderDriverGroups([
    { impact: 'up', title: 'Tín hiệu tốt', detail: 'Giải thích đầy đủ về tín hiệu.' }
  ]);

  assert.doesNotMatch(roots['#pros-list'].innerHTML, /sentiment-detail|Xem chi tiết/);
  assert.match(roots['#pros-list'].innerHTML, /<p>Nội dung giải thích ngắn gọn\.<\/p>/);
  assert.match(roots['#pros-list'].innerHTML, /<button class="sentiment-mentions"/);
  assert.match(roots['#pros-list'].innerHTML, /data-evidence-ids="r1\|r2\|r3"/);
  assert.match(driverMarkup, /<p class="driver-detail">Giải thích đầy đủ về tín hiệu\.<\/p>/);
  assert.doesNotMatch(driverMarkup, /<details|Xem chi tiết/);
  assert.match(html, /id="trust-summary-more"/);
});

test('popup giới thiệu chỉ có nút xác nhận và công thức mở trong bong bóng riêng', () => {
  assert.match(html, /<dialog id="trust-intro-dialog"/);
  assert.match(html, /Đây là điểm độ tin cậy của <strong>tập review<\/strong>/);
  assert.doesNotMatch(html, /id="trust-intro-method"/);
  assert.match(html, /id="trust-method-trigger"[^>]*popovertarget="trust-method-popover"/);
  assert.match(html, /id="trust-method-popover"[^>]*popover/);
  assert.match(html, /Xem cách tính điểm/);
  assert.match(html, /TrustScore<\/b> = 50 \+ Độ phủ mẫu × \(Q − 50\)/);
  assert.match(script, /showModal\(\)/);
  assert.match(css, /\.trust-intro-dialog::backdrop/);
  assert.match(css, /\.trust-method-popover:popover-open/);
});
