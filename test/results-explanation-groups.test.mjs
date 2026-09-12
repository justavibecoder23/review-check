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

test('không dựng nhóm rỗng nhưng vẫn hiển thị trạng thái thiếu dữ liệu và escape nội dung', () => {
  const { context } = resultsHarness();
  const emptyMarkup = context.renderDriverGroups([]);
  assert.equal((emptyMarkup.match(/driver-group-empty/g) || []).length, 1);
  assert.equal((emptyMarkup.match(/driver-group-count/g) || []).length, 0);

  const safeMarkup = context.renderDriverGroups([
    { impact: 'up', title: '<img src=x onerror=alert(1)>', detail: '<script>bad()</script>' }
  ]);
  assert.equal((safeMarkup.match(/data-driver-group=/g) || []).length, 1);
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
  assert.doesNotMatch(html, /id="trust-summary-more"|Đọc giải thích chi tiết/);
});

test('popup giới thiệu chỉ có nút xác nhận và công thức mở trong bong bóng riêng', () => {
  assert.match(html, /<dialog id="trust-intro-dialog"/);
  assert.match(html, /Đây là điểm độ tin cậy của <strong>tập review<\/strong>/);
  assert.doesNotMatch(html, /id="trust-intro-method"/);
  assert.match(html, /id="trust-method-trigger"[^>]*popovertarget="trust-method-popover"/);
  assert.match(html, /id="trust-method-popover"[^>]*popover/);
  assert.match(html, /Xem cách tính điểm/);
  assert.doesNotMatch(html, /<b>Q<\/b>|Nếu Q|\(Q − 50\)/);
  assert.match(html, /Kết quả sau khi làm tròn/);
  assert.match(html, /cách diễn giải đã được đơn giản hóa/i);
  assert.match(html, /id="method-base-formula"/);
  assert.match(html, /id="method-final-formula"/);
  assert.match(script, /÷ 3/);
  assert.match(script, /50 \+.*×.*− 50/);
  assert.match(script, /showModal\(\)/);
  assert.match(css, /\.trust-intro-dialog::backdrop/);
  assert.match(css, /\.trust-method-popover:popover-open/);
});

test('giao diện giải thích nhanh hiển thị bốn tỷ lệ lấy từ backend', () => {
  for (const id of ['explanation-text-score', 'explanation-auth-score', 'explanation-label-score', 'explanation-coverage-score']) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.match(script, new RegExp(`#${id}`));
  }
  assert.match(html, /Điểm số được hình thành thế nào\?/);
  assert.match(html, /id="explanation-(?:text|auth|label|coverage)-meter"/);
  assert.match(script, /baseQualityScore/);
  assert.match(script, /guardrails\?\.totalPenalty/);
  assert.match(css, /\.trust-signal-grid/);
});

test('giải thích nhanh được thu gọn mặc định và nút cách tính điểm nằm giữa', () => {
  assert.match(html, /<details class="trust-explanation-card">/);
  assert.doesNotMatch(html, /<details class="trust-explanation-card"[^>]*open/);
  assert.match(html, /Nhấn để xem giải thích chi tiết/);
  assert.match(css, /\.trust-method \{[^}]*place-items: center/);
  assert.match(css, /\.trust-method-trigger \{[\s\S]*?justify-self: center/);
  assert.match(css, /\.trust-method-trigger \{[\s\S]*?margin-inline: auto/);
});

test('thống kê tổng quan nằm trong footer toàn chiều rộng của thẻ TrustScore', () => {
  assert.match(html, /<footer class="overview-stats"[^>]*>[\s\S]*?id="scanned-count"[\s\S]*?id="kept-count-top"[\s\S]*?id="excluded-count-top"[\s\S]*?<\/footer>/);
  assert.match(css, /\.trust-card \{[\s\S]*?"footer footer"/);
  assert.match(css, /\.overview-stats \{[^}]*grid-area: footer/);
});
