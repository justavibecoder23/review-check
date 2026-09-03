import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyBatchWithGemini, labelReviewLayer1, labelReviewsTwoLayer } from '../src/review-labeler.mjs';

test('review generic ngắn là low_value nhưng không bị suy diễn thành seeding', () => {
  const label = labelReviewLayer1({ rating: 5, text: 'Tốt' });
  assert.equal(label.is_low_value, true);
  assert.equal(label.is_seeding, false);
  assert.equal(label.has_defect, false);
});

test('Layer 1 loại chuỗi rác dài thay vì để NO_RULE_MATCH', () => {
  const label = labelReviewLayer1({
    rating: 5,
    text: 'Loại da: Hoi hoihhsjehejiwj21jqjwbwbwbwbwbbbwbwbwbebebe bbwn'
  });
  assert.equal(label.is_low_value, true);
  assert.equal(label.reason_codes.includes('LOW_VALUE_GIBBERISH'), true);
});

test('Layer 1 loại lời khen chỉ nói giao hàng và đóng gói', () => {
  const label = labelReviewLayer1({
    rating: 5,
    text: '5 ⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐ giao nhanh đẹp gói kỹ Sài Ok'
  });
  assert.equal(label.is_low_value, true);
  assert.equal(label.reason_codes.some((code) => ['LOW_VALUE_REPETITION', 'LOW_VALUE_LOGISTICS_ONLY'].includes(code)), true);
});

test('Layer 1 chỉ tạo ứng viên sai nhóm sản phẩm và bắt buộc chuyển Layer 2', () => {
  const label = labelReviewLayer1(
    { rating: 5, text: 'Dao cạo râu ok, sắc, bền và giá hạt dẻ' },
    0,
    { title: 'Bình nước Lucky 1000ml hình chó và mèo giữ nhiệt 4–6 tiếng' }
  );
  assert.equal(label.is_off_topic, false);
  assert.equal(label.relevance, 'needs_review');
  assert.equal(label.requires_llm, true);
  assert.equal(label.reason_codes.includes('OFF_TOPIC_CANDIDATE'), true);
});

test('Layer 1 không nhầm từ đẹp thành dép và giữ review cáp sạc hữu ích', () => {
  const product = { title: 'Cáp sạc nhanh Baseus bọc dù đầu cắm Type-C' };
  const samples = [
    'Dây sạc Baseus dùng rất tốt, sạc nhanh, bền, đầu cắm chắc chắn không lỏng lẻo. Thiết kế đẹp, dày dặn.',
    'DÂY sạc nhanh thật xịn sò, cắm vào nhận điện ngay, sạc ổn định không nóng máy. Màu sắc đẹp và chắc chắn.',
    'Đúng với mô tả: Xanh lam. Chất lượng sản phẩm: Rất tốt. Cáp đẹp nha, mềm, màu bắt mắt. Chất liệu dùng đỡ bị xù lông dây bọc dù.',
    'Màu xanh nhạt siêu đẹp. Dây mềm và dai, dễ cuốn. Đầu sạc chắc chắn.',
    'Sản phẩm dây sạc màu tím Huế, dây mềm mại, sạc nhanh, chất lượng tốt và bảo hành 2 năm.'
  ];
  for (const text of samples) {
    const label = labelReviewLayer1({ rating: 5, text }, 0, product);
    assert.equal(label.is_off_topic, false, text);
    assert.notEqual(label.relevance, 'needs_review', text);
    assert.equal(label.is_low_value, false, text);
    assert.ok(['medium', 'high'].includes(label.information_value), text);
  }
});

test('Layer 1 giữ review hộp đựng đồ có nhận xét chất lượng dù không lặp tên đầy đủ', () => {
  const product = { title: 'COMBO 2 Hộp vải đựng đồ đa năng' };
  const samples = [
    'Dung tích: vừa, to Chất liệu: vải Độ bền: 7/10 Đặc điểm: đẹp, nói chung là dùng được ổn.',
    'Hài lòng quá rẻ đẹp đựng đồ tiện lợi gọn hàng',
    'Hàng chất lượng y hình chất liệu tốt, đẹp, giao hàng hơi lâu nha.'
  ];
  for (const text of samples) {
    const label = labelReviewLayer1({ rating: 5, text }, 0, product);
    assert.equal(label.is_off_topic, false, text);
    assert.equal(label.is_low_value, false, text);
    assert.ok(['medium', 'high'].includes(label.information_value), text);
  }
});

test('chế độ mặc định chỉ gửi trường hợp chưa chắc chắn sang Gemini', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const result = await labelReviewsTwoLayer([
      { rating: 5, text: 'Dây mềm và dai, đầu sạc chắc chắn, sạc nhanh ổn định.' },
      { rating: 1, text: 'Pin yếu, sạc không vào.' },
      { rating: 5, text: 'Tốt' },
      { rating: 4, text: 'Mình đã sử dụng một thời gian và cảm nhận nhìn chung ổn.' }
    ], { product: { title: 'Cáp sạc nhanh Baseus' } });
    assert.equal(result.stats.layer2Requested, 1);
  } finally {
    if (previousKey) process.env.GEMINI_API_KEY = previousKey;
  }
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

test('chuẩn hóa xử lý đúng chữ Đ viết hoa khi nhận diện bằng chứng sản phẩm', () => {
  const label = labelReviewLayer1(
    { rating: 5, text: 'ĐẦU SẠC chắc chắn, DÂY SẠC mềm và sạc nhanh.' },
    0,
    { title: 'Cáp sạc nhanh Baseus' }
  );
  assert.equal(label.relevance, 'on_topic');
  assert.equal(label.is_off_topic, false);
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
    assert.equal(requestPayload.generationConfig.maxOutputTokens, 2048);
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
      mode: 'all',
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

test('Layer 1 nhận diện trải nghiệm đệm lót chân rõ ràng mà không cần Gemini', () => {
  for (const text of [
    'Êm chân, dễ điều chỉnh, rất ok, nên mua nha',
    'Lót vào đi rất êm và ôm chân. Rất hài lòng',
    'Miếng lót mềm bàn chân, sẽ giới thiệu sản phẩm này với người khác'
  ]) {
    const label = labelReviewLayer1({ rating: 5, text, verified: true }, 0, {
      title: 'Miếng lót giày êm chân hỗ trợ điều chỉnh kích thước'
    });
    assert.equal(label.is_low_value, false, text);
    assert.equal(label.information_value, 'high', text);
    assert.equal(label.requires_llm, false, text);
  }
});

test('Layer 2 lỗi vẫn giữ quyết định Layer 1 khi review có bằng chứng hữu ích rõ ràng', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  try {
    const result = await labelReviewsTwoLayer([{
      rating: 5,
      text: 'Dây mềm và dai, đầu cắm chắc chắn, sạc nhanh và không nóng máy',
      verified: true
    }], {
      mode: 'all',
      product: { title: 'Cáp sạc nhanh bọc dù' },
      fetchImpl: async () => ({ ok: false, status: 503 })
    });
    assert.equal(result.reviews[0].labels.layer2_unavailable, false);
    assert.equal(result.reviews[0].labels.layer2_fallback_accepted, true);
    assert.equal(result.reviews[0].labels.reviewed_by, 'layer1-safe-fallback');
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
      mode: 'all',
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
    assert.equal(result.reviews[0].labels.reviewed_by, 'layer1-safe-fallback');
    assert.deepEqual(result.reviews[0].labels.defect_categories, ['su-dung']);
    assert.equal(result.reviews[0].labeling.layer2.decision, 'abstain');
    assert.equal(result.reviews[0].labeling.layer2.reason_code, 'DEFECT_QUOTE_NOT_VERBATIM');
  } finally {
    if (previousKey) process.env.GEMINI_API_KEY = previousKey;
    else delete process.env.GEMINI_API_KEY;
  }
});

test('Layer 2 không được mở khóa review logistics-only bằng defect suy diễn', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  try {
    const text = 'Giao nhanh đóng gói kỹ đẹp ok';
    const result = await labelReviewsTwoLayer([{ rating: 5, text }], {
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            candidates: [{ content: { parts: [{ text: JSON.stringify({ labels: [{
              id: 'r0001', decision: 'correct', is_seeding: false, is_low_value: false,
              is_vague: false, is_off_topic: false, has_defect: true,
              defect_categories: ['giao-hang'], defect_quote: 'Giao nhanh',
              evidence_quote: 'Giao nhanh', confidence: 0.99,
              reason_code: 'DELIVERY_MENTION'
            }] }) }] } }]
          };
        }
      })
    });
    assert.equal(result.reviews[0].labels.is_low_value, true);
    assert.equal(result.reviews[0].labels.has_defect, false);
    assert.deepEqual(result.reviews[0].labels.defect_categories, []);
  } finally {
    if (previousKey) process.env.GEMINI_API_KEY = previousKey;
    else delete process.env.GEMINI_API_KEY;
  }
});

test('Layer 2 từ chối gắn nhãn khuyết tật cho lời khen dù quote là nguyên văn', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  try {
    const text = 'Lót vào đi rất êm và ôm chân, rất hài lòng';
    const result = await labelReviewsTwoLayer([{ rating: 5, text }], {
      mode: 'all',
      product: { title: 'Miếng lót giày êm chân' },
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            candidates: [{ content: { parts: [{ text: JSON.stringify({ labels: [{
              id: 'r0001', decision: 'correct', is_seeding: false, is_low_value: false,
              is_vague: false, is_off_topic: false, relevance: 'on_topic',
              information_value: 'high', has_defect: true, defect_categories: ['su-dung'],
              defect_quote: 'rất êm và ôm chân', evidence_quote: 'rất êm và ôm chân',
              confidence: 0.99, reason_code: 'WRONG_DEFECT'
            }] }) }] } }]
          };
        }
      })
    });
    assert.equal(result.reviews[0].labels.has_defect, false);
    assert.deepEqual(result.reviews[0].labels.defect_categories, []);
    assert.equal(result.reviews[0].labeling.layer2.decision, 'abstain');
    assert.equal(result.reviews[0].labeling.layer2.reason_code, 'DEFECT_EVIDENCE_NOT_NEGATIVE');
  } finally {
    if (previousKey) process.env.GEMINI_API_KEY = previousKey;
    else delete process.env.GEMINI_API_KEY;
  }
});

test('Layer 2 không hiểu nhầm phủ định lỗi như “không nóng” thành khuyết tật', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  try {
    const text = 'Sạc ổn định không nóng máy, đầu cắm chắc chắn';
    const result = await labelReviewsTwoLayer([{ rating: 5, text }], {
      mode: 'all',
      product: { title: 'Cáp sạc nhanh' },
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            candidates: [{ content: { parts: [{ text: JSON.stringify({ labels: [{
              id: 'r0001', decision: 'correct', is_seeding: false, is_low_value: false,
              is_vague: false, is_off_topic: false, relevance: 'on_topic',
              information_value: 'high', has_defect: true, defect_categories: ['su-dung'],
              defect_quote: 'không nóng máy', evidence_quote: 'không nóng máy',
              confidence: 0.99, reason_code: 'WRONG_NEGATION'
            }] }) }] } }]
          };
        }
      })
    });
    assert.equal(result.reviews[0].labels.has_defect, false);
    assert.equal(result.reviews[0].labeling.layer2.reason_code, 'DEFECT_EVIDENCE_NOT_NEGATIVE');
  } finally {
    if (previousKey) process.env.GEMINI_API_KEY = previousKey;
    else delete process.env.GEMINI_API_KEY;
  }
});

test('Layer 2 xác nhận off-topic chỉ khi trích dẫn nguyên văn nêu sản phẩm khác', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  try {
    const text = 'Dao cạo râu ok, sắc, bền và giá hạt dẻ';
    const result = await labelReviewsTwoLayer([{ rating: 5, text }], {
      product: { title: 'Bình nước Lucky 1000ml giữ nhiệt' },
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            candidates: [{ content: { parts: [{ text: JSON.stringify({ labels: [{
              id: 'r0001', decision: 'correct', is_seeding: false, is_low_value: false,
              is_vague: false, is_off_topic: true, relevance: 'off_topic',
              information_value: 'medium', has_defect: false, defect_categories: [],
              defect_quote: null, evidence_quote: 'Dao cạo râu', confidence: 0.96,
              reason_code: 'OTHER_PRODUCT_EXPLICIT'
            }] }) }] } }]
          };
        }
      })
    });
    assert.equal(result.reviews[0].labels.is_off_topic, true);
    assert.equal(result.reviews[0].labels.relevance, 'off_topic');
    assert.equal(result.reviews[0].labels.reviewed_by, 'gemini-layer2');
  } finally {
    if (previousKey) process.env.GEMINI_API_KEY = previousKey;
    else delete process.env.GEMINI_API_KEY;
  }
});

test('Layer 2 không được loại review đúng sản phẩm bằng trích dẫn chung chung', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  try {
    const text = 'Dây sạc Baseus dùng tốt, đầu cắm chắc chắn và thiết kế đẹp';
    const result = await labelReviewsTwoLayer([{ rating: 5, text }], {
      mode: 'all',
      product: { title: 'Cáp sạc nhanh Baseus bọc dù' },
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            candidates: [{ content: { parts: [{ text: JSON.stringify({ labels: [{
              id: 'r0001', decision: 'correct', is_seeding: false, is_low_value: false,
              is_vague: false, is_off_topic: true, relevance: 'off_topic',
              information_value: 'high', has_defect: false, defect_categories: [],
              defect_quote: null, evidence_quote: 'thiết kế đẹp', confidence: 0.99,
              reason_code: 'WRONG_OFF_TOPIC'
            }] }) }] } }]
          };
        }
      })
    });
    assert.equal(result.reviews[0].labels.is_off_topic, false);
    assert.equal(result.reviews[0].labels.reviewed_by, 'layer1-safe-fallback');
    assert.equal(result.reviews[0].labeling.layer2.reason_code, 'OFF_TOPIC_EVIDENCE_DOES_NOT_NAME_OTHER_PRODUCT');
  } finally {
    if (previousKey) process.env.GEMINI_API_KEY = previousKey;
    else delete process.env.GEMINI_API_KEY;
  }
});

test('Layer 2 hedge sang key khác khi request đầu phản hồi chậm', async () => {
  const text = 'Êm chân và dễ điều chỉnh';
  const batch = [{
    review: { rating: 5, text, verified: true },
    layer1: labelReviewLayer1({ rating: 5, text, verified: true }, 0)
  }];
  const labels = [{
    id: 'r0001', decision: 'confirm', is_seeding: false, is_low_value: false,
    is_vague: false, is_off_topic: false, relevance: 'on_topic', information_value: 'high',
    has_defect: false, defect_categories: [], defect_quote: null,
    evidence_quote: text, confidence: 0.98, reason_code: 'USEFUL_EXPERIENCE'
  }];
  const calls = [];
  const result = await classifyBatchWithGemini(batch, { title: 'Miếng lót giày' }, {
    hedgeDelayMs: 5,
    requestGeminiImpl: async ({ maxRetries }) => {
      calls.push(maxRetries);
      if (maxRetries === 0) await new Promise((resolve) => setTimeout(resolve, 40));
      return {
        value: labels,
        model: 'gemini-3.5-flash-lite',
        attemptedModels: ['gemini-3.5-flash-lite'],
        attemptedCredentialIds: [maxRetries === 0 ? 'slow-key' : 'fast-key'],
        totalDurationMs: maxRetries === 0 ? 40 : 1
      };
    }
  });
  assert.deepEqual(calls, [0, 1]);
  assert.deepEqual(result.labels, labels);
  assert.equal(result.retry.credentialAttempts, 1);
});

test('review trùng nội dung không tiêu hao thêm lượt kiểm định Layer 2', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  let sentReviews = 0;
  const text = 'Dây sạc chắc chắn, sạc nhanh ổn định và không làm nóng máy khi sử dụng.';
  try {
    const result = await labelReviewsTwoLayer([
      { reviewId: 'actor-a', rating: 5, text, verified: true },
      { reviewId: 'actor-b', rating: 5, text, verified: true }
    ], {
      mode: 'all',
      product: { title: 'Cáp sạc nhanh Baseus' },
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        const prompt = body.contents[0].parts[0].text;
        sentReviews = JSON.parse(prompt.split('Dữ liệu cần kiểm định: ')[1]).length;
        return {
          ok: true,
          async json() {
            return { candidates: [{ content: { parts: [{ text: JSON.stringify({ labels: [{
              id: 'r0001', decision: 'confirm', is_seeding: false, is_low_value: false,
              is_vague: false, is_off_topic: false, relevance: 'on_topic', information_value: 'high',
              has_defect: false, defect_categories: [], defect_quote: null,
              evidence_quote: text, confidence: 0.99, reason_code: 'USEFUL_EXPERIENCE'
            }] }) }] } }] };
          }
        };
      }
    });
    assert.equal(sentReviews, 1);
    assert.equal(result.stats.layer2Requested, 1);
    assert.equal(result.stats.duplicateContentCount, 1);
    assert.equal(result.reviews[1].labels.is_duplicate, true);
    assert.equal(result.reviews[1].labels.duplicate_of, 'r0001');
  } finally {
    if (previousKey) process.env.GEMINI_API_KEY = previousKey;
    else delete process.env.GEMINI_API_KEY;
  }
});
