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

test('mẫu quá nhỏ không công bố điểm nhưng vẫn trả ưu nhược điểm và giải thích', () => {
  const trust = buildRuleBasedTrust(reviews);
  assert.equal(trust.score, null);
  assert.equal(trust.scoreStatus, 'insufficient');
  assert.equal('confidence' in trust, false);
  assert.equal(trust.pros.length > 0, true);
  assert.equal(trust.cons.length > 0, true);
  assert.equal(trust.drivers.length >= 6, true);
  assert.match(trust.summary, /chưa có đủ review/i);
  assert.match(trust.pros[0].detail, /Dẫn chứng:/);
  assert.doesNotMatch(trust.drivers.map((driver) => `${driver.title} ${driver.detail}`).join(' '), /Fisher|p\s*=|OR\*|logistic|hard cap|Bonferroni/i);
});

test('backend luôn chỉ ra yếu tố thực sự hạ điểm và Gemini không thể đổi thành trung lập', async () => {
  const sample = Array.from({ length: 20 }, (_value, index) => index < 10 ? {
    rating: index % 5 + 1,
    text: `Review ${index + 1} mô tả trải nghiệm sử dụng sản phẩm rõ ràng, chi tiết và có thể đối chiếu sau nhiều ngày sử dụng.`,
    verified: true,
    included: true,
    labels: { information_value: 'high', is_seeding: false, is_vague: false, is_low_value: false, layer2_unavailable: false, defect_categories: [] }
  } : {
    rating: index % 5 + 1,
    text: `Nội dung quảng cáo cửa hàng số ${index + 1}`,
    verified: true,
    included: false,
    exclusionReason: 'Nội dung quảng cáo cửa hàng',
    labels: { information_value: 'none', is_seeding: false, is_vague: false, is_low_value: true, layer2_unavailable: false, defect_categories: [] }
  });
  const fallback = buildRuleBasedTrust(sample);
  const fallbackImpacts = fallback.drivers.map(({ impact }) => impact);
  const loweringTitles = fallback.drivers.filter(({ impact }) => impact === 'down').map(({ title }) => title).join(' ');

  assert.match(loweringTitles, /không đủ tin cậy|độ phủ mẫu/i);
  assert.equal(fallbackImpacts.includes('down'), true);

  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  try {
    const trust = await buildTrustAnalysis(sample, {
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return { candidates: [{ content: { parts: [{ text: JSON.stringify({
            summary: 'TrustScore phản ánh độ tin cậy của tập review, không phải chất lượng sản phẩm.',
            pros: [{ title: 'Điểm tích cực', detail: 'Một số review nêu trải nghiệm rõ ràng.', mentions: 999 }],
            cons: [{ title: 'Điểm cần cân nhắc', detail: 'Một số review không đủ điều kiện.', mentions: 999 }],
            drivers: Array.from({ length: 8 }, (_item, index) => ({ impact: 'neutral', title: `AI driver ${index + 1}`, detail: 'AI cố đổi tác động.' }))
          }) }] } }] };
        }
      })
    });
    assert.deepEqual(trust.drivers.map(({ impact }) => impact), fallbackImpacts);
    assert.equal(trust.drivers.some(({ impact }) => impact === 'down'), true);
    assert.equal(trust.drivers.some(({ title }) => /AI driver/.test(title)), false);
  } finally {
    if (previousKey) process.env.GEMINI_API_KEY = previousKey;
    else delete process.env.GEMINI_API_KEY;
  }
});

test('thành phần cao hơn mốc trung lập được hiển thị là yếu tố củng cố', () => {
  const sample = Array.from({ length: 20 }, (_value, index) => ({
    rating: index % 5 + 1,
    text: `Review ${index + 1} mô tả trải nghiệm sử dụng rõ ràng, chất liệu chắc chắn và hiệu quả có thể đối chiếu sau nhiều ngày.`,
    verified: true,
    included: true,
    labels: { information_value: 'high', is_seeding: false, is_vague: false, is_low_value: false, layer2_unavailable: false, defect_categories: [] }
  }));
  const trust = buildRuleBasedTrust(sample);

  assert.equal(trust.drivers.some((driver) => driver.impact === 'up'), true);
  assert.match(trust.drivers.filter((driver) => driver.impact === 'up').map((driver) => driver.title).join(' '), /review|nội dung|kiểm định|mẫu/i);
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

test('nhược điểm màn hình không dùng câu mẫu chất liệu của quần áo', () => {
  const monitorReviews = [
    'Bên trong màn hình có dị vật, shop đã đổi cho cái mới.',
    'Màn hình có dính keo rất khó lau.',
    'Mua hai lần đều gặp lỗi chết điểm ảnh và sọc màn hình.'
  ].map((text, index) => ({
    rating: index === 2 ? 1 : 3,
    text,
    verified: true,
    included: true,
    labels: {
      information_value: 'high',
      is_seeding: false,
      is_vague: false,
      is_low_value: false,
      defect_categories: ['chat-lieu']
    }
  }));

  const trust = buildRuleBasedTrust(monitorReviews, {
    product: { title: 'Màn hình Gaming LG UltraGear G6 27 inch' }
  });
  const item = trust.cons.find((candidate) => candidate.mentions === 3);

  assert.equal(item.title, 'Độ hoàn thiện / độ bền phần cứng');
  assert.match(item.detail, /Dẫn chứng:/);
  assert.doesNotMatch(item.detail, /chất liệu mỏng|\bthô\b|có mùi/i);
});

test('cụm phủ định không bị đếm ngược thành ưu điểm', () => {
  const trust = buildRuleBasedTrust(Array.from({ length: 20 }, (_, index) => ({
    rating: 5,
    text: `Sản phẩm không bền sau ${index + 1} lần sử dụng và mình không thấy chắc chắn.`,
    verified: true,
    included: true,
    labels: { information_value: 'high', is_seeding: false, is_vague: false, is_low_value: false, defect_categories: ['chat-lieu'] }
  })));
  assert.equal(trust.pros.some((item) => item.title === 'Chất lượng sản phẩm'), false);
  assert.equal(trust.cons.find((item) => item.title === 'Chất liệu / độ bền').mentions, 20);
});

test('giao diện bỏ Confidence và làm nổi bật ý nghĩa đúng của TrustScore', () => {
  const html = readFileSync(new URL('../public/results.html', import.meta.url), 'utf8');
  const clientScript = readFileSync(new URL('../public/results.js', import.meta.url), 'utf8');
  assert.doesNotMatch(`${html} ${clientScript}`, /Confidence/i);
  assert.match(html, /điểm độ tin cậy của <strong>tập review<\/strong>/i);
  assert.match(html, /không phải điểm chất lượng sản phẩm/i);
});

test('màu TrustScore tuân theo đúng các ngưỡng giao diện', () => {
  assert.equal(trustTone(null).id, 'neutral');
  assert.equal(trustTone(81).id, 'green');
  assert.equal(trustTone(80).id, 'green');
  assert.equal(trustTone(60).id, 'yellow');
  assert.equal(trustTone(59).id, 'orange');
  assert.equal(trustTone(50).id, 'orange');
  assert.equal(trustTone(49).id, 'red');
});

test('frontend không tự tính TrustScore từ trung bình sao khi backend thiếu điểm', () => {
  const clientScript = readFileSync(new URL('../public/results.js', import.meta.url), 'utf8');
  const fallbackBody = clientScript.slice(clientScript.indexOf('function fallbackTrust'), clientScript.indexOf('function renderStars'));
  assert.match(fallbackBody, /score:\s*null/);
  assert.doesNotMatch(fallbackBody, /average\s*\/\s*5|reduce\(\(sum, review\).*rating/s);
  assert.match(clientScript, /score\s*>=\s*80/);
});

test('tự dùng kết quả quy tắc khi Gemini không được cấu hình', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const trust = await buildTrustAnalysis(reviews);
    assert.equal(trust.engine, 'statistical-v4.2');
    assert.equal(trust.method.version, '4.2');
  } finally {
    if (previousKey) process.env.GEMINI_API_KEY = previousKey;
  }
});

test('Gemini diễn giải lỗi vẫn trả TrustScore thống kê khi đã có 20 review', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-only-key';
  const sufficientReviews = Array.from({ length: 20 }, (_, index) => ({
    rating: 5,
    text: `Review ${index + 1} mô tả trải nghiệm sử dụng thực tế và chất lượng sản phẩm rõ ràng.`,
    included: true,
    labels: {
      is_seeding: false,
      is_vague: false,
      is_low_value: false,
      is_off_topic: false,
      information_value: 'high',
      defect_categories: []
    }
  }));
  try {
    const trust = await buildTrustAnalysis(sufficientReviews, {
      fetchImpl: async () => { throw new Error('Gemini unavailable in test'); }
    });
    assert.ok(Number.isFinite(trust.score));
    assert.equal(trust.method.version, '4.2');
    assert.match(trust.fallbackReason, /Gemini unavailable/i);
  } finally {
    if (previousKey) process.env.GEMINI_API_KEY = previousKey;
    else delete process.env.GEMINI_API_KEY;
  }
});

test('Gemini không được che cảnh báo độ phủ hoặc thay điểm khi mẫu đủ 20 review nhưng thiếu tầng sao', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-only-key';
  const oneStratumReviews = Array.from({ length: 20 }, (_, index) => ({
    rating: 5,
    text: `Review ${index + 1} mô tả trải nghiệm sử dụng thực tế và chất lượng sản phẩm rõ ràng.`,
    verified: true,
    included: true,
    labels: {
      is_seeding: false,
      is_vague: false,
      is_low_value: false,
      is_off_topic: false,
      information_value: 'high',
      defect_categories: []
    }
  }));
  const sampling = { strategy: 'parallel-star-filters', ratingStrata: [1, 2, 3, 4, 5], perStarLimit: 20 };
  const fallback = buildRuleBasedTrust(oneStratumReviews, { sampling });
  try {
    const trust = await buildTrustAnalysis(oneStratumReviews, {
      sampling,
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            candidates: [{ content: { parts: [{ text: JSON.stringify({
              score: 100,
              summary: 'Tập review hoàn toàn đáng tin cậy và có thể dùng để kết luận chắc chắn.',
              pros: [],
              cons: [],
              drivers: []
            }) }] } }]
          };
        }
      })
    });

    assert.equal(fallback.scoreStatus, 'limited');
    assert.deepEqual(fallback.method.adequacy.missingRatings, [1, 2, 3, 4]);
    assert.equal(trust.score, fallback.score, 'Gemini không được thay TrustScore do backend tính');
    assert.equal(trust.scoreStatus, 'limited');
    assert.match(trust.summary, /Độ phủ bằng chứng còn hạn chế/i);
    assert.match(trust.summary, /nhận định tạm thời/i);
    assert.equal(trust.summary, fallback.summary);
    assert.doesNotMatch(trust.summary, /hoàn toàn đáng tin cậy/i);
  } finally {
    if (previousKey) process.env.GEMINI_API_KEY = previousKey;
    else delete process.env.GEMINI_API_KEY;
  }
});

test('mẫu bị loại toàn bộ luôn nói rõ không có review đủ điều kiện làm bằng chứng', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-only-key';
  let requests = 0;
  const rejectedReviews = Array.from({ length: 20 }, (_, index) => ({
    rating: index % 5 + 1,
    text: `Review ${index + 1} có nội dung chữ nhưng đã bị loại khỏi tập bằng chứng.`,
    verified: true,
    included: false,
    exclusionReason: 'Nội dung không đủ giá trị kiểm định',
    labels: {
      is_seeding: false,
      is_vague: false,
      is_low_value: true,
      is_off_topic: false,
      information_value: 'none',
      defect_categories: []
    }
  }));
  try {
    const trust = await buildTrustAnalysis(rejectedReviews, {
      sampling: { strategy: 'parallel-star-filters', ratingStrata: [1, 2, 3, 4, 5], perStarLimit: 4 },
      fetchImpl: async () => {
        requests += 1;
        throw new Error('Không nên gọi Gemini khi không có bằng chứng.');
      }
    });

    assert.equal(trust.method.sample.afterSeedingRemoval, 0);
    assert.match(trust.summary, /chưa có review đủ điều kiện làm bằng chứng/i);
    assert.doesNotMatch(trust.summary, /có nhiều bằng chứng đáng tin/i);
    assert.equal(trust.narrativeSkippedReason, 'no-eligible-evidence');
    assert.equal(requests, 0);
  } finally {
    if (previousKey) process.env.GEMINI_API_KEY = previousKey;
    else delete process.env.GEMINI_API_KEY;
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
    assert.equal(requestPayload.generationConfig.maxOutputTokens, 2048);
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

test('Gemini không được thay nhược điểm đã có dẫn chứng bằng câu mẫu sai ngành hàng', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-only-key';
  const monitorReviews = [{
    rating: 1,
    text: 'Màn hình bị chết điểm ảnh sau hai ngày sử dụng.',
    verified: true,
    included: true,
    labels: {
      information_value: 'high',
      is_seeding: false,
      is_vague: false,
      is_low_value: false,
      defect_categories: ['chat-lieu']
    }
  }];
  try {
    const fallback = buildRuleBasedTrust(monitorReviews, {
      product: { title: 'Màn hình Gaming LG UltraGear G6' }
    });
    const trust = await buildTrustAnalysis(monitorReviews, {
      product: { title: 'Màn hình Gaming LG UltraGear G6' },
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            candidates: [{ content: { parts: [{ text: JSON.stringify({
              summary: fallback.summary,
              pros: fallback.pros,
              cons: [{ title: 'Chất liệu mỏng', detail: 'Vải thô và có mùi.', mentions: 999 }],
              drivers: fallback.drivers
            }) }] } }]
          };
        }
      })
    });

    assert.deepEqual(trust.cons, fallback.cons);
    assert.doesNotMatch(`${trust.cons[0].title} ${trust.cons[0].detail}`, /vải thô|có mùi/i);
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

  assert.ok(
    fallback.drivers.some((driver) => /cân bằng mức lỗi giữa các nhóm sao/i.test(driver.detail)),
    'phải giải thích cách mẫu chia tầng chuẩn hóa tỷ lệ nhược điểm'
  );
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

test('nhãn kích thước dùng mô tả trung tính cho sản phẩm điện tử', () => {
  const reviews = [
    {
      rating: 2,
      verified: true,
      included: true,
      text: 'Chân đế chiếm nhiều diện tích hơn mình dự tính.',
      labels: {
        is_seeding: false,
        is_vague: false,
        is_low_value: false,
        has_defect: true,
        defect_categories: ['kich-co'],
        reviewed_by: 'layer1'
      }
    }
  ];

  const result = buildRuleBasedTrust(reviews, {
    product: { title: 'Màn hình Gaming LG UltraGear G6 27 inch' }
  });
  const sizeIssue = result.cons.find((item) => item.title === 'Kích thước / độ phù hợp');

  assert.ok(sizeIssue);
  assert.doesNotMatch(sizeIssue.detail, /form dáng|bảng size|có thể chật/i);
  assert.match(sizeIssue.detail, /không gian sử dụng/i);
});

test('tóm tắt review mỹ phẩm hiển thị nhiều chủ đề có số đếm và bằng chứng cụ thể', () => {
  const useful = [
    { rating: 5, text: 'Màu đẹp, lên màu chuẩn và son lì lắm.', labels: { has_defect: false, defect_categories: [] } },
    { rating: 5, text: 'Son lỳ phết, nhẹ môi và mùi thơm.', labels: { has_defect: false, defect_categories: [] } },
    { rating: 5, text: 'Đúng mô tả, màu xinh và không dính.', labels: { has_defect: false, defect_categories: [] } },
    { rating: 4, text: 'Độ che phủ ok, chất lượng tốt.', labels: { has_defect: false, defect_categories: [] } },
    { rating: 4, text: 'Màu đẹp nhưng son không lì, ăn là nhanh trôi.', labels: { has_defect: true, defect_categories: ['su-dung'] } },
    { rating: 4, text: 'Son quá lỏng, nhanh khô và khó tán.', labels: { has_defect: true, defect_categories: ['su-dung'] } },
    { rating: 3, text: 'Bôi lên bị khô môi và nóng rát.', labels: { has_defect: true, defect_categories: ['su-dung'] } },
    { rating: 2, text: 'Màu không chuẩn, không giống trên hình.', labels: { has_defect: true, defect_categories: ['dung-mo-ta'] } },
    { rating: 2, text: 'Giao chậm và hộp móp.', labels: { has_defect: true, defect_categories: ['giao-hang'] } }
  ].map((review) => ({ ...review, included: true, verified: true }));

  const trust = buildRuleBasedTrust(useful);
  assert.equal(trust.pros.length, 5);
  assert.equal(trust.cons.length, 5);
  assert.ok(trust.pros.some((item) => item.title === 'Màu sắc và độ lên màu' && item.mentions >= 2));
  assert.ok(trust.pros.some((item) => item.title === 'Độ bám và độ lì'));
  assert.ok(trust.cons.some((item) => item.title === 'Độ bám và khả năng giữ màu'));
  assert.ok(trust.cons.some((item) => item.title === 'Kết cấu và thao tác sử dụng'));
  assert.ok(trust.cons.some((item) => item.title === 'Cảm giác trên môi'));
  for (const item of [...trust.pros, ...trust.cons]) {
    assert.match(item.detail, /review đáng tham khảo cùng đề cập/);
    assert.match(item.detail, /Dẫn chứng:/);
  }
});
