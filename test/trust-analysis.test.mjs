import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildGeminiNarrativePayload, buildRuleBasedTrust, buildTrustAnalysis, trustTone } from '../src/trust-analysis.mjs';

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
  assert.equal(trust.drivers.length >= 6, true);
  assert.match(trust.summary, /không phải điểm chất lượng tuyệt đối của sản phẩm/i);
  assert.match(trust.pros[0].detail, /Dẫn chứng:/);
  assert.doesNotMatch(trust.drivers.map((driver) => `${driver.title} ${driver.detail}`).join(' '), /Fisher|p\s*=|OR\*|logistic|hard cap|Bonferroni/i);
});

test('nhược điểm hiển thị dùng cùng nhãn cuối với bộ đếm TrustScore', () => {
  const labeled = [
    {
      rating: 1,
      text: 'Keo không bám chắc vào camera.',
      verified: true,
      included: true,
      labels: { is_seeding: false, is_vague: false, is_low_value: false, defect_categories: ['chat-lieu'], reviewed_by: 'layer1' }
    }
  ];
  const trust = buildRuleBasedTrust(labeled);
  assert.equal(trust.method.defects.tests.find((item) => item.id === 'chat-lieu').count, 1);
  assert.equal(trust.cons.find((item) => item.title === 'Chất liệu / độ bền').mentions, 1);
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
  let requestPayload;
  try {
    const statisticalFallback = buildRuleBasedTrust(reviews);
    const statisticalScore = statisticalFallback.score;
    const trust = await buildTrustAnalysis(reviews, {
      fetchImpl: async (_url, options) => {
        receivedHeader = options.headers['x-goog-api-key'];
        requestPayload = JSON.parse(options.body);
        return {
          ok: true,
          async json() {
            return {
              candidates: [{ content: { parts: [{ text: JSON.stringify({
                score: 76,
                summary: 'Phần lớn review hữu ích tích cực nhưng vẫn có vấn đề về chất liệu và form.',
                pros: [{ title: 'Đúng mô tả', detail: 'Một số người mua xác nhận sản phẩm đúng mô tả.', mentions: 999 }],
                cons: [{ title: 'Chất liệu mỏng', detail: 'Có review chi tiết cho biết vải mỏng.', mentions: 999 }],
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
    assert.equal(requestPayload.generationConfig.temperature, undefined);
    assert.equal(requestPayload.generationConfig.thinkingConfig.thinkingLevel, 'minimal');
    assert.equal(requestPayload.generationConfig.maxOutputTokens, 4096);
    assert.equal(trust.engine, 'gemini');
    assert.equal(trust.score, statisticalScore, 'Gemini không được thay đổi điểm thống kê');
    assert.equal(trust.pros[0].title, 'Đúng mô tả');
    assert.equal(trust.pros[0].mentions, statisticalFallback.pros[0].mentions, 'Gemini không được thay đổi bộ đếm backend');
    assert.equal(trust.cons[0].mentions, statisticalFallback.cons[0].mentions, 'Gemini không được thay đổi bộ đếm backend');
    assert.equal(trust.drivers.length >= 6, true);
    assert.doesNotMatch(`${trust.drivers[0].title} ${trust.drivers[0].detail}`, /Fisher|p\s*=|OR\*/i);
  } finally {
    if (previousKey) process.env.GEMINI_API_KEY = previousKey;
    else delete process.env.GEMINI_API_KEY;
  }
});

test('payload diễn giải giữ thống kê đủ 100 review nhưng chỉ gửi tối đa 18 dẫn chứng đại diện', () => {
  const defectIds = ['chat-lieu', 'kich-co', 'dung-mo-ta', 'giao-hang', 'su-dung'];
  const exclusionReasons = ['Quá ngắn', 'Trùng nội dung', 'Có dấu hiệu seeding'];
  const syntheticReviews = Array.from({ length: 100 }, (_value, index) => {
    const rating = index % 5 + 1;
    const included = index % 7 !== 0;
    const defect = defectIds[index % defectIds.length];
    return {
      rating,
      verified: index % 3 !== 0,
      included,
      exclusionReason: included ? null : exclusionReasons[index % exclusionReasons.length],
      text: `Review ${index + 1} mô tả trải nghiệm thực tế đủ chi tiết về sản phẩm, độ bền, cách sử dụng và vấn đề quan sát được. ${'Chi tiết bổ sung. '.repeat(30)}`,
      labels: {
        is_seeding: false,
        is_vague: false,
        is_low_value: false,
        defect_categories: [defect],
        reviewed_by: index % 2 ? 'gemini-layer2' : 'layer1'
      }
    };
  });
  const before = JSON.stringify(syntheticReviews);
  const fallback = buildRuleBasedTrust(syntheticReviews, {
    sampling: { strategy: 'parallel-star-filters', perStarLimit: 20 }
  });
  const payload = buildGeminiNarrativePayload(syntheticReviews, fallback);

  assert.equal(payload.fixedBackendDraft.score, fallback.score, 'payload không tính lại hoặc sửa TrustScore');
  assert.equal(payload.fullSampleStatistics.total, 100);
  assert.deepEqual(payload.fullSampleStatistics.ratings, { 1: 20, 2: 20, 3: 20, 4: 20, 5: 20, unknown: 0 });
  assert.equal(payload.representativeEvidence.length, 18);
  for (const rating of [1, 2, 3, 4, 5]) {
    assert.ok(payload.representativeEvidence.some((review) => review.rating === rating), `thiếu dẫn chứng ${rating} sao`);
  }
  for (const defect of defectIds) {
    assert.ok(payload.representativeEvidence.some((review) => review.defectCategories.includes(defect)), `thiếu dẫn chứng lỗi ${defect}`);
  }
  assert.equal(JSON.stringify(syntheticReviews), before, 'không được sửa dữ liệu review đầu vào');

  const oldPayload = {
    method: fallback.method,
    reviews: syntheticReviews.slice(0, 100).map((review, index) => ({
      id: index + 1,
      rating: review.rating,
      verified: review.verified,
      included: review.included !== false,
      exclusionReason: review.exclusionReason || null,
      text: String(review.text || '').slice(0, 520)
    }))
  };
  assert.ok(
    JSON.stringify(payload).length < JSON.stringify(oldPayload).length * 0.55,
    'payload mới phải nhỏ hơn ít nhất 45% so với cách gửi toàn bộ review'
  );
});

