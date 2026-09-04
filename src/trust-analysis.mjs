import { geminiThinkingConfig, parseGeminiJson, requestGeminiWithFallback } from './gemini-response.mjs';
import { calculateTrustScoreV31 } from './trust-score-v31.mjs';

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

const MAX_NARRATIVE_EVIDENCE = 18;

function normalise(value = '') {
  return String(value).toLocaleLowerCase('vi').replace(/\s+/g, ' ').trim();
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

function percentage(part, whole) {
  return whole > 0 ? part / whole * 100 : 0;
}

function hasNonNegatedPhrase(text, phrase) {
  let offset = 0;
  while (offset < text.length) {
    const index = text.indexOf(phrase, offset);
    if (index < 0) return false;
    const prefix = text.slice(Math.max(0, index - 32), index);
    const negated = /(?:không|ko|chẳng|chưa|\bk)\s+(?:\S+\s+){0,2}$/iu.test(prefix);
    if (!negated) return true;
    offset = index + phrase.length;
  }
  return false;
}

function countThemes(reviews, definitions) {
  return definitions
    .map((definition) => {
      const matching = reviews.filter((review) => {
        const text = normalise(review.text);
        return definition.words.some((word) => hasNonNegatedPhrase(text, normalise(word)));
      });
      return { ...definition, count: matching.length, example: matching[0]?.text || '' };
    })
    .filter((theme) => theme.count > 0)
    .sort((left, right) => right.count - left.count);
}

function countDefectThemes(reviews) {
  return negativeDefinitions
    .map((definition) => {
      const matching = reviews.filter((review) => {
        const categories = review?.labels?.defect_categories;
        if (Array.isArray(categories)) return categories.includes(definition.id);
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
  // Dùng đúng nhãn cuối của pipeline, cùng nguồn dữ liệu với công thức điểm.
  // Tránh UI đếm bằng keyword khác với số khuyết tật ở backend.
  const cons = countDefectThemes(included)
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
  if (!Number.isFinite(score)) return { id: 'neutral', label: 'Chưa đủ bằng chứng' };
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

function plainTrustSummary(score, includedCount, scoreStatus = 'valid') {
  if (!Number.isFinite(score) || scoreStatus === 'insufficient') {
    return 'Chưa có đủ review hữu ích và đủ độ phủ mẫu để tính TrustScore đáng tin cậy. Bạn vẫn có thể đọc các review đã được phân loại, nhưng chưa nên suy rộng kết quả.';
  }
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
    baselines: options.baselines || configuredBaselines(),
    sampling: options.sampling
  });
  const score = method.score;
  const { pros, cons } = fallbackCopy(reviews, included, excluded);
  const tone = trustTone(score);
  const mostFrequentDefect = [...method.defects.tests].sort((left, right) => right.count - left.count)[0];
  const controlledDefectSample = method.defects.status === 'standardized-controlled-sample';
  const detailedCount = included.filter((review) => normalise(review.text).length >= 45).length;
  const verifiedCount = included.filter((review) => review.verified).length;
  const excludedRate = reviews.length ? Math.round(excluded.length / reviews.length * 100) : 0;
  const drivers = [
    {
      impact: method.components.authenticity.score >= 70 ? 'up' : 'down',
      title: method.components.authenticity.score >= 70 ? 'Phần lớn review không mang dấu hiệu nhiễu rõ ràng' : 'Tập review còn nhiều nội dung cần thận trọng',
      detail: method.components.authenticity.score >= 70
        ? 'Tỷ lệ nội dung bị nhận diện là seeding, quá mơ hồ hoặc ít giá trị hiện ở mức thấp trong mẫu đã thu thập.'
        : 'Mẫu hiện có tỷ lệ đáng kể review seeding, quá mơ hồ hoặc ít thông tin; những nội dung này không được dùng như bằng chứng chính.'
    },
    {
      impact: 'neutral',
      title: controlledDefectSample
        ? (mostFrequentDefect?.count ? `${mostFrequentDefect.label} xuất hiện trong nhóm review cần cân nhắc` : 'Chưa thấy một nhược điểm cụ thể lặp lại')
        : mostFrequentDefect?.count
          ? `${mostFrequentDefect.label} được nhiều người cùng nhắc`
          : 'Chưa thấy một lỗi cụ thể bị nhắc lặp lại',
      detail: controlledDefectSample
        ? (mostFrequentDefect?.count
          ? `${mostFrequentDefect.count} review đáng tham khảo cùng đề cập đến “${mostFrequentDefect.label.toLowerCase()}”. Vì mẫu được lấy gần đều theo mức sao, hệ thống cân bằng mức lỗi giữa các nhóm sao khi tổng hợp nhược điểm; con số này không được diễn giải là tỷ lệ lỗi của toàn bộ sản phẩm và không tham gia TrustScore.`
          : `Trong ${method.sample.afterSeedingRemoval} review sau bước lọc nhiễu, chưa có một nhược điểm cụ thể được nhắc lặp lại rõ ràng. Với mẫu chia tầng, thuật toán so sánh cân bằng giữa các mức sao thay vì giả định đây là phân bố tự nhiên.`)
        : mostFrequentDefect?.count
          ? `${mostFrequentDefect.count} review đáng tham khảo cùng đề cập đến “${mostFrequentDefect.label.toLowerCase()}”. Đây là thông tin để người dùng cân nhắc về sản phẩm; bản thân việc nêu lỗi rõ ràng không làm review kém đáng tin.`
          : `Trong ${method.sample.afterSeedingRemoval} review còn lại sau bước lọc nhiễu, chưa có một nhóm lỗi nào được người mua nhắc lại đủ rõ. Thống kê này không trực tiếp tăng hoặc giảm TrustScore.`
    },
    {
      impact: method.components.text.score >= 60 ? 'up' : 'down',
      title: method.components.text.score >= 60 ? 'Review có nội dung đủ rõ để đối chiếu' : 'Nhiều review còn thiếu chi tiết trải nghiệm',
      detail: `Trong ${included.length} review được giữ lại, ${detailedCount} review mô tả trải nghiệm đủ chi tiết và ${verifiedCount} review có tín hiệu đã mua hàng. ${method.components.text.score >= 60 ? 'Những thông tin này giúp người mua hiểu rõ lý do khen hoặc chê thay vì chỉ nhìn số sao.' : 'Khi review quá ngắn hoặc khó kiểm chứng, kết luận cần được đọc thận trọng hơn.'}`
    },
    {
      impact: 'neutral',
      title: method.sampling.controlledStarStrata ? 'Phân bố số sao là do thiết kế lấy mẫu' : 'Phân bố sao chỉ mang tính mô tả',
      detail: method.sampling.controlledStarStrata
        ? 'Hệ thống chủ động lọc theo sao để thu thập nhiều góc nhìn. Vì đây không phải phân bố tự nhiên của toàn bộ sản phẩm, tỷ lệ sao không được dùng để tăng hoặc giảm TrustScore.'
        : 'Actor không cam kết chọn review ngẫu nhiên, vì vậy tỷ lệ sao trong mẫu chỉ được hiển thị để tham khảo và không được suy rộng ra toàn bộ sản phẩm.'
    },
    {
      impact: 'neutral',
      title: 'Thời gian đăng chỉ dùng để tham khảo',
      detail: `Có thể đọc ngày đăng của khoảng ${Math.round(method.temporal.coverage * 100)}% review được giữ lại. Do actor có thể sắp xếp theo đề xuất, tín hiệu thời gian không tham gia TrustScore.`
    },
    {
      impact: excludedRate > 0 && excludedRate <= 35 ? 'up' : 'neutral',
      title: excluded.length ? 'Đã lọc review ngắn, trùng hoặc có dấu hiệu seeding' : 'Không phát hiện nhiều review cần loại khỏi bằng chứng chính',
      detail: excluded.length
        ? `Hệ thống đã giữ lại ${included.length}/${reviews.length} review và loại ${excluded.length} review (${excludedRate}%) vì thiếu thông tin, trùng lặp hoặc có dấu hiệu seeding. Việc công khai bước lọc giúp phần kết luận không bị dẫn dắt bởi những phản hồi kém giá trị.`
        : `Toàn bộ ${reviews.length} review hiện đủ điều kiện làm bằng chứng chính. Đây là tín hiệu tốt, nhưng TrustScore vẫn chỉ nói về độ tin cậy của review chứ không thay thế việc kiểm tra sản phẩm.`
    },
    {
      impact: method.scoreStatus === 'valid' ? 'up' : 'neutral',
      title: method.scoreStatus === 'valid' ? 'Mẫu bằng chứng đạt mức sử dụng' : 'Mẫu bằng chứng còn hạn chế',
      detail: method.scoreStatus === 'valid'
        ? `Cỡ mẫu bằng chứng cân bằng đạt ${method.adequacy.balancedEvidenceSize.toFixed(1)} review trên mốc ${method.adequacy.targetSample}.`
        : `Cỡ mẫu bằng chứng cân bằng hiện là ${method.adequacy.balancedEvidenceSize.toFixed(1)}/${method.adequacy.targetSample}; hệ thống ${method.scoreStatus === 'insufficient' ? 'không công bố TrustScore' : 'đánh dấu kết quả là tạm thời'}.`
    },
  ];

  return {
    score,
    label: tone.label,
    tone: tone.id,
    scoreStatus: method.scoreStatus,
    summary: plainTrustSummary(score, included.length, method.scoreStatus),
    pros,
    cons,
    drivers,
    method,
    engine: `statistical-v${method.version}`
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
      type: 'array', minItems: 6, maxItems: 8,
      items: { type: 'object', properties: { impact: { type: 'string', enum: ['up', 'down', 'neutral'] }, title: { type: 'string' }, detail: { type: 'string' } }, required: ['impact', 'title', 'detail'] }
    }
  },
  required: ['summary', 'pros', 'cons', 'drivers']
};

function finalLabels(review) {
  return review?.labeling?.final || review?.labels || {};
}

function ratingLevel(review) {
  const value = Math.round(clamp(review?.rating, 0, 5));
  return value >= 1 && value <= 5 ? value : 0;
}

function defectCategories(review) {
  const categories = finalLabels(review)?.defect_categories;
  return Array.isArray(categories)
    ? [...new Set(categories.filter((category) => typeof category === 'string' && category))]
    : [];
}

function representativePriority(left, right) {
  const leftDefects = defectCategories(left.review).length > 0;
  const rightDefects = defectCategories(right.review).length > 0;
  if (leftDefects !== rightDefects) return Number(rightDefects) - Number(leftDefects);
  const leftRating = ratingLevel(left.review) || 6;
  const rightRating = ratingLevel(right.review) || 6;
  if (leftRating !== rightRating) return leftRating - rightRating;
  const leftIncluded = left.review.included !== false;
  const rightIncluded = right.review.included !== false;
  if (leftIncluded !== rightIncluded) return Number(rightIncluded) - Number(leftIncluded);
  if (Boolean(left.review.verified) !== Boolean(right.review.verified)) {
    return Number(Boolean(right.review.verified)) - Number(Boolean(left.review.verified));
  }
  const lengthDifference = String(right.review.text || '').length - String(left.review.text || '').length;
  return lengthDifference || left.index - right.index;
}

function compactEvidence(review, index) {
  const labels = finalLabels(review);
  return {
    id: index + 1,
    rating: ratingLevel(review),
    verified: typeof review.verified === 'boolean' ? review.verified : null,
    included: review.included !== false,
    exclusionReason: review.exclusionReason || null,
    defectCategories: defectCategories(review),
    reviewedBy: labels.reviewed_by || null,
    text: String(review.text || '').replace(/\s+/g, ' ').trim().slice(0, 360)
  };
}

function selectRepresentativeEvidence(reviews) {
  const candidates = reviews.map((review, index) => ({ review, index }));
  const ranked = [...candidates].sort(representativePriority);
  const selected = [];
  const selectedIndexes = new Set();
  const addBest = (predicate) => {
    if (selected.length >= MAX_NARRATIVE_EVIDENCE) return;
    const candidate = ranked.find((item) => !selectedIndexes.has(item.index) && predicate(item.review));
    if (!candidate) return;
    selected.push(candidate);
    selectedIndexes.add(candidate.index);
  };

  const categories = [...new Set(candidates.flatMap(({ review }) => defectCategories(review)))].sort();
  for (const category of categories) addBest((review) => defectCategories(review).includes(category));

  const ratings = [...new Set(candidates.map(({ review }) => ratingLevel(review)).filter(Boolean))].sort((left, right) => left - right);
  for (const rating of ratings) addBest((review) => ratingLevel(review) === rating);

  const exclusionReasons = [...new Set(candidates
    .filter(({ review }) => review.included === false && review.exclusionReason)
    .map(({ review }) => String(review.exclusionReason)))].sort();
  for (const reason of exclusionReasons) addBest((review) => review.included === false && String(review.exclusionReason) === reason);

  for (const candidate of ranked) {
    if (selected.length >= MAX_NARRATIVE_EVIDENCE) break;
    if (!selectedIndexes.has(candidate.index)) {
      selected.push(candidate);
      selectedIndexes.add(candidate.index);
    }
  }
  return selected.map(({ review, index }) => compactEvidence(review, index));
}

function countRatings(reviews) {
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, unknown: 0 };
  for (const review of reviews) {
    const rating = ratingLevel(review);
    if (rating) counts[rating] += 1;
    else counts.unknown += 1;
  }
  return counts;
}

function countExclusionReasons(reviews) {
  const counts = {};
  for (const review of reviews) {
    if (review.included !== false) continue;
    const reason = String(review.exclusionReason || 'Không nêu lý do');
    counts[reason] = (counts[reason] || 0) + 1;
  }
  return counts;
}

export function buildGeminiNarrativePayload(reviews = [], fallback) {
  const included = reviews.filter((review) => review.included !== false);
  const excluded = reviews.filter((review) => review.included === false);
  const method = fallback?.method || {};
  return {
    fixedBackendDraft: {
      score: fallback.score,
      label: fallback.label,
      summary: fallback.summary,
      pros: fallback.pros,
      cons: fallback.cons,
      drivers: fallback.drivers
    },
    fullSampleStatistics: {
      total: reviews.length,
      included: included.length,
      excluded: excluded.length,
      verification: {
        verified: reviews.filter((review) => review.verified === true).length,
        unverified: reviews.filter((review) => review.verified === false).length,
        unknown: reviews.filter((review) => typeof review.verified !== 'boolean').length
      },
      detailed: reviews.filter((review) => normalise(review.text).length >= 45).length,
      ratings: countRatings(reviews),
      includedRatings: countRatings(included),
      exclusionReasons: countExclusionReasons(reviews),
      defects: (method.defects?.tests || []).map(({ id, label, count }) => ({ id, label, count })),
      sampling: method.sampling || null,
      adequacy: method.adequacy || null
    },
    representativeEvidence: selectRepresentativeEvidence(reviews)
  };
}

function cleanItem(item, fallback) {
  if (!item || typeof item !== 'object') return fallback;
  return {
    title: String(item.title || fallback?.title || '').slice(0, 90),
    detail: String(item.detail || fallback?.detail || '').slice(0, 420),
    mentions: Math.max(0, Math.round(Number(fallback?.mentions) || 0))
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
  const drivers = Array.isArray(value.drivers) && value.drivers.length >= 6
    ? value.drivers.slice(0, 8).map((item, index) => cleanDriver(item, fallback.drivers[index] || fallback.drivers[0]))
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

async function analyzeWithGemini(reviews, fallback, options = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = 'gemini-3.5-flash-lite';
  const narrativePayload = buildGeminiNarrativePayload(reviews, fallback);
  const prompt = [
    'Bạn là hệ thống kiểm định review thương mại điện tử của RealView.',
    'Backend đã xử lý toàn bộ review, chạy đủ hai lớp nhãn và tính xong TrustScore. Bạn chỉ viết lại phần diễn giải cho dễ hiểu.',
    'Viết phần diễn giải TrustScore bằng tiếng Việt cho người mua phổ thông. Tuyệt đối không chấm lại hoặc sửa điểm thống kê.',
    'Giữ nguyên thứ tự, chủ đề và số lượt mentions của từng pros/cons trong fixedBackendDraft; không thêm, bớt hoặc tự đếm lại.',
    'fullSampleStatistics là số liệu chính xác của toàn bộ mẫu. Luôn dùng các tổng số này khi nói về số lượng hoặc tỷ lệ.',
    'representativeEvidence chỉ là các ví dụ minh họa được chọn từ toàn bộ mẫu. Không suy ra số lượt đề cập hoặc tỷ lệ từ tập ví dụ này.',
    'Chỉ dùng dữ liệu được cung cấp; không suy đoán đặc tính sản phẩm hoặc bịa số lượt đề cập.',
    'Review included=false đã bị giảm ưu tiên: dùng chúng để đánh giá chất lượng dữ liệu, không dùng làm bằng chứng ưu/nhược điểm sản phẩm.',
    'Điểm đã được backend tính bằng thuật toán RealView v4.1 để đo độ tin cậy của tập review từ chất lượng bằng chứng, mức ít nhiễu, độ phủ kiểm định và độ đầy đủ mẫu. Nhược điểm sản phẩm không trực tiếp làm giảm TrustScore.',
    'Nội dung hiển thị cho người dùng tuyệt đối không được nhắc Fisher, p-value, odds ratio, binomial, logistic, Bonferroni, guardrail, điểm thành phần hoặc công thức.',
    'Summary cần giải thích ý nghĩa kết quả bằng lời trong 2 câu và nhắc rõ TrustScore đo độ đáng tin của tập review, không phải điểm chất lượng tuyệt đối của sản phẩm.',
    'Mỗi ưu/nhược điểm phải nêu rõ người mua thích hoặc chưa hài lòng điều gì, ảnh hưởng thực tế ra sao và có bao nhiêu review cùng đề cập; tránh câu chung chung như “ghi nhận tín hiệu tích cực”.',
    'Trả về 6 đến 8 driver khác nhau. Mỗi driver phải dịch tín hiệu kỹ thuật thành ngôn ngữ đời thường: điều gì được quan sát thấy trong review, vì sao điều đó làm kết quả đáng tin hơn hoặc cần thận trọng hơn.',
    Number.isFinite(fallback.score)
      ? `Điểm cố định phải giữ nguyên: ${fallback.score}/100.`
      : 'Backend xác định chưa đủ bằng chứng nên không được tự tạo hoặc suy đoán TrustScore.',
    `Dữ liệu diễn giải: ${JSON.stringify(narrativePayload)}`
  ].join('\n');
  const geminiResult = await requestGeminiWithFallback({
    fetchImpl: options.fetchImpl,
    apiKey,
    primaryModel: model,
    context: 'Gemini TrustScore',
    deadlineAt: options.geminiContext?.deadlineAt,
    attemptTimeoutMs: 30_000,
    maxRetries: 2,
    retryOnTimeout: true,
    routeContext: options.geminiContext,
    validateResponse: async (response) => {
      const body = await response.json();
      return validateGeminiTrust(parseGeminiJson(body, 'Gemini TrustScore'), fallback);
    },
    buildRequest: (selectedModel, selectedApiKey) => ({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': selectedApiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 2048,
          thinkingConfig: geminiThinkingConfig('minimal', selectedModel),
          responseMimeType: 'application/json',
          responseSchema: trustSchema
        }
      }),
      signal: options.signal
    })
  });
  return {
    result: geminiResult.value,
    retry: {
      attemptedModels: geminiResult.attemptedModels || [],
      attemptedRouteIds: geminiResult.attemptedRouteIds || [],
      credentialAttempts: geminiResult.attemptedCredentialIds?.length || (geminiResult.credentialId ? 1 : 0),
      durationMs: geminiResult.totalDurationMs || 0
    }
  };
}

export async function buildTrustAnalysis(reviews = [], options = {}) {
  const narrativeStartedAt = Date.now();
  const fallback = buildRuleBasedTrust(reviews, options);
  try {
    const analyzed = await analyzeWithGemini(reviews, fallback, {
      fetchImpl: options.fetchImpl || fetch,
      geminiContext: options.geminiContext,
      signal: options.signal
    });
    const result = analyzed.result;
    if (process.env.VERCEL || options.logGeminiErrors) {
      (options.logger || console).log(JSON.stringify({
        level: 'info',
        event: 'gemini_trust_narrative_complete',
        durationMs: Date.now() - narrativeStartedAt,
        reviews: reviews.length,
        engine: result.engine,
        attemptedModels: analyzed.retry.attemptedModels,
        attemptedRouteIds: analyzed.retry.attemptedRouteIds,
        credentialAttempts: analyzed.retry.credentialAttempts
      }));
    }
    return result;
  } catch (error) {
    if (process.env.VERCEL || options.logGeminiErrors) {
      (options.logger || console).error('[trust-analysis] Gemini request failed', {
        model: 'gemini-3.5-flash-lite',
        durationMs: Date.now() - narrativeStartedAt,
        attempts: error?.attempts || 0,
        attemptedModels: error?.attemptedModels || [],
        attemptedRouteIds: error?.attemptedRouteIds || [],
        credentialAttempts: error?.attemptedCredentialIds?.length || 0,
        error: error?.message || 'Lỗi Gemini không xác định.'
      });
    }
    return {
      ...fallback,
      fallbackReason: error?.message || 'Không thể kết nối Gemini trong lượt phân tích này.'
    };
  }
}
