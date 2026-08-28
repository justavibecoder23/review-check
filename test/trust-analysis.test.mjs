import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRuleBasedTrust, buildTrustAnalysis, trustTone } from '../src/trust-analysis.mjs';

const reviews = [
  { rating: 5, text: 'Sản phẩm đúng mô tả, chất lượng tốt và đóng gói kỹ, mình đã dùng một tuần.', verified: true, included: true },
  { rating: 4, text: 'Mặc khá thoải mái và đúng màu, giao hàng nhanh hơn dự kiến.', verified: true, included: true },
  { rating: 2, text: 'Vải mỏng và form nhỏ hơn bảng size, đường may cũng hơi thô.', verified: true, included: true },
  { rating: 5, text: 'Tốt', verified: false, included: false, exclusionReason: 'Quá ngắn hoặc không có trải nghiệm cụ thể' }
];

test('TrustScore quy tắc luôn nằm trên thang 100 và có giải thích', () => {
  const trust = buildRuleBasedTrust(reviews);
  assert.equal(Number.isInteger(trust.score), true);
  assert.equal(trust.score >= 0 && trust.score <= 100, true);
  assert.equal('confidence' in trust, false);
  assert.equal(trust.pros.length > 0, true);
  assert.equal(trust.cons.length > 0, true);
  assert.equal(trust.drivers.length >= 2, true);
  assert.match(trust.summary, /không phải điểm chất lượng tuyệt đối của sản phẩm/i);
  assert.match(trust.pros[0].detail, /Dẫn chứng:/);
  assert.doesNotMatch(trust.drivers.map((driver) => `${driver.title} ${driver.detail}`).join(' '), /Fisher|p\s*=|OR\*|logistic|hard cap|Bonferroni/i);
});

test('giao diện bỏ Confidence và làm nổi bật ý nghĩa đúng của TrustScore', () => {
  const html = readFileSync(new URL('../public/results.html', import.meta.url), 'utf8');
  const clientScript = readFileSync(new URL('../public/results.js', import.meta.url), 'utf8');
  assert.doesNotMatch(`${html} ${clientScript}`, /Confidence/i);
  assert.match(html, /TrustScore đánh giá độ tin cậy của review/i);
  assert.match(html, /không phải điểm chất lượng sản phẩm/i);
});

test('màu TrustScore tuân theo đúng các ngưỡng giao diện', () => {
  assert.equal(trustTone(81).id, 'green');
  assert.equal(trustTone(80).id, 'green');
  assert.equal(trustTone(60).id, 'yellow');
  assert.equal(trustTone(59).id, 'orange');
  assert.equal(trustTone(40).id, 'orange');
  assert.equal(trustTone(39).id, 'red');
});

test('tự dùng kết quả quy tắc khi Gemini không được cấu hình', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const trust = await buildTrustAnalysis(reviews);
    assert.equal(trust.engine, 'statistical-v3.1');
    assert.equal(trust.method.version, '3.1');
  } finally {
    if (previousKey) process.env.GEMINI_API_KEY = previousKey;
  }
});

test('Gemini dùng khóa ở header backend và trả cấu trúc giao diện an toàn', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-only-key';
  let receivedHeader;
  try {
    const statisticalScore = buildRuleBasedTrust(reviews).score;
    const trust = await buildTrustAnalysis(reviews, {
      fetchImpl: async (_url, options) => {
        receivedHeader = options.headers['x-goog-api-key'];
        return {
          ok: true,
          async json() {
            return {
              candidates: [{ content: { parts: [{ text: JSON.stringify({
                score: 76,
                summary: 'Phần lớn review hữu ích tích cực nhưng vẫn có vấn đề về chất liệu và form.',
                pros: [{ title: 'Đúng mô tả', detail: 'Một số người mua xác nhận sản phẩm đúng mô tả.', mentions: 1 }],
                cons: [{ title: 'Chất liệu mỏng', detail: 'Có review chi tiết cho biết vải mỏng.', mentions: 1 }],
                drivers: [
                  { impact: 'up', title: 'Kiểm định Fisher', detail: 'Điểm Fisher 90/100, p=0.01 và OR*=2.4.' },
                  { impact: 'down', title: 'Có phản hồi tiêu cực', detail: 'Review chi tiết nêu vấn đề chất liệu và kích cỡ.' }
                ]
              }) }] } }]
            };
          }
        };
      }
    });
    assert.equal(receivedHeader, 'test-only-key');
    assert.equal(trust.engine, 'gemini');
    assert.equal(trust.score, statisticalScore, 'Gemini không được thay đổi điểm thống kê');
    assert.equal(trust.pros[0].title, 'Đúng mô tả');
    assert.equal(trust.drivers.length, 2);
    assert.doesNotMatch(`${trust.drivers[0].title} ${trust.drivers[0].detail}`, /Fisher|p\s*=|OR\*/i);
  } finally {
    if (previousKey) process.env.GEMINI_API_KEY = previousKey;
    else delete process.env.GEMINI_API_KEY;
  }
});

