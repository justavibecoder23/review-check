import test from 'node:test';
import assert from 'node:assert/strict';
import { labelReviewLayer1, labelReviewsTwoLayer } from '../src/review-labeler.mjs';

test('review generic ngắn là low_value nhưng không bị suy diễn thành seeding', () => {
  const label = labelReviewLayer1({ rating: 5, text: 'Tốt' });
  assert.equal(label.is_low_value, true);
  assert.equal(label.is_seeding, false);
  assert.equal(label.has_defect, false);
});

test('rule nhận xu tạo nhãn seeding có evidence', () => {
  const label = labelReviewLayer1({ rating: 5, text: 'Hình ảnh mang tính chất nhận xu, chưa dùng sản phẩm.' });
  assert.equal(label.is_seeding, true);
  assert.ok(label.evidence.some((item) => item.label === 'seeding'));
  assert.ok(label.confidence >= 0.9);
});

test('cụm nhận xu phổ biến vẫn được nhận diện nhưng từ “tính chất” không bị bắt nhầm', () => {
  const seeded = labelReviewLayer1({ rating: 5, text: 'Nhận xu nên đánh giá, sản phẩm chưa dùng.' });
  const genuine = labelReviewLayer1({ rating: 5, text: 'Chất liệu có tính chất co giãn tốt.' });
  assert.equal(seeded.is_seeding, true);
  assert.equal(genuine.is_seeding, false);
});

test('câu ngắn có lỗi cụ thể không bị loại thành low_value', () => {
  const label = labelReviewLayer1({ rating: 1, text: 'Pin yếu, sạc không vào.' });
  assert.equal(label.has_defect, true);
  assert.equal(label.is_low_value, false);
  assert.equal(label.is_vague, false);
  assert.deepEqual(label.defect_categories, ['su-dung']);
});

test('phủ định cục bộ ngăn bắt nhầm keyword đơn', () => {
  const label = labelReviewLayer1({ rating: 5, text: 'Vải không mỏng, mặc khá thoải mái.' });
  assert.equal(label.defect_categories.includes('chat-lieu'), false);
});

test('chuẩn hóa không được biến từ đồng âm khác dấu thành lỗi', () => {
  const label = labelReviewLayer1({ rating: 5, text: 'Lớp sơn đẹp, màu đúng như hình.' });
  assert.equal(label.has_defect, false);
});

test('bắt được cụm lỗi có ngữ cảnh nhưng không dùng keyword đơn quá rộng', () => {
  const material = labelReviewLayer1({ rating: 4, text: 'Đường may hơi thô và vải khá bí khi mặc trời nóng.' });
  const mismatch = labelReviewLayer1({ rating: 3, text: 'Không giống màu trên ảnh nhưng shop có phản hồi.' });
  const safe = labelReviewLayer1({ rating: 5, text: 'Bí quyết dùng sản phẩm được hướng dẫn rất rõ.' });
  assert.equal(material.defect_categories.includes('chat-lieu'), true);
  assert.equal(mismatch.defect_categories.includes('dung-mo-ta'), true);
  assert.equal(safe.has_defect, false);
});

test('vague chỉ áp dụng cho 1–2 sao khi không có lỗi cụ thể', () => {
  assert.equal(labelReviewLayer1({ rating: 1, text: 'Lừa đảo, quá thất vọng!' }).is_vague, true);
  assert.equal(labelReviewLayer1({ rating: 4, text: 'Lừa đảo, quá thất vọng!' }).is_vague, false);
  assert.equal(labelReviewLayer1({ rating: 1, text: 'Quá thất vọng vì pin yếu và sạc không vào.' }).is_vague, false);
});

test('lỗi keo dán, bong rơi và độ bền ngắn là khuyết tật cụ thể, không phải rant mơ hồ', () => {
  const samples = [
    'Chất lượng sản phẩm::( Dán k dính',
    'Kính bảo vệ cam k dính chắc được, chỉ cần chạm nhẹ là rơi',
    'Ship về không dính, lắp vào rớt ra quá tệ',
    'Đặt 3 cái thì 2 cái dán được còn 1 cái ko dán dc, phí tiền',
    'Độ bền được 2 ngày, ngày đầu rơi mất 1 mắt, phần lấp lánh cực kỳ dễ rơi'
  ];
  for (const text of samples) {
    const label = labelReviewLayer1({ rating: 1, text });
    assert.equal(label.has_defect, true, text);
    assert.equal(label.is_vague, false, text);
    assert.equal(label.is_low_value, false, text);
    assert.ok(label.defect_categories.includes('chat-lieu'), text);
  }
});

test('Layer 2 có thể sửa nhãn nhưng không được thay quote không có trong review', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  let requestPayload;
  try {
    const result = await labelReviewsTwoLayer([
      { rating: 2, text: 'Màu đen nhưng shop giao màu xám, còn thiếu dây đeo.', verified: true }
    ], {
      product: { title: 'Túi đeo vai' },
      fetchImpl: async (_url, options) => {
        requestPayload = JSON.parse(options.body);
        return {
          ok: true,
          async json() {
            return {
              candidates: [{ content: { parts: [{ text: JSON.stringify({ labels: [{
                id: 'r0001', decision: 'correct', is_seeding: false, is_low_value: false,
                is_vague: false, has_defect: true, defect_categories: ['dung-mo-ta'],
                defect_quote: 'shop giao màu xám, còn thiếu dây đeo', confidence: 0.97,
                evidence_quote: 'shop giao màu xám, còn thiếu dây đeo',
                reason_code: 'MISMATCH_AND_MISSING_ACCESSORY'
              }] }) }] } }]
            };
          }
        };
      }
    });
    assert.equal(requestPayload.generationConfig.temperature, undefined);
    assert.equal(requestPayload.generationConfig.thinkingConfig.thinkingLevel, 'minimal');
    assert.equal(requestPayload.generationConfig.maxOutputTokens, 8192);
    assert.equal(result.stats.engine, 'layer1+gemini-layer2');
    assert.equal(result.reviews[0].labels.reviewed_by, 'gemini-layer2');
    assert.deepEqual(result.reviews[0].labels.defect_categories, ['dung-mo-ta']);
  } finally {
    if (previousKey) process.env.GEMINI_API_KEY = previousKey;
    else delete process.env.GEMINI_API_KEY;
  }
});

test('Layer 2 lỗi thì pipeline fail-safe về Layer 1', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  try {
    const result = await labelReviewsTwoLayer([{ rating: 5, text: 'Tốt' }], {
      fetchImpl: async () => ({ ok: false, status: 503 })
    });
    assert.equal(result.reviews[0].labels.reviewed_by, 'layer1');
    assert.equal(result.reviews[0].labels.is_low_value, true);
    assert.ok(result.warnings.some((warning) => warning.includes('503')));
    assert.equal(result.stats.layer2Status, 'failed');
    assert.equal(result.stats.layer2Batches.failed, 1);
    assert.equal(result.stats.layer2Batches.succeeded, 0);
  } finally {
    if (previousKey) process.env.GEMINI_API_KEY = previousKey;
    else delete process.env.GEMINI_API_KEY;
  }
});

test('Layer 2 phải abstain khi bằng chứng lỗi không phải trích dẫn nguyên văn', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  try {
    const result = await labelReviewsTwoLayer([
      { rating: 1, text: 'Pin yếu, sạc không vào.', verified: true }
    ], {
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            candidates: [{ content: { parts: [{ text: JSON.stringify({ labels: [{
              id: 'r0001', decision: 'correct', is_seeding: false, is_low_value: false,
              is_vague: false, has_defect: true, defect_categories: ['giao-hang'],
              defect_quote: 'hộp bị móp nặng', confidence: 0.99,
              evidence_quote: 'Pin yếu',
              reason_code: 'INVENTED_EVIDENCE'
            }] }) }] } }]
          };
        }
      })
    });
    assert.equal(result.reviews[0].labels.reviewed_by, 'layer1');
    assert.deepEqual(result.reviews[0].labels.defect_categories, ['su-dung']);
    assert.equal(result.reviews[0].labeling.layer2.decision, 'abstain');
    assert.equal(result.reviews[0].labeling.layer2.reason_code, 'DEFECT_QUOTE_NOT_VERBATIM');
  } finally {
    if (previousKey) process.env.GEMINI_API_KEY = previousKey;
    else delete process.env.GEMINI_API_KEY;
  }
});
