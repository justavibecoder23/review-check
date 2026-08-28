const positiveDefinitions = [
  { id: 'chat-luong', title: 'Chất lượng sản phẩm', description: 'Người mua mô tả sản phẩm chắc chắn, hoàn thiện ổn hoặc có độ bền tốt.', words: ['chất lượng tốt', 'chất tốt', 'xịn', 'chắc chắn', 'bền', 'đường may đẹp', 'hoàn thiện tốt'] },
  { id: 'dung-mo-ta', title: 'Đúng mô tả và hình ảnh', description: 'Sản phẩm nhận được nhìn chung đúng mẫu, màu sắc hoặc hình ảnh mà shop đăng.', words: ['đúng mô tả', 'đúng hình', 'giống hình', 'đúng màu', 'đúng mẫu'] },
  { id: 'phu-hop', title: 'Trải nghiệm sử dụng tốt', description: 'Người mua cho biết sản phẩm dễ dùng, thoải mái hoặc đáp ứng đúng nhu cầu thực tế.', words: ['dùng tốt', 'dùng ổn', 'hoạt động tốt', 'mặc đẹp', 'thoải mái', 'vừa vặn', 'êm', 'tiện'] },
  { id: 'giao-hang', title: 'Giao hàng và đóng gói', description: 'Đơn hàng đến nhanh, được đóng gói cẩn thận và sản phẩm còn nguyên vẹn.', words: ['giao nhanh', 'đóng gói kỹ', 'đóng gói tốt', 'gói hàng kỹ', 'hàng nguyên vẹn'] },
  { id: 'gia-tri', title: 'Giá trị so với chi phí', description: 'Người mua cảm thấy chất lượng nhận được tương xứng với số tiền đã bỏ ra.', words: ['đáng tiền', 'đáng mua', 'giá tốt', 'hợp giá', 'giá hợp lý'] }
];

const negativeDefinitions = [
  { id: 'chat-lieu', title: 'Chất liệu / độ bền', description: 'Một số người mua phản ánh chất liệu mỏng, thô, có mùi hoặc dễ xuống cấp sau khi sử dụng.', words: ['vải mỏng', 'mỏng', 'xù', 'bong', 'rách', 'sờn', 'mùi', 'cứng', 'thô', 'nhão', 'kém chất lượng', 'dễ hỏng'] },
  { id: 'kich-co', title: 'Kích cỡ / form dáng', description: 'Kích thước thực tế có thể chật, rộng hoặc lệch so với bảng size và kỳ vọng của người mua.', words: ['form nhỏ', 'chật', 'rộng', 'ngắn', 'bé', 'size nhỏ', 'size lớn', 'không đúng size', 'lệch size'] },
  { id: 'dung-mo-ta', title: 'Khác mô tả / hình ảnh', description: 'Sản phẩm thực nhận có điểm khác về màu, mẫu, số lượng hoặc hình thức so với thông tin đăng bán.', words: ['khác hình', 'không giống', 'khác mô tả', 'sai màu', 'màu khác', 'thiếu', 'không đúng mẫu', 'lỗi'] },
  { id: 'giao-hang', title: 'Giao hàng / đóng gói', description: 'Người mua gặp tình trạng giao chậm, thiếu hàng hoặc sản phẩm bị ảnh hưởng do đóng gói chưa tốt.', words: ['giao chậm', 'lâu', 'móp', 'bể', 'vỡ', 'đóng gói sơ sài', 'giao thiếu', 'trễ'] },
  { id: 'su-dung', title: 'Trải nghiệm sử dụng', description: 'Sản phẩm có thể gây khó chịu, hoạt động yếu hoặc không đáp ứng tốt khi sử dụng thực tế.', words: ['không dùng được', 'không hoạt động', 'không bền', 'nóng', 'bí', 'khó chịu', 'rò', 'hết pin', 'yếu'] }
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

function reviewExcerpt(value, maximum = 105) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length <= maximum ? text : `${text.slice(0, maximum).trim()}…`;
}

function fallbackCopy(reviews, included, excluded) {
  const pros = countThemes(included.filter((review) => Number(review.rating) >= 4), positiveDefinitions)
    .slice(0, 3)
    .map((theme) => ({
      title: theme.title,
      detail: `${theme.count} review đáng tham khảo cùng đề cập. ${theme.description}${theme.example ? ` Dẫn chứng: “${reviewExcerpt(theme.example)}”` : ''}`,
      mentions: theme.count
    }));
  const cons = countThemes(included, negativeDefinitions)
    .slice(0, 3)
    .map((theme) => ({
      title: theme.title,
      detail: `${theme.count} review đáng tham khảo cùng đề cập. ${theme.description}${theme.example ? ` Dẫn chứng: “${reviewExcerpt(theme.example)}”` : ''}`,
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

function plainTrustSummary(score, includedCount) {
  if (!includedCount) return 'Chưa có đủ review hữu ích để đánh giá đáng tin cậy.';
  const meaning = score >= 80
    ? 'Các review đủ điều kiện hiện khá nhất quán, có nội dung dễ đối chiếu và ít dấu hiệu bất thường.'
    : score >= 60
      ? 'Phần lớn review đủ điều kiện có thể tham khảo, nhưng vẫn còn một vài tín hiệu cần đọc kỹ.'
      : 'Tập review hiện còn những điểm thiếu nhất quán hoặc khó kiểm chứng nên cần được xem thận trọng.';
  return `${meaning} Vì vậy, tập review đạt TrustScore ${score}/100. Đây là điểm về độ đáng tin của thông tin review, không phải điểm chất lượng tuyệt đối của sản phẩm.`;
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
  const detailedCount = included.filter((review) => normalise(review.text).length >= 45).length;
  const verifiedCount = included.filter((review) => review.verified).length;
  const drivers = [
    {
      impact: method.fisher.score >= 60 ? 'up' : 'down',
      title: method.fisher.score >= 60 ? 'Các đánh giá cực cao và cực thấp khá tự nhiên' : 'Một số đánh giá cực đoan cần được thận trọng',
      detail: method.fisher.score >= 60
        ? 'Các review 5 sao không tập trung bất thường ở nội dung mang dấu hiệu quảng bá, và review 1 sao không chủ yếu là lời phàn nàn quá mơ hồ. Vì vậy nhóm đánh giá cực cao hoặc cực thấp không làm giảm độ tin cậy.'
        : 'Một số review 5 sao hoặc 1 sao đi kèm nội dung khó kiểm chứng hay có dấu hiệu bất thường. Hệ thống vì thế thận trọng hơn và giảm mức tin cậy của tập review.'
    },
    {
      impact: method.defects.score >= 60 ? 'up' : 'down',
      title: mostFrequentDefect?.count
        ? `${mostFrequentDefect.label} được nhiều người cùng nhắc`
        : 'Chưa thấy một lỗi cụ thể bị nhắc lặp lại',
      detail: mostFrequentDefect?.count
        ? `${mostFrequentDefect.count} review đáng tham khảo cùng đề cập đến “${mostFrequentDefect.label.toLowerCase()}”. Khi nhiều người mua độc lập lặp lại cùng một vấn đề, đây được xem là nhược điểm cần cân nhắc và có thể kéo TrustScore xuống.`
        : `Trong ${method.sample.afterSeedingRemoval} review còn lại sau bước lọc nhiễu, chưa có một nhóm lỗi nào được người mua nhắc lại đủ rõ. Điều này giúp TrustScore không bị kéo xuống bởi một vấn đề lặp lại.`
    },
    {
      impact: method.components.text.score >= 60 ? 'up' : 'down',
      title: method.components.text.score >= 60 ? 'Review có nội dung đủ rõ để đối chiếu' : 'Nhiều review còn thiếu chi tiết trải nghiệm',
      detail: `Trong ${included.length} review được giữ lại, ${detailedCount} review mô tả trải nghiệm đủ chi tiết và ${verifiedCount} review có tín hiệu đã mua hàng. ${method.components.text.score >= 60 ? 'Những thông tin này giúp người mua hiểu rõ lý do khen hoặc chê thay vì chỉ nhìn số sao.' : 'Khi review quá ngắn hoặc khó kiểm chứng, kết luận cần được đọc thận trọng hơn.'}`
    },
    appliedCap
      ? {
        impact: 'neutral',
        title: 'Điểm đang được giới hạn để tránh kết luận quá mức',
        detail: `Dù một số tín hiệu đang tích cực, vẫn có điều kiện kiểm tra quan trọng chưa đủ mạnh nên hệ thống tạm không cho TrustScore vượt ${appliedCap.value}/100. Giới hạn này giúp tránh tạo cảm giác chắc chắn hơn mức dữ liệu thực sự cho phép.`
      }
      : {
        impact: reviews.length >= 100 ? 'up' : 'neutral',
        title: reviews.length >= method.adequacy.targetSample ? 'Dữ liệu đã đủ rộng để củng cố kết luận' : 'Số review hiện có còn ít so với mốc tham chiếu',
        detail: reviews.length >= method.adequacy.targetSample
          ? `Hệ thống đã phân tích ${reviews.length} review, đạt mốc tham chiếu ${method.adequacy.targetSample} review. Vì vậy kết luận có cơ sở dữ liệu rộng hơn để đối chiếu.`
          : `Hệ thống mới phân tích ${reviews.length}/${method.adequacy.targetSample} review so với mốc dữ liệu mục tiêu. Số review còn ít không trực tiếp làm TrustScore thấp đi, nhưng người mua vẫn nên đọc thêm các review cụ thể trước khi quyết định.`
      }
  ];

  return {
    score,
    label: tone.label,
    tone: tone.id,
    summary: plainTrustSummary(score, included.length),
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
    detail: String(item.detail || fallback?.detail || '').slice(0, 420),
    mentions: Math.max(0, Math.round(Number(item.mentions) || 0))
  };
}

const TECHNICAL_USER_COPY = /fisher|p\s*[=<]|odds|or\*?|binomial|logistic|hard\s*cap|bonferroni|p[- ]?value|điểm thô|hàm thống kê/i;

function cleanDriver(item, fallback) {
  if (!item || typeof item !== 'object') return fallback;
  const candidate = {
    impact: ['up', 'down', 'neutral'].includes(item.impact) ? item.impact : (fallback?.impact || 'neutral'),
    title: String(item.title || fallback?.title || '').slice(0, 100),
    detail: String(item.detail || fallback?.detail || '').slice(0, 420)
  };
  return TECHNICAL_USER_COPY.test(`${candidate.title} ${candidate.detail}`) ? fallback : candidate;
}

function validateGeminiTrust(value, fallback) {
  if (!value || typeof value !== 'object') throw new Error('Gemini không trả về kết quả JSON hợp lệ.');
  const pros = Array.isArray(value.pros) ? value.pros.slice(0, 3).map((item, index) => cleanItem(item, fallback.pros[index] || fallback.pros[0])) : fallback.pros;
  const cons = Array.isArray(value.cons) ? value.cons.slice(0, 3).map((item, index) => cleanItem(item, fallback.cons[index] || fallback.cons[0])) : fallback.cons;
  const drivers = Array.isArray(value.drivers)
    ? value.drivers.slice(0, 4).map((item, index) => cleanDriver(item, fallback.drivers[index] || fallback.drivers[0]))
    : fallback.drivers;
  const summary = String(value.summary || fallback.summary).slice(0, 420);
  return {
    ...fallback,
    summary: TECHNICAL_USER_COPY.test(summary) ? fallback.summary : summary,
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
    'Viết phần diễn giải TrustScore bằng tiếng Việt cho người mua phổ thông. Tuyệt đối không chấm lại hoặc sửa điểm thống kê.',
    'Chỉ dùng dữ liệu review được cung cấp; không suy đoán đặc tính sản phẩm hoặc bịa số lượt đề cập.',
    'Review included=false đã bị giảm ưu tiên: dùng chúng để đánh giá chất lượng dữ liệu, không dùng làm bằng chứng ưu/nhược điểm sản phẩm.',
    'Điểm đã được backend tính bằng thuật toán RealView v3.1 gồm Fisher exact, binomial exact, hiệu chỉnh đa kiểm định và hard cap.',
    'Nội dung hiển thị cho người dùng tuyệt đối không được nhắc Fisher, p-value, odds ratio, binomial, logistic, Bonferroni, hard cap, điểm thành phần hoặc công thức.',
    'Summary cần giải thích ý nghĩa kết quả bằng lời trong 2 câu và nhắc rõ TrustScore đo độ đáng tin của tập review, không phải điểm chất lượng tuyệt đối của sản phẩm.',
    'Mỗi ưu/nhược điểm phải nêu rõ người mua thích hoặc chưa hài lòng điều gì, ảnh hưởng thực tế ra sao và có bao nhiêu review cùng đề cập; tránh câu chung chung như “ghi nhận tín hiệu tích cực”.',
    'Mỗi driver phải dịch tín hiệu kỹ thuật thành ngôn ngữ đời thường: điều gì được quan sát thấy trong review, vì sao điều đó làm kết quả đáng tin hơn hoặc cần thận trọng hơn.',
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

