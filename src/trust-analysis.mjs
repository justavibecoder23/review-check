const positiveDefinitions = [
  { id: 'chat-luong', title: 'Chất lượng sản phẩm', words: ['chất lượng tốt', 'chất tốt', 'xịn', 'chắc chắn', 'bền', 'đường may đẹp', 'hoàn thiện tốt'] },
  { id: 'dung-mo-ta', title: 'Đúng mô tả và hình ảnh', words: ['đúng mô tả', 'đúng hình', 'giống hình', 'đúng màu', 'đúng mẫu'] },
  { id: 'phu-hop', title: 'Trải nghiệm sử dụng tốt', words: ['dùng tốt', 'dùng ổn', 'hoạt động tốt', 'mặc đẹp', 'thoải mái', 'vừa vặn', 'êm', 'tiện'] },
  { id: 'giao-hang', title: 'Giao hàng và đóng gói', words: ['giao nhanh', 'đóng gói kỹ', 'đóng gói tốt', 'gói hàng kỹ', 'hàng nguyên vẹn'] },
  { id: 'gia-tri', title: 'Giá trị so với chi phí', words: ['đáng tiền', 'đáng mua', 'giá tốt', 'hợp giá', 'giá hợp lý'] }
];

const negativeDefinitions = [
  { id: 'chat-lieu', title: 'Chất liệu / độ bền', words: ['vải mỏng', 'mỏng', 'xù', 'bong', 'rách', 'sờn', 'mùi', 'cứng', 'thô', 'nhão', 'kém chất lượng', 'dễ hỏng'] },
  { id: 'kich-co', title: 'Kích cỡ / form dáng', words: ['form nhỏ', 'chật', 'rộng', 'ngắn', 'bé', 'size nhỏ', 'size lớn', 'không đúng size', 'lệch size'] },
  { id: 'dung-mo-ta', title: 'Khác mô tả / hình ảnh', words: ['khác hình', 'không giống', 'khác mô tả', 'sai màu', 'màu khác', 'thiếu', 'không đúng mẫu', 'lỗi'] },
  { id: 'giao-hang', title: 'Giao hàng / đóng gói', words: ['giao chậm', 'lâu', 'móp', 'bể', 'vỡ', 'đóng gói sơ sài', 'giao thiếu', 'trễ'] },
  { id: 'su-dung', title: 'Trải nghiệm sử dụng', words: ['không dùng được', 'không hoạt động', 'không bền', 'nóng', 'bí', 'khó chịu', 'rò', 'hết pin', 'yếu'] }
];

function normalise(value = '') {
  return String(value).toLocaleLowerCase('vi').replace(/\s+/g, ' ').trim();
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

function percentage(part, whole) {
  return whole > 0 ? part / whole * 100 : 0;
}

function countThemes(reviews, definitions) {
  return definitions
    .map((definition) => {
      const matching = reviews.filter((review) => {
        const text = normalise(review.text);
        return definition.words.some((word) => text.includes(word));
      });
      return { ...definition, count: matching.length, example: matching[0]?.text || '' };
    })
    .filter((theme) => theme.count > 0)
    .sort((left, right) => right.count - left.count);
}

function fallbackCopy(reviews, included, excluded) {
  const pros = countThemes(included.filter((review) => Number(review.rating) >= 4), positiveDefinitions)
    .slice(0, 3)
    .map((theme) => ({
      title: theme.title,
      detail: `${theme.count} review hữu ích ghi nhận tín hiệu tích cực này.`,
      mentions: theme.count
    }));
  const cons = countThemes(included, negativeDefinitions)
    .slice(0, 3)
    .map((theme) => ({
      title: theme.title,
      detail: `${theme.count} review đáng tham khảo cùng nhắc đến vấn đề này.`,
      mentions: theme.count
    }));

  if (!pros.length) {
    const positiveCount = included.filter((review) => Number(review.rating) >= 4).length;
    pros.push({
      title: positiveCount ? 'Có phản hồi tích cực' : 'Chưa có ưu điểm nổi trội',
      detail: positiveCount
        ? `${positiveCount} review hữu ích chấm từ 4 sao, nhưng chưa cùng nhắc một ưu điểm đủ rõ.`
        : 'Dữ liệu hiện tại chưa cho thấy một ưu điểm được lặp lại rõ ràng.',
      mentions: positiveCount
    });
  }
  if (!cons.length) {
    const lowRatingCount = included.filter((review) => Number(review.rating) <= 3).length;
    cons.push({
      title: lowRatingCount ? 'Có phản hồi cần cân nhắc' : 'Chưa thấy nhược điểm lặp lại',
      detail: lowRatingCount
        ? `${lowRatingCount} review hữu ích chấm từ 3 sao trở xuống, nhưng chưa cùng chỉ ra một vấn đề cụ thể.`
        : 'Không có nhược điểm cụ thể nào được nhiều review hữu ích cùng nhắc đến.',
      mentions: lowRatingCount
    });
  }

  return { pros, cons };
}

export function trustTone(score) {
  if (score >= 80) return { id: 'green', label: 'Mức tin cậy rất cao' };
  if (score >= 60) return { id: 'yellow', label: 'Mức tin cậy khá tốt' };
  if (score >= 40) return { id: 'orange', label: 'Mức tin cậy trung bình' };
  return { id: 'red', label: 'Mức tin cậy thấp' };
}

function configuredBaselines() {
  if (!process.env.TRUST_BASELINES_JSON) return undefined;
  try {
    return JSON.parse(process.env.TRUST_BASELINES_JSON);
  } catch {
    return undefined;
  }
}

function formatPercent(value) {
  return `${Math.round((Number(value) || 0) * 100)}%`;
}

function formatPValue(value) {
  if (!Number.isFinite(value)) return 'chưa tính';
  if (value < 0.0001) return '< 0,0001';
  return value.toLocaleString('vi-VN', { maximumFractionDigits: 4 });
}

export function buildRuleBasedTrust(reviews = [], options = {}) {
  const included = reviews.filter((review) => review.included !== false);
  const excluded = reviews.filter((review) => review.included === false);
  const method = calculateTrustScoreV31(reviews, {
    product: options.product,
    category: options.category,
    baselines: options.baselines || configuredBaselines()
  });
  const score = method.score;
  const { pros, cons } = fallbackCopy(reviews, included, excluded);
  const tone = trustTone(score);
  const mostFrequentDefect = [...method.defects.tests].sort((left, right) => right.count - left.count)[0];
  const appliedCap = method.caps.applied[0];
  const drivers = [
    {
      impact: method.fisher.score >= 60 ? 'up' : 'down',
      title: 'Kiểm định Fisher cho review cực đoan',
      detail: `Điểm Fisher ${method.fisher.score.toFixed(1)}/100. Seeding × 5 sao: p=${formatPValue(method.fisher.positive.pValue)}, OR*=${method.fisher.positive.oddsRatio.toFixed(2)}; khiếu nại mơ hồ × 1 sao: p=${formatPValue(method.fisher.negative.pValue)}, OR*=${method.fisher.negative.oddsRatio.toFixed(2)}.`
    },
    {
      impact: method.defects.score >= 60 ? 'up' : 'down',
      title: 'Rủi ro khuyết tật có trọng số',
      detail: mostFrequentDefect?.count
        ? `${mostFrequentDefect.count} review nhắc “${mostFrequentDefect.label.toLowerCase()}”. Điểm khuyết tật ${method.defects.score.toFixed(1)}/100 sau khi tách tín hiệu seeding.`
        : `Chưa ghi nhận nhóm lỗi lặp lại trong ${method.sample.afterSeedingRemoval} review sau khi tách tín hiệu seeding.`
    },
    {
      impact: method.components.text.score >= 60 ? 'up' : 'down',
      title: 'Chất lượng bằng chứng văn bản',
      detail: `Điểm nội dung ${method.components.text.score.toFixed(1)}/100, dựa trên độ dài, chi tiết vấn đề và trạng thái xác minh; review 1–2 sao được chấm thêm bằng hàm logistic trong tài liệu.`
    },
    appliedCap
      ? {
        impact: 'neutral',
        title: `Hard cap đang giới hạn ở ${appliedCap.value}`,
        detail: 'Điểm thô không được vượt qua ngưỡng an toàn khi Fisher hoặc rủi ro khuyết tật chưa đạt điều kiện bắt buộc.'
      }
      : {
        impact: reviews.length >= 100 ? 'up' : 'neutral',
        title: 'Mức đủ dữ liệu của mẫu',
        detail: `${reviews.length}/100 review mục tiêu; dữ liệu ngày có ở ${formatPercent(method.adequacy.dateCoverage)} mẫu. Đây là mức đủ dữ liệu, không phải xác suất kết luận đúng.`
      }
  ];

  return {
    score,
    label: tone.label,
    tone: tone.id,
    confidence: { score: method.adequacy.score, label: method.adequacy.label },
    summary: included.length
      ? `TrustScore ${score}/100 được tính từ 5 thành phần thống kê; điểm thô ${method.rawScore.toFixed(1)}${method.caps.applied.length ? ` và bị giới hạn an toàn ở ${Math.min(...method.caps.applied.map((cap) => cap.value))}` : ''}.`
      : 'Chưa có đủ review hữu ích để đánh giá đáng tin cậy.',
    pros,
    cons,
    drivers,
    method,
    engine: 'statistical-v3.1'
  };
}

const trustSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    pros: {
      type: 'array', minItems: 1, maxItems: 3,
      items: { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string' }, mentions: { type: 'integer', minimum: 0 } }, required: ['title', 'detail', 'mentions'] }
    },
    cons: {
      type: 'array', minItems: 1, maxItems: 3,
      items: { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string' }, mentions: { type: 'integer', minimum: 0 } }, required: ['title', 'detail', 'mentions'] }
    },
    drivers: {
      type: 'array', minItems: 2, maxItems: 4,
      items: { type: 'object', properties: { impact: { type: 'string', enum: ['up', 'down', 'neutral'] }, title: { type: 'string' }, detail: { type: 'string' } }, required: ['impact', 'title', 'detail'] }
    }
  },
  required: ['summary', 'pros', 'cons', 'drivers']
};

function compactReviews(reviews) {
  return reviews.slice(0, 100).map((review, index) => ({
    id: index + 1,
    rating: clamp(review.rating, 0, 5),
    verified: Boolean(review.verified),
    included: review.included !== false,
    exclusionReason: review.exclusionReason || null,
    text: String(review.text || '').slice(0, 520)
  }));
}

function cleanItem(item, fallback) {
  if (!item || typeof item !== 'object') return fallback;
  return {
    title: String(item.title || fallback?.title || '').slice(0, 90),
    detail: String(item.detail || fallback?.detail || '').slice(0, 240),
    mentions: Math.max(0, Math.round(Number(item.mentions) || 0))
  };
}

function validateGeminiTrust(value, fallback) {
  if (!value || typeof value !== 'object') throw new Error('Gemini không trả về kết quả JSON hợp lệ.');
  const pros = Array.isArray(value.pros) ? value.pros.slice(0, 3).map((item, index) => cleanItem(item, fallback.pros[index] || fallback.pros[0])) : fallback.pros;
  const cons = Array.isArray(value.cons) ? value.cons.slice(0, 3).map((item, index) => cleanItem(item, fallback.cons[index] || fallback.cons[0])) : fallback.cons;
  const drivers = Array.isArray(value.drivers)
    ? value.drivers.slice(0, 4).map((item, index) => ({
      impact: ['up', 'down', 'neutral'].includes(item?.impact) ? item.impact : (fallback.drivers[index]?.impact || 'neutral'),
      title: String(item?.title || fallback.drivers[index]?.title || '').slice(0, 100),
      detail: String(item?.detail || fallback.drivers[index]?.detail || '').slice(0, 260)
    }))
    : fallback.drivers;
  return {
    ...fallback,
    summary: String(value.summary || fallback.summary).slice(0, 360),
    pros: pros.length ? pros : fallback.pros,
    cons: cons.length ? cons : fallback.cons,
    drivers: drivers.length ? drivers : fallback.drivers,
    engine: 'gemini'
  };
}

async function analyzeWithGemini(reviews, fallback, fetchImpl) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return fallback;
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const prompt = [
    'Bạn là hệ thống kiểm định review thương mại điện tử của RealView.',
    'Viết phần diễn giải TrustScore bằng tiếng Việt. Tuyệt đối không chấm lại hoặc sửa điểm thống kê.',
    'Chỉ dùng dữ liệu review được cung cấp; không suy đoán đặc tính sản phẩm hoặc bịa số lượt đề cập.',
    'Review included=false đã bị giảm ưu tiên: dùng chúng để đánh giá chất lượng dữ liệu, không dùng làm bằng chứng ưu/nhược điểm sản phẩm.',
    'Điểm đã được backend tính bằng thuật toán RealView v3.1 gồm Fisher exact, binomial exact, hiệu chỉnh đa kiểm định và hard cap.',
    'Pros/cons phải ngắn, cụ thể. Drivers phải giải thích rõ điều gì làm tăng hoặc giảm độ tin cậy.',
    `Điểm cố định phải giữ nguyên: ${fallback.score}/100.`,
    `Chi tiết phương pháp: ${JSON.stringify(fallback.method)}.`,
    `Dữ liệu: ${JSON.stringify(compactReviews(reviews))}`
  ].join('\n');
  const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.15,
        responseMimeType: 'application/json',
        responseSchema: trustSchema
      }
    }),
    signal: AbortSignal.timeout(22_000)
  });
  if (!response.ok) throw new Error(`Gemini trả về HTTP ${response.status}`);
  const body = await response.json();
  const text = body?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
  return validateGeminiTrust(JSON.parse(text), fallback);
}

export async function buildTrustAnalysis(reviews = [], options = {}) {
  const fallback = buildRuleBasedTrust(reviews, options);
  try {
    return await analyzeWithGemini(reviews, fallback, options.fetchImpl || fetch);
  } catch (error) {
    return {
      ...fallback,
      fallbackReason: error?.message || 'Không thể kết nối Gemini trong lượt phân tích này.'
    };
  }
}
import { calculateTrustScoreV31 } from './trust-score-v31.mjs';
