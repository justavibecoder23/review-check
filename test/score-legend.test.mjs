import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../public/results.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/results.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/results-v2.css', import.meta.url), 'utf8');

function legendHarness() {
  const items = [
    ['green', '80–100'], ['yellow', '60–79'], ['orange', '50–59'], ['red', '0–49']
  ].map(([tone, range]) => {
    const attributes = {};
    const classes = new Set();
    return {
      dataset: { scoreTone: tone, scoreRange: range },
      attributes,
      classes,
      classList: { toggle(name, active) { if (active) classes.add(name); else classes.delete(name); } },
      setAttribute(name, value) { attributes[name] = value; },
      removeAttribute(name) { delete attributes[name]; }
    };
  });
  const context = vm.createContext({
    document: {
      querySelector(selector) {
        if (selector === '#results-empty') return { classList: { remove() {} } };
        return null;
      },
      querySelectorAll(selector) { return selector === '[data-score-tone]' ? items : []; },
      addEventListener() {}
    },
    sessionStorage: { getItem() { return null; } }
  });
  vm.runInContext(script, context);
  return { items, render: context.renderScoreLegend };
}

test('thang điểm nằm cùng vòng tròn TrustScore, không còn ở phần giải thích bên dưới', () => {
  assert.equal((html.match(/class="score-legend"/g) || []).length, 1);
  const panelStart = html.indexOf('class="trust-score-panel"');
  const gaugeStart = html.indexOf('id="trust-gauge"');
  const legendStart = html.indexOf('class="score-legend"');
  const copyStart = html.indexOf('class="trust-copy"');
  assert.ok(panelStart < gaugeStart && gaugeStart < legendStart && legendStart < copyStart);
  assert.ok(!html.slice(html.indexOf('<section class="explanation-section"')).includes('class="score-legend"'));
});

test('đánh dấu đúng khung ở mọi ranh giới, bao gồm 80 thuộc mức xanh', () => {
  const { items, render } = legendHarness();
  for (const [score, tone, range] of [
    [0, 'red', '0–49'], [49, 'red', '0–49'],
    [50, 'orange', '50–59'], [59, 'orange', '50–59'],
    [60, 'yellow', '60–79'], [79, 'yellow', '60–79'],
    [80, 'green', '80–100'], [100, 'green', '80–100']
  ]) {
    render(score);
    const current = items.filter(item => item.classes.has('is-current'));
    assert.equal(current.length, 1);
    assert.equal(current[0].dataset.scoreTone, tone);
    assert.equal(current[0].attributes['aria-current'], 'true');
    assert.equal(items.filter(item => item.attributes['aria-current']).length, 1);
    assert.ok(html.includes(`data-score-tone="${tone}" data-score-range="${range}"`));
  }
});

test('thiếu điểm thì không đánh dấu sai thành khung đỏ', () => {
  const { items, render } = legendHarness();
  render(67);
  for (const score of [null, undefined, NaN]) {
    render(score);
    assert.equal(items.filter(item => item.classes.has('is-current')).length, 0);
    assert.equal(items.filter(item => item.attributes['aria-current']).length, 0);
  }
});

test('chỉ giữ thang màu, không có dòng chú thích khung điểm hoặc khoảng trống dành cho nó', () => {
  assert.doesNotMatch(html, /trust-current-range/);
  assert.doesNotMatch(script, /trust-current-range|Thuộc khung/);
  assert.doesNotMatch(css, /\.trust-current-range/);
});

test('thang điểm co giãn theo chiều rộng và cỡ chữ, không yêu cầu cuộn ngang', () => {
  assert.match(css, /container-type: inline-size/);
  assert.match(css, /@container \(max-width: 12\.5rem\)/);
  assert.match(css, /\.score-legend \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(css, /\.score-legend\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(script, /renderScoreLegend\(scoreAvailable \? score : null\)/);
});
