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
  if (score > 80) return { id: 'green', label: 'Độ tin cậy cao' };
  if (score >= 60) return { id: 'yellow', label: 'Khá đáng tin' };
  if (score >= 50) return { id: 'orange', label: 'Nên cân nhắc kỹ' };
  return { id: 'red', label: 'Độ tin cậy thấp' };
}

export function buildRuleBasedTrust(reviews = []) {
  const included = reviews.filter((review) => review.included !== false);
  const excluded = reviews.filter((review) => review.included === false);
  const ratings = included.map((review) => clamp(review.rating, 0, 5)).filter((rating) => rating > 0);
  const averageRating = ratings.length ? ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length : 0;
  const usefulRatio = percentage(included.length, reviews.length);
  const verifiedRatio = percentage(included.filter((review) => review.verified).length, included.length);
  const detailedRatio = percentage(included.filter((review) => normalise(review.text).length >= 45).length, included.length);
  const ratingComponent = averageRating / 5 * 55;
  const score = Math.round(clamp(
    ratingComponent + usefulRatio * .15 + verifiedRatio * .15 + detailedRatio * .15,
    0,
    100
  ));
  const confidenceScore = Math.round(clamp(
    18 + Math.min(reviews.length, 30) / 30 * 32 + usefulRatio * .18 + verifiedRatio * .16 + detailedRatio * .16,
    0,
    97
  ));
  const confidenceLabel = confidenceScore >= 78 ? 'Cao' : confidenceScore >= 56 ? 'Trung bình' : 'Thấp';
  const lowRatings = included.filter((review) => Number(review.rating) <= 3).length;
  const { pros, cons } = fallbackCopy(reviews, included, excluded);
  const tone = trustTone(score);
  const drivers = [];

  if (verifiedRatio >= 65) {
    drivers.push({ impact: 'up', title: 'Nhiều lượt mua đã xác minh', detail: `${Math.round(verifiedRatio)}% review hữu ích đến từ người mua đã xác minh.` });
  } else {
    drivers.push({ impact: 'down', title: 'Tỷ lệ xác minh còn hạn chế', detail: `Chỉ ${Math.round(verifiedRatio)}% review hữu ích có tín hiệu mua hàng đã xác minh.` });
  }
  if (detailedRatio >= 55) {
    drivers.push({ impact: 'up', title: 'Phản hồi có chi tiết trải nghiệm', detail: `${Math.round(detailedRatio)}% review giữ lại có mô tả đủ dài để đối chiếu.` });
  } else {
    drivers.push({ impact: 'down', title: 'Ít bằng chứng trải nghiệm', detail: `Chỉ ${Math.round(detailedRatio)}% review giữ lại mô tả trải nghiệm đủ chi tiết.` });
  }
  if (excluded.length) {
    drivers.push({ impact: excluded.length > included.length ? 'down' : 'neutral', title: 'Đã giảm nhiễu trước khi chấm', detail: `${excluded.length}/${reviews.length} review bị loại vì quá ngắn, chung chung hoặc có dấu hiệu seeding.` });
  }
  if (lowRatings) {
    drivers.push({ impact: 'down', title: 'Có phản hồi tiêu cực đáng tham khảo', detail: `${lowRatings} review giữ lại chấm từ 3 sao trở xuống.` });
  } else if (included.length) {
    drivers.push({ impact: 'up', title: 'Ít tín hiệu tiêu cực mạnh', detail: 'Không có review hữu ích nào chấm từ 3 sao trở xuống trong mẫu hiện tại.' });
  }
  if (reviews.length < 8) {
    drivers.push({ impact: 'neutral', title: 'Mẫu review còn nhỏ', detail: `Kết luận hiện chỉ dựa trên ${reviews.length} review nên cần đọc thêm trước khi mua.` });
  }

  return {
    score,
    label: tone.label,
    tone: tone.id,
    confidence: { score: confidenceScore, label: confidenceLabel },
    summary: included.length
      ? `Điểm ${score}/100 phản ánh đồng thời mức hài lòng, độ chi tiết và khả năng kiểm chứng của ${included.length} review hữu ích.`
      : 'Chưa có đủ review hữu ích để đánh giá đáng tin cậy.',
    pros,
    cons,
    drivers: drivers.slice(0, 4),
    engine: 'rules'
  };
}

const trustSchema = {
  type: 'object',
  properties: {
    score: { type: 'integer', minimum: 0, maximum: 100 },
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
  required: ['score', 'summary', 'pros', 'cons', 'drivers']
};

function compactReviews(reviews) {
  return reviews.slice(0, 60).map((review, index) => ({
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
  const score = Math.round(clamp(value.score, Math.max(0, fallback.score - 8), Math.min(100, fallback.score + 8)));
  const tone = trustTone(score);
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
    score,
    label: tone.label,
    tone: tone.id,
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
    'Hãy chấm TrustScore sản phẩm trên thang 0-100 và viết toàn bộ nội dung bằng tiếng Việt.',
    'Chỉ dùng dữ liệu review được cung cấp; không suy đoán đặc tính sản phẩm hoặc bịa số lượt đề cập.',
    'Review included=false đã bị giảm ưu tiên: dùng chúng để đánh giá chất lượng dữ liệu, không dùng làm bằng chứng ưu/nhược điểm sản phẩm.',
    'Rubric: 55% mức hài lòng từ rating của review hữu ích; 15% tỷ lệ review hữu ích; 15% tỷ lệ mua đã xác minh; 15% độ chi tiết. Có thể điều chỉnh tối đa 8 điểm nếu nhiều review hữu ích nhất quán chỉ ra cùng một vấn đề hoặc ưu điểm.',
    'Pros/cons phải ngắn, cụ thể. Drivers phải giải thích rõ điều gì làm tăng hoặc giảm độ tin cậy.',
    `Mốc tham chiếu từ hệ thống quy tắc: ${fallback.score}/100.`,
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
  const fallback = buildRuleBasedTrust(reviews);
  try {
    return await analyzeWithGemini(reviews, fallback, options.fetchImpl || fetch);
  } catch (error) {
    return {
      ...fallback,
      fallbackReason: error?.message || 'Không thể kết nối Gemini trong lượt phân tích này.'
    };
  }
}
