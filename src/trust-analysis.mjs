import { geminiThinkingConfig, parseGeminiJson, requestGeminiWithFallback } from './gemini-response.mjs';
import { calculateTrustScoreV31 } from './trust-score-v31.mjs';
import { domainAwareSummaryEnabled, resolveProductDomain } from './product-domain.mjs';

const positiveDefinitions = [
  { id: 'chat-luong', title: 'Chất lượng sản phẩm', description: 'Người mua mô tả sản phẩm chắc chắn, hoàn thiện ổn hoặc có độ bền tốt.', words: ['chất lượng tốt', 'chất tốt', 'xịn', 'chắc chắn', 'bền', 'đường may đẹp', 'hoàn thiện tốt'] },
  { id: 'dung-mo-ta', title: 'Đúng mô tả và hình ảnh', description: 'Sản phẩm nhận được nhìn chung đúng mẫu, màu sắc hoặc hình ảnh mà shop đăng.', words: ['đúng mô tả', 'đúng hình', 'giống hình', 'đúng màu', 'đúng mẫu'] },
  { id: 'phu-hop', title: 'Trải nghiệm sử dụng tốt', description: 'Người mua cho biết sản phẩm dễ dùng, thoải mái hoặc đáp ứng đúng nhu cầu thực tế.', words: ['dùng tốt', 'dùng ổn', 'hoạt động tốt', 'mặc đẹp', 'thoải mái', 'vừa vặn', 'êm', 'tiện'] },
  { id: 'giao-hang', title: 'Giao hàng và đóng gói', description: 'Đơn hàng đến nhanh, được đóng gói cẩn thận và sản phẩm còn nguyên vẹn.', words: ['giao nhanh', 'đóng gói kỹ', 'đóng gói tốt', 'gói hàng kỹ', 'hàng nguyên vẹn'] },
  { id: 'gia-tri', title: 'Mức độ đáp ứng kỳ vọng', description: 'Người mua cho biết sản phẩm đáp ứng nhu cầu và trải nghiệm sử dụng mong đợi.', words: ['đáng tiền', 'đáng mua', 'giá tốt', 'hợp giá', 'giá hợp lý'] },
  { id: 'mau-sac', title: 'Màu sắc và độ lên màu', description: 'Người mua hài lòng với màu thực tế hoặc cách sản phẩm lên màu.', domains: ['beauty'], words: ['màu đẹp', 'màu xinh', 'lên màu đẹp', 'lên màu chuẩn', 'màu ưng', 'màu cũng ok', 'màu cũng được'] },
  { id: 'do-bam', title: 'Độ bám và độ lì', description: 'Một số người mua ghi nhận màu bám tương đối tốt hoặc giữ được trên môi.', domains: ['beauty'], words: ['son lì', 'son lỳ', 'son li', 'son ly', 'lì lắm', 'lỳ lắm', 'lì phết', 'lỳ phết', 'bám màu', 'lâu trôi', 'độ lì'] },
  { id: 'cam-giac', title: 'Cảm giác khi sử dụng', description: 'Người mua mô tả sản phẩm nhẹ, mềm hoặc dễ chịu khi dùng.', domains: ['beauty'], words: ['nhẹ môi', 'mềm môi', 'không khô môi', 'ko khô môi', 'không dính', 'ko dính'] },
  { id: 'thao-tac', title: 'Dễ sử dụng và che phủ', description: 'Sản phẩm được nhận xét là dễ dùng hoặc có độ che phủ ổn.', domains: ['beauty'], words: ['dễ đánh', 'che phủ tốt', 'độ che phủ ok', 'độ che phủ: ok'] }
];

const negativeDefinitions = [
  { id: 'chat-lieu', title: 'Chất liệu / độ bền', description: 'Một số người mua phản ánh chất liệu mỏng, thô, có mùi hoặc dễ xuống cấp sau khi sử dụng.', words: ['vải mỏng', 'mỏng', 'xù', 'bong', 'rách', 'sờn', 'mùi', 'cứng', 'thô', 'nhão', 'kém chất lượng', 'dễ hỏng'] },
  { id: 'kich-co', title: 'Kích thước / độ phù hợp', description: 'Một số người mua cho biết kích thước thực tế chưa phù hợp với nhu cầu, không gian sử dụng hoặc kích cỡ dự kiến.', words: ['form nhỏ', 'chật', 'rộng', 'ngắn', 'bé', 'size nhỏ', 'size lớn', 'không đúng size', 'lệch size'] },
  { id: 'dung-mo-ta', title: 'Khác mô tả / hình ảnh', description: 'Sản phẩm thực nhận có điểm khác về màu, mẫu, số lượng hoặc hình thức so với thông tin đăng bán.', words: ['khác hình', 'không giống', 'khác mô tả', 'sai màu', 'màu khác', 'thiếu', 'không đúng mẫu', 'lỗi'] },
  { id: 'giao-hang', title: 'Giao hàng / đóng gói', description: 'Người mua gặp tình trạng giao chậm, thiếu hàng hoặc sản phẩm bị ảnh hưởng do đóng gói chưa tốt.', words: ['giao chậm', 'lâu', 'móp', 'bể', 'vỡ', 'đóng gói sơ sài', 'giao thiếu', 'trễ'] },
  { id: 'su-dung', title: 'Trải nghiệm sử dụng', description: 'Sản phẩm có thể gây khó chịu, hoạt động yếu hoặc không đáp ứng tốt khi sử dụng thực tế.', words: ['không dùng được', 'không hoạt động', 'không bền', 'nóng', 'bí', 'khó chịu', 'rò', 'hết pin', 'yếu'] },
  { id: 'do-bam-mau', title: 'Độ bám và khả năng giữ màu', description: 'Một số người mua cho biết màu không đủ lì, dễ lem hoặc trôi nhanh khi ăn uống.', domains: ['beauty'], matchFromText: true, words: ['không lì', 'ko lì', 'k lì', 'không lỳ', 'ko lỳ', 'không có lì', 'ko có lì', 'không bám', 'ko bám', 'k bám', 'nhanh trôi', 'mau trôi', 'trôi nhanh', 'cũng trôi', 'không còn son', 'chẳng còn son', 'giữ màu không lâu', 'giữ màu ko lâu'] },
  { id: 'ket-cau-thao-tac', title: 'Kết cấu và thao tác sử dụng', description: 'Sản phẩm bị nhận xét là quá lỏng, dễ chảy hoặc khô nhanh khiến người dùng khó tán đều.', domains: ['beauty'], matchFromText: true, words: ['quá lỏng', 'rất lỏng', 'son lỏng', 'son dạng lỏng', 'son nước', 'trào ra', 'tràn ra', 'lem bẩn', 'khó tán', 'khó đánh', 'mau khô', 'nhanh khô'] },
  { id: 'cam-giac-su-dung', title: 'Cảm giác trên môi', description: 'Một số phản hồi đề cập tình trạng khô, rát hoặc tê môi gây khó chịu.', domains: ['beauty'], matchFromText: true, words: ['khô môi', 'môi khô', 'nứt môi', 'nóng rát', 'rát môi', 'tê môi', 'tê tê'] },
  { id: 'mau-sac-thuc-te', title: 'Màu sắc thực tế', description: 'Màu nhận được hoặc màu lên môi có chỗ chưa giống hình ảnh, quảng cáo hay kỳ vọng của người mua.', domains: ['beauty'], matchFromText: true, words: ['màu xỉn', 'màu tối', 'màu thâm', 'không chuẩn màu', 'ko chuẩn màu', 'màu không chuẩn', 'không giống trên hình', 'không như quảng cáo', 'không giống như quảng cáo', 'khác quảng cáo', 'hồng cánh sen'] },
  { id: 'huong-vi', title: 'Hương vị', description: 'Một số người mua cho biết hương vị thực tế chưa cân bằng hoặc chưa phù hợp với kỳ vọng.', domains: ['food'], matchFromText: true, words: ['quá mặn', 'hơi mặn', 'vị mặn', 'quá ngọt', 'hơi ngọt', 'quá chua', 'bị đắng', 'khó ăn'] },
  { id: 'do-cay', title: 'Độ cay', description: 'Mức độ cay của sản phẩm được phản ánh là chưa phù hợp với mô tả hoặc kỳ vọng.', domains: ['food'], matchFromText: true, words: ['quá cay', 'cay quá', 'không cay', 'chẳng cay'] }
];

const MAX_NARRATIVE_EVIDENCE = 18;
const MAX_SUMMARY_ITEMS = 5;

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

function definitionApplies(definition, domain, enabled) {
  return !enabled || !definition.domains?.length || definition.domains.includes(domain);
}

function countThemes(reviews, definitions, domain = 'unknown', enabled = true) {
  return definitions
    .filter((definition) => definitionApplies(definition, domain, enabled))
    .map((definition) => {
      const matching = reviews.filter((review) => {
        const aspect = review?.labels?.aspect;
        if (enabled && aspect?.domain === domain && aspect?.sentiment === 'positive') return false;
        const text = normalise(review.text);
        return definition.words.some((word) => hasNonNegatedPhrase(text, normalise(word)));
      });
      return {
        ...definition,
        count: matching.length,
        evidenceIds: matching.map((review) => String(review.labelId || '')).filter(Boolean)
      };
    })
    .filter((theme) => theme.count > 0)
    .sort((left, right) => right.count - left.count);
}

function dynamicAspectThemes(reviews, domain, enabled, sentiment) {
  if (!enabled || domain === 'unknown') return [];
  const grouped = new Map();
  for (const review of reviews) {
    const aspect = review?.labels?.aspect;
    if (!aspect?.key || !aspect?.label || aspect.domain !== domain || aspect.sentiment !== sentiment) continue;
    if (sentiment === 'negative' && review?.labels?.has_defect !== true) continue;
    if (sentiment === 'positive' && review?.labels?.has_defect === true) continue;
    const id = `aspect:${aspect.key}`;
    const current = grouped.get(id) || {
      id,
      title: String(aspect.label).slice(0, 48),
      description: sentiment === 'negative'
        ? `Người mua phản ánh vấn đề cụ thể liên quan đến ${normalise(aspect.label)} trong quá trình sử dụng sản phẩm.`
        : `Người mua ghi nhận trải nghiệm tích cực cụ thể về ${normalise(aspect.label)} của sản phẩm.`,
      count: 0,
      evidenceIds: []
    };
    current.count += 1;
    if (review.labelId) current.evidenceIds.push(String(review.labelId));
    grouped.set(id, current);
  }
  return [...grouped.values()];
}

function mergeThemes(themes) {
  const merged = new Map();
  for (const theme of themes) {
    const key = normalise(theme.title);
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...theme, evidenceIds: [...new Set(theme.evidenceIds || [])] });
      continue;
    }
    current.evidenceIds = [...new Set([...current.evidenceIds, ...(theme.evidenceIds || [])])];
    current.count = current.evidenceIds.length || current.count + theme.count;
  }
  return [...merged.values()].sort((left, right) => right.count - left.count);
}

function countDefectThemes(reviews, product = {}, enabled = true) {
  const domain = resolveProductDomain(product).domain;
  const themes = negativeDefinitions
    .filter((definition) => definitionApplies(definition, domain, enabled))
    .map((definition) => {
      const matching = reviews.filter((review) => {
        // has_defect của nhãn cuối là cổng quyết định. Khi Layer 2 phủ định
        // Layer 1, category hoặc keyword cũ không được phép tạo lỗi trở lại.
        if (review?.labels?.has_defect === false) return false;
        const aspect = review?.labels?.aspect;
        if (enabled && aspect?.domain === domain && aspect?.key && aspect?.label) return false;
        const categories = review?.labels?.defect_categories;
        if (Array.isArray(categories) && categories.includes(definition.id)) return true;
        if (!definition.matchFromText) return false;
        if (review?.labels?.has_defect !== true) return false;
        const text = normalise(review.text);
        return definition.words.some((word) => text.includes(normalise(word)));
      });
      return {
        ...definition,
        count: matching.length,
        evidenceIds: matching.map((review) => String(review.labelId || '')).filter(Boolean)
      };
    })
    .filter((theme) => theme.count > 0)
    .sort((left, right) => right.count - left.count);
  const combined = mergeThemes([...dynamicAspectThemes(reviews, domain, enabled, 'negative'), ...themes]);
  const hasSpecificExperienceTheme = combined.some((theme) => [
    'do-bam-mau',
    'ket-cau-thao-tac',
    'cam-giac-su-dung'
  ].includes(theme.id));
  return hasSpecificExperienceTheme
    ? combined.filter((theme) => theme.id !== 'su-dung')
    : combined;
}

function productWithResolvedDomain(product = {}, reviews = []) {
  const metadataResolution = resolveProductDomain(product);
  if (metadataResolution.domain !== 'unknown') return { ...product, domainResolution: metadataResolution };
  const candidates = reviews
    .map((review) => review?.labels?.product_domain)
    .filter((resolution) => resolution?.domain && Number(resolution.confidence) >= 0.85)
    .sort((left, right) => Number(right.confidence) - Number(left.confidence));
  return candidates.length ? { ...product, domainResolution: candidates[0] } : product;
}

const displayProductPattern = /(?:màn\s*hình|monitor|display|ultragear)/iu;

function contextualizeNegativeTheme(theme, product = {}) {
  const productContext = `${product?.title || ''} ${product?.category || ''}`;
  if (theme.id === 'chat-lieu' && displayProductPattern.test(productContext)) {
    return {
      ...theme,
      title: 'Độ hoàn thiện / độ bền phần cứng',
      description: 'Người mua nêu vấn đề cụ thể về độ hoàn thiện hoặc độ bền phần cứng của màn hình.'
    };
  }
  return theme;
}

function fallbackCopy(reviews, included, excluded, product = {}) {
  const enabled = domainAwareSummaryEnabled();
  const domain = resolveProductDomain(product).domain;
  const positiveReviews = included.filter((review) => Number(review.rating) >= 4);
  const pros = mergeThemes([
    ...dynamicAspectThemes(positiveReviews, domain, enabled, 'positive'),
    ...countThemes(positiveReviews, positiveDefinitions, domain, enabled)
  ])
    .slice(0, MAX_SUMMARY_ITEMS)
    .map((theme) => ({
      title: theme.title,
      detail: theme.description,
      mentions: theme.count,
      evidenceIds: theme.evidenceIds
    }));
  // Dùng đúng nhãn cuối của pipeline, cùng nguồn dữ liệu với công thức điểm.
  // Tránh UI đếm bằng keyword khác với số khuyết tật ở backend.
  const cons = countDefectThemes(included, product, enabled)
    .slice(0, MAX_SUMMARY_ITEMS)
    .map((theme) => contextualizeNegativeTheme(theme, product))
    .map((theme) => ({
      title: theme.title,
      detail: theme.description,
      mentions: theme.count,
      evidenceIds: theme.evidenceIds
    }));

  if (!pros.length) {
    const positiveCount = included.filter((review) => Number(review.rating) >= 4).length;
    pros.push({
      title: positiveCount ? 'Có phản hồi tích cực' : 'Chưa có ưu điểm nổi trội',
      detail: positiveCount
        ? 'Có phản hồi tích cực, nhưng chưa có một ưu điểm cụ thể được lặp lại đủ rõ.'
        : 'Dữ liệu hiện tại chưa cho thấy một ưu điểm được lặp lại rõ ràng.',
      mentions: positiveCount,
      evidenceIds: included.filter((review) => Number(review.rating) >= 4).map((review) => String(review.labelId || '')).filter(Boolean)
    });
  }
  if (!cons.length) {
    const lowRatingCount = included.filter((review) => Number(review.rating) <= 3).length;
    cons.push({
      title: lowRatingCount ? 'Có phản hồi cần cân nhắc' : 'Chưa thấy nhược điểm lặp lại',
      detail: lowRatingCount
        ? 'Có phản hồi chưa hài lòng, nhưng chưa có một vấn đề cụ thể được lặp lại đủ rõ.'
        : 'Không có nhược điểm cụ thể nào được nhiều review hữu ích cùng nhắc đến.',
      mentions: lowRatingCount,
      evidenceIds: included.filter((review) => Number(review.rating) <= 3).map((review) => String(review.labelId || '')).filter(Boolean)
    });
  }

  return { pros, cons };
}

export function trustTone(score) {
  if (!Number.isFinite(score)) return { id: 'neutral', label: 'Chưa đủ bằng chứng' };
  if (score >= 80) return { id: 'green', label: 'Mức tin cậy rất cao' };
  if (score >= 60) return { id: 'yellow', label: 'Mức tin cậy khá tốt' };
  if (score >= 50) return { id: 'orange', label: 'Mức tin cậy trung bình' };
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

function coverageNotice(method) {
  if (!method || method.scoreStatus === 'insufficient') return '';
  if (method.sample.afterSeedingRemoval === 0) {
    return 'Mẫu hiện chưa có review đủ điều kiện làm bằng chứng để nhận định ưu, nhược điểm sản phẩm.';
  }
  if (method.scoreStatus === 'limited' || method.scoreStatus === 'provisional') {
    return 'Độ phủ bằng chứng còn hạn chế. Hãy đọc kết quả như nhận định tạm thời trên phần review đã thu thập.';
  }
  return '';
}

function withCoverageNotice(summary, method) {
  const notice = coverageNotice(method);
  return notice && !summary.includes(notice) ? `${summary} ${notice}` : summary;
}

export function plainTrustSummary(score, scoreStatus = 'valid') {
  if (!Number.isFinite(score) || scoreStatus === 'insufficient') {
    return 'Chưa có đủ review có nội dung chữ để đạt ngưỡng tối thiểu 20 review và công bố TrustScore.';
  }
  const meaning = score >= 80
    ? 'Tập review có độ tin cậy cao, bạn có thể dùng kết quả này làm cơ sở cân nhắc sản phẩm.'
    : score >= 60
      ? 'Tập review khá đáng tin, bạn có thể tham khảo để cân nhắc sản phẩm nhưng nên đọc kỹ các điểm chưa đồng nhất.'
      : score >= 50
        ? 'Tập review có độ tin cậy trung bình, hãy xem đây là nguồn tham khảo và kiểm tra kỹ các review liên quan trước khi quyết định.'
        : 'Tập review có độ tin cậy thấp, bạn chưa nên dựa chủ yếu vào kết quả này để quyết định mua.';
  return `${meaning} Điểm ${score}/100 được tổng hợp từ độ rõ ràng của nội dung, mức độ ít nhiễu, tỷ lệ review có kết quả kiểm định và độ phủ của mẫu. TrustScore chỉ cho biết tập review đáng tin đến đâu, không phải điểm chất lượng tuyệt đối của sản phẩm.`;
}

function componentImpact(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return 'neutral';
  // This threshold only controls the explanation shown to users. It does not
  // participate in the TrustScore calculation. A component below the public
  // high-trust band is presented as something currently limiting the score.
  if (value >= 80) return 'up';
  if (value < 80) return 'down';
  return 'neutral';
}

function percentageLabel(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'chưa xác định';
  const rounded = Math.round(number * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : String(rounded).replace('.', ',')}%`;
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
  const analysisProduct = productWithResolvedDomain(options.product, reviews);
  const { pros, cons } = fallbackCopy(reviews, included, excluded, analysisProduct);
  const tone = trustTone(score);
  const mostFrequentDefect = [...method.defects.tests].sort((left, right) => right.count - left.count)[0];
  const controlledDefectSample = method.defects.status === 'standardized-controlled-sample';
  const excludedRate = reviews.length ? Math.round(excluded.length / reviews.length * 100) : 0;
  const coverageLowersScore = method.guardrails.applied.includes('sample-coverage');
  const authenticityImpact = componentImpact(method.components.authenticity.score);
  const textImpact = componentImpact(method.components.text.score);
  const labelingImpact = componentImpact(method.components.labeling.score);
  const authenticityPercentage = percentageLabel(method.components.authenticity.score);
  const textPercentage = percentageLabel(method.components.text.score);
  const labelingPercentage = percentageLabel(method.components.labeling.score);
  const coveragePercentage = percentageLabel(method.adequacy.coverage * 100);
  const textGapPercentage = percentageLabel(100 - method.components.text.score);
  const labelingGapPercentage = percentageLabel(100 - method.components.labeling.score);
  const drivers = [
    {
      impact: authenticityImpact,
      title: authenticityImpact === 'up'
        ? 'Phần lớn review vượt qua bước giảm nhiễu'
        : authenticityImpact === 'down'
          ? 'Tỷ lệ review vượt lọc nhiễu đang giới hạn điểm'
          : 'Mức ít nhiễu đang ở ngưỡng trung lập',
      detail: authenticityImpact === 'up'
        ? `Mức review vượt bước lọc nhiễu đạt ${authenticityPercentage}. Hệ thống đã loại nội dung quảng cáo, trùng lặp, không liên quan hoặc quá ít thông tin trước khi tổng hợp.`
        : authenticityImpact === 'down'
          ? `Mức review vượt bước lọc đạt ${authenticityPercentage}, chưa vào nhóm độ tin cậy cao. Có ${excludedRate}% review không được dùng làm bằng chứng vì quảng cáo, trùng lặp, không liên quan, quá mơ hồ hoặc ít thông tin. Đây là một lý do TrustScore chưa cao hơn.`
          : `Mức review vượt bước lọc nhiễu đạt ${authenticityPercentage}. Kết quả này hiện ở gần mốc trung lập nên không làm điểm thay đổi rõ rệt.`
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
          ? `${mostFrequentDefect.count} review đáng tham khảo cùng đề cập đến “${mostFrequentDefect.label.toLowerCase()}”. Vì mẫu được lấy gần đều theo mức sao, hệ thống cân bằng mức lỗi giữa các nhóm sao khi tổng hợp nhược điểm. Con số này không được diễn giải là tỷ lệ lỗi của toàn bộ sản phẩm và không tham gia TrustScore.`
          : `Trong ${method.sample.afterSeedingRemoval} review sau bước lọc nhiễu, chưa có một nhược điểm cụ thể được nhắc lặp lại rõ ràng. Với mẫu chia tầng, thuật toán so sánh cân bằng giữa các mức sao thay vì giả định đây là phân bố tự nhiên.`)
        : mostFrequentDefect?.count
          ? `${mostFrequentDefect.count} review đáng tham khảo cùng đề cập đến “${mostFrequentDefect.label.toLowerCase()}”. Đây là thông tin để người dùng cân nhắc về sản phẩm. Bản thân việc nêu lỗi rõ ràng không làm review kém đáng tin.`
          : `Trong ${method.sample.afterSeedingRemoval} review còn lại sau bước lọc nhiễu, chưa có một nhóm lỗi nào được người mua nhắc lại đủ rõ. Thống kê này không trực tiếp tăng hoặc giảm TrustScore.`
    },
    {
      impact: textImpact,
      title: textImpact === 'up' ? 'Nội dung review đủ rõ để đối chiếu' : textImpact === 'down' ? 'Độ rõ của review còn hạn chế' : 'Độ chi tiết đang ở ngưỡng trung lập',
      detail: textImpact === 'down'
        ? `Mức nội dung rõ và hữu ích đạt ${textPercentage}. Phần còn thiếu tương ứng ${textGapPercentage} cho thấy một số review chưa nêu trải nghiệm đủ cụ thể để đối chiếu. Đây là một lý do TrustScore chưa cao hơn.`
        : `Mức nội dung rõ và hữu ích đạt ${textPercentage}. Hệ thống xem review có nêu trải nghiệm cụ thể hay không và nội dung có đủ chi tiết để đối chiếu hay không. ${textImpact === 'up' ? 'Kết quả này đang củng cố TrustScore.' : 'Kết quả này hiện ở gần mốc trung lập.'}`
    },
    {
      impact: labelingImpact,
      title: labelingImpact === 'up' ? 'Phần lớn review đã có kết quả kiểm định' : labelingImpact === 'down' ? 'Nhiều review chưa kiểm định được' : 'Độ phủ kiểm định ở ngưỡng trung lập',
      detail: labelingImpact === 'up'
        ? `${labelingPercentage} review trong mẫu đã có kết quả từ bộ quy tắc hoặc lớp AI. Mức kiểm tra này đang nâng độ tin cậy của kết quả.`
        : labelingImpact === 'down'
          ? `${labelingPercentage} review trong mẫu đã có kết quả kiểm tra. Phần còn thiếu tương ứng ${labelingGapPercentage} không được dùng làm bằng chứng, vì vậy TrustScore chưa thể cao hơn.`
          : `${labelingPercentage} review trong mẫu đã có kết quả kiểm tra. Kết quả này hiện ở gần mốc trung lập.`
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
      impact: coverageLowersScore ? 'down' : method.adequacy.coverage >= 1 ? 'up' : 'neutral',
      title: coverageLowersScore ? 'Độ phủ mẫu chưa đạt mục tiêu' : method.scoreStatus === 'valid' ? 'Mẫu bằng chứng đạt mức sử dụng' : 'Mẫu bằng chứng còn hạn chế',
      detail: method.scoreStatus === 'valid' && !coverageLowersScore
        ? `Độ phủ mẫu đạt ${coveragePercentage} theo cách lấy review hiện tại. Mẫu đủ rộng nên không làm giảm TrustScore sau bước tổng hợp.`
        : method.scoreStatus === 'insufficient'
          ? `Mẫu hiện có ${method.sample.total}/20 review. Hệ thống chỉ không công bố TrustScore khi chưa đạt 20 review.`
          : coverageLowersScore
            ? `Độ phủ mẫu hiện là ${coveragePercentage}. Vì mẫu chưa đủ rộng, hệ thống đã giảm phần điểm cao hơn 50 để kết quả thận trọng hơn.`
            : `Độ phủ mẫu hiện là ${coveragePercentage}. TrustScore vẫn được công bố nhưng đi kèm trạng thái ${method.scoreStatus === 'limited' ? 'hạn chế' : 'tạm thời'}.`
    },
  ];

  return {
    score,
    label: tone.label,
    tone: tone.id,
    scoreStatus: method.scoreStatus,
    summary: withCoverageNotice(plainTrustSummary(score, method.scoreStatus), method),
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
      type: 'array', minItems: 1, maxItems: MAX_SUMMARY_ITEMS,
      items: { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string' }, mentions: { type: 'integer', minimum: 0 } }, required: ['title', 'detail', 'mentions'] }
    },
    cons: {
      type: 'array', minItems: 1, maxItems: MAX_SUMMARY_ITEMS,
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
  const leftTime = Date.parse(left.review.createdAt || '') || 0;
  const rightTime = Date.parse(right.review.createdAt || '') || 0;
  if (leftTime !== rightTime) return rightTime - leftTime;
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
    createdAt: review.createdAt || null,
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

export function buildGeminiNarrativePayload(reviews = [], fallback, options = {}) {
  const included = reviews.filter((review) => review.included !== false);
  const excluded = reviews.filter((review) => review.included === false);
  const method = fallback?.method || {};
  const narrativeProduct = productWithResolvedDomain(options.product, reviews);
  const domainResolution = resolveProductDomain(narrativeProduct);
  return {
    productContext: {
      title: String(narrativeProduct?.title || '').slice(0, 240),
      category: String(narrativeProduct?.category || '').slice(0, 120),
      categoryPath: Array.isArray(narrativeProduct?.categoryPath)
        ? narrativeProduct.categoryPath.map((item) => String(item).slice(0, 80)).slice(0, 8)
        : String(narrativeProduct?.categoryPath || '').slice(0, 240),
      marketplace: String(narrativeProduct?.marketplace || '').slice(0, 40),
      domain: domainResolution
    },
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
  const rawDetail = String(item.detail || fallback?.detail || '')
    .replace(/^\s*\d+\s+review\s+đáng tham khảo cùng đề cập\.?\s*/iu, '')
    .replace(/\s*Dẫn chứng\s*:[\s\S]*$/iu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const detail = rawDetail.length <= 190 ? rawDetail : `${rawDetail.slice(0, 187).replace(/\s+\S*$/u, '')}…`;
  return {
    // Chủ đề, số lượt và evidence đều do backend khóa. Gemini chỉ được phép
    // viết lại câu diễn giải của ưu điểm để tránh tạo chủ đề sai ngành hàng.
    title: String(fallback?.title || '').slice(0, 90),
    detail,
    mentions: Math.max(0, Math.round(Number(fallback?.mentions) || 0)),
    evidenceIds: Array.isArray(fallback?.evidenceIds) ? fallback.evidenceIds : []
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
  const pros = Array.isArray(value.pros) ? value.pros.slice(0, MAX_SUMMARY_ITEMS).map((item, index) => cleanItem(item, fallback.pros[index] || fallback.pros[0])) : fallback.pros;
  // Nhược điểm và dẫn chứng đã được backend tổng hợp từ nhãn cuối. Không cho
  // mô hình thay câu chữ vì có thể đưa ví dụ thuộc ngành hàng khác vào UI.
  const cons = fallback.cons;
  // Nhóm up/down/neutral phải phản ánh đúng các thành phần đã tính ở backend.
  // Gemini chỉ diễn giải ưu điểm, không được đổi kết luận hành động hoặc tác động điểm.
  const drivers = fallback.drivers;
  return {
    ...fallback,
    summary: fallback.summary,
    pros: pros.length ? pros : fallback.pros,
    cons: cons.length ? cons : fallback.cons,
    drivers: drivers.length ? drivers : fallback.drivers,
    engine: 'gemini'
  };
}

async function analyzeWithGemini(reviews, fallback, options = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = 'gemini-3.5-flash-lite';
  const narrativePayload = buildGeminiNarrativePayload(reviews, fallback, options);
  const prompt = [
    'Bạn là hệ thống kiểm định review thương mại điện tử của RealView.',
    'Backend đã xử lý review qua quy trình gắn nhãn và tính xong TrustScore. Một số review có thể chưa kiểm định được; dùng trạng thái trong dữ liệu, không mặc định mọi review đều đã qua đủ hai lớp. Bạn chỉ viết lại phần diễn giải cho dễ hiểu.',
    'Viết phần diễn giải TrustScore bằng tiếng Việt cho người mua phổ thông. Tuyệt đối không chấm lại hoặc sửa điểm thống kê.',
    'Giữ nguyên thứ tự, chủ đề và số lượt mentions của từng pros/cons trong fixedBackendDraft; không thêm, bớt hoặc tự đếm lại.',
    'productContext cho biết sản phẩm đang phân tích. Không dùng ví dụ hoặc đặc tính của ngành hàng khác.',
    'fullSampleStatistics là số liệu chính xác của toàn bộ mẫu. Luôn dùng các tổng số này khi nói về số lượng hoặc tỷ lệ.',
    'representativeEvidence chỉ là các ví dụ minh họa được chọn từ toàn bộ mẫu. Không suy ra số lượt đề cập hoặc tỷ lệ từ tập ví dụ này.',
    'Chỉ dùng dữ liệu được cung cấp; không suy đoán đặc tính sản phẩm hoặc bịa số lượt đề cập.',
    'Review included=false đã bị giảm ưu tiên: dùng chúng để đánh giá chất lượng dữ liệu, không dùng làm bằng chứng ưu/nhược điểm sản phẩm.',
    'Điểm đã được backend tính bằng thuật toán RealView v4.2: ba thành phần chất lượng bằng chứng, mức ít nhiễu và độ phủ kiểm định tạo điểm chất lượng cơ sở; độ phủ mẫu chỉ điều chỉnh bảo thủ phần điểm trên 50 đúng một lần. Nhược điểm sản phẩm không trực tiếp làm giảm TrustScore.',
    'Nội dung hiển thị cho người dùng tuyệt đối không được nhắc Fisher, p-value, odds ratio, binomial, logistic, Bonferroni, guardrail, điểm thành phần hoặc công thức.',
    'Summary đã được backend khóa trong fixedBackendDraft; phải chép nguyên văn, không viết lại.',
    'Mỗi ưu/nhược điểm chỉ viết một câu ngắn, cụ thể: người mua thích hoặc chưa hài lòng điều gì và ảnh hưởng thực tế ra sao. Không lặp số lượt review, không thêm câu “cùng đề cập” và không chèn dẫn chứng vì giao diện đã liên kết trực tiếp tới review nguồn.',
    'Danh sách drivers trong fixedBackendDraft đã được backend xác định và sẽ được giữ nguyên; không đổi impact, thứ tự, tiêu đề hoặc nội dung của các driver.',
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
  // Không có bằng chứng thì không có ưu/nhược điểm để AI diễn giải. Vẫn trả
  // điểm và kết luận minh bạch của backend, tránh suy diễn lẫn tốn quota.
  if (fallback.method.sample.afterSeedingRemoval === 0) {
    return { ...fallback, narrativeSkippedReason: 'no-eligible-evidence' };
  }
  try {
    const analyzed = await analyzeWithGemini(reviews, fallback, {
      fetchImpl: options.fetchImpl || fetch,
      geminiContext: options.geminiContext,
      signal: options.signal,
      product: options.product
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
