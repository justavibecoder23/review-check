const ALPHA_FAMILY = 0.01;
const FISHER_ALPHA = 0.025;

export const ISSUE_DEFINITIONS = [
  { id: 'chat-lieu', label: 'Chất liệu / độ bền', severity: 1.5, words: ['vai mong', 'mong', 'xu', 'bong', 'rach', 'son', 'mui', 'cung', 'tho', 'nhao', 'kem chat luong', 'de hong'] },
  { id: 'kich-co', label: 'Kích cỡ / form dáng', severity: 1, words: ['form nho', 'chat', 'rong', 'ngan', 'be', 'size nho', 'size lon', 'khong dung size', 'lech size'] },
  { id: 'dung-mo-ta', label: 'Khác mô tả / hình ảnh', severity: 1.2, words: ['khac hinh', 'khong giong', 'khac mo ta', 'sai mau', 'mau khac', 'giao thieu', 'khong dung mau', 'khong dung mo ta', 'loi'] },
  { id: 'giao-hang', label: 'Giao hàng / đóng gói', severity: 0.5, words: ['giao cham', 'giao lau', 'mop', 'be', 'vo', 'dong goi so sai', 'giao thieu', 'tre'] },
  { id: 'su-dung', label: 'Trải nghiệm sử dụng', severity: 1.5, words: ['khong dung duoc', 'khong hoat dong', 'khong ben', 'nong', 'bi', 'kho chiu', 'ro', 'het pin', 'yeu'] }
];

const SEEDING_PATTERNS = [
  /nhan\s*(xu|diem|coin)/,
  /(review|danh gia)\s*(lay|de nhan)/,
  /cho\s*(shop|san pham)?\s*5\s*sao/,
  /san\s*sale|ma\s*giam\s*gia|tich\s*xu/,
  /chua\s*(dung|su dung|trai nghiem|mo)/,
  /giao hang nhanh.*dong goi.*(tot|ky)/,
  /hang dep.{0,20}(5 sao|ung ho)/
];

const VAGUE_PATTERNS = [
  /^ok+[.! ]*$/,
  /^tot+[.! ]*$/,
  /^dep+[.! ]*$/,
  /^te+[.! ]*$/,
  /^that vong[.! ]*$/,
  /^(khong tot|qua te|rat te)[.! ]*$/
];

// Các p0 dưới đây được chép từ ví dụ trong tài liệu v3.1. Chúng chỉ là
// mốc minh họa; chỉ cấu hình đã hiệu chuẩn mới được dùng để đưa ra kết luận.
export const ILLUSTRATIVE_BASELINES = {
  fashion: { 'kich-co': 0.03, 'chat-lieu': 0.02, 'giao-hang': 0.04 },
  electronics: { 'su-dung': 0.015, 'giao-hang': 0.04 },
  beauty: { 'dung-mo-ta': 0.025, 'giao-hang': 0.04 },
  general: { 'giao-hang': 0.04 }
};

export function fold(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function clamp(value, minimum = 0, maximum = 100) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

function ratio(part, whole) {
  return whole > 0 ? part / whole : 0;
}

export function findReviewIssues(text = '') {
  const normalized = fold(text);
  return ISSUE_DEFINITIONS.filter((issue) => issue.words.some((word) => normalized.includes(word)));
}

export function classifyReviewSignals(review = {}) {
  const text = fold(review.text);
  if (review.labels && typeof review.labels === 'object') {
    const categoryIds = Array.isArray(review.labels.defect_categories) ? review.labels.defect_categories : [];
    const issues = ISSUE_DEFINITIONS.filter((issue) => categoryIds.includes(issue.id));
    return {
      text,
      issues,
      seeding: Boolean(review.labels.is_seeding),
      vague: Boolean(review.labels.is_vague),
      lowValue: Boolean(review.labels.is_low_value),
      source: review.labels.reviewed_by || 'two-layer-labeler'
    };
  }
  const issues = findReviewIssues(text);
  const seeding = SEEDING_PATTERNS.some((pattern) => pattern.test(text))
    || /seeding|nhan xu/i.test(String(review.exclusionReason || ''));
  const vague = Number(review.rating) <= 2
    && issues.length === 0
    && (text.length < 35 || VAGUE_PATTERNS.some((pattern) => pattern.test(text)));
  return { text, issues, seeding, vague, lowValue: false, source: 'legacy-rules' };
}

function logFactorials(n) {
  const values = new Array(n + 1).fill(0);
  for (let index = 2; index <= n; index += 1) values[index] = values[index - 1] + Math.log(index);
  return values;
}

function logChoose(n, k, factorials) {
  if (k < 0 || k > n) return Number.NEGATIVE_INFINITY;
  return factorials[n] - factorials[k] - factorials[n - k];
}

function expSum(logValues) {
  if (!logValues.length) return 0;
  const maximum = Math.max(...logValues);
  return Math.exp(maximum) * logValues.reduce((sum, value) => sum + Math.exp(value - maximum), 0);
}

export function exactBinomialSurvival(n, k, p0) {
  const sample = Math.max(0, Math.trunc(n));
  const observed = Math.max(0, Math.trunc(k));
  const probability = Number(p0);
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) return null;
  if (observed <= 0) return 1;
  if (observed > sample || probability === 0) return 0;
  if (probability === 1) return 1;
  const factorials = logFactorials(sample);
  const logs = [];
  for (let count = observed; count <= sample; count += 1) {
    logs.push(logChoose(sample, count, factorials)
      + count * Math.log(probability)
      + (sample - count) * Math.log1p(-probability));
  }
  return clamp(expSum(logs), 0, 1);
}

export function fisherExactTwoSided(table) {
  const [a, b, c, d] = [table.a, table.b, table.c, table.d].map((value) => Math.max(0, Math.trunc(Number(value) || 0)));
  const rowOne = a + b;
  const rowTwo = c + d;
  const columnOne = a + c;
  const total = rowOne + rowTwo;
  if (!total) return 1;
  const factorials = logFactorials(total);
  const lower = Math.max(0, columnOne - rowTwo);
  const upper = Math.min(rowOne, columnOne);
  const logProbability = (cellA) => logChoose(rowOne, cellA, factorials)
    + logChoose(rowTwo, columnOne - cellA, factorials)
    - logChoose(total, columnOne, factorials);
  const observedLog = logProbability(a);
  const included = [];
  for (let cellA = lower; cellA <= upper; cellA += 1) {
    const current = logProbability(cellA);
    if (current <= observedLog + 1e-12) included.push(current);
  }
  return clamp(expSum(included), 0, 1);
}

export function correctedOddsRatio({ a, b, c, d }) {
  return ((a + 0.5) * (d + 0.5)) / ((b + 0.5) * (c + 0.5));
}

export function holmAdjust(items, alpha = ALPHA_FAMILY) {
  const valid = items.filter((item) => Number.isFinite(item.pValue));
  const sorted = [...valid].sort((left, right) => left.pValue - right.pValue);
  let running = 0;
  const adjusted = new Map();
  sorted.forEach((item, index) => {
    running = Math.max(running, (sorted.length - index) * item.pValue);
    adjusted.set(item.id, Math.min(1, running));
  });
  return items.map((item) => ({
    ...item,
    adjustedPValue: adjusted.get(item.id) ?? null,
    significantHolm: (adjusted.get(item.id) ?? 1) <= alpha
  }));
}

export function scoreNegativeReview(review) {
  if (Number(review.rating) > 2) return null;
  const signals = classifyReviewSignals(review);
  const lengthSignal = Math.log(signals.text.length + 1);
  const logistic = 100 / (1 + Math.exp(-1.5 * (lengthSignal - Math.log(36))));
  return clamp(logistic * (1 + 0.5 * Number(signals.issues.length > 0)) * (1 - 0.7 * Number(signals.vague)));
}

function inferCategory(product = {}) {
  const descriptor = fold(`${product.category || ''} ${product.title || ''}`);
  if (/dien thoai|camera|pin|sac|cap|tai nghe|may|dien tu|iphone|android/.test(descriptor)) return 'electronics';
  if (/my pham|kem|serum|son|duong|sua rua mat|lam dep/.test(descriptor)) return 'beauty';
  if (/(^|\s)(ao|quan|vay|giay|dep|tui|non)(\s|$)|size|thoi trang/.test(descriptor)) return 'fashion';
  return 'general';
}

function parseReviewDate(value) {
  const text = String(value || '').trim();
  const vietnamese = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (vietnamese) {
    const time = Date.UTC(Number(vietnamese[3]), Number(vietnamese[2]) - 1, Number(vietnamese[1]));
    return Number.isFinite(time) ? time : null;
  }
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : null;
}

function temporalScore(reviews) {
  const dates = reviews.map((review) => parseReviewDate(review.date)).filter(Number.isFinite).sort((a, b) => a - b);
  const coverage = ratio(dates.length, reviews.length);
  if (dates.length < 5) return { score: 70, coverage, maxWindowShare: null, status: 'limited' };
  let maximumSevenDayCount = 1;
  let left = 0;
  for (let right = 0; right < dates.length; right += 1) {
    while (dates[right] - dates[left] > 7 * 24 * 60 * 60 * 1000) left += 1;
    maximumSevenDayCount = Math.max(maximumSevenDayCount, right - left + 1);
  }
  const maxWindowShare = ratio(maximumSevenDayCount, dates.length);
  const burstPenalty = clamp((maxWindowShare - 0.55) / 0.45, 0, 1);
  const observedScore = 100 * (1 - burstPenalty);
  return {
    score: clamp(70 * (1 - coverage) + observedScore * coverage),
    coverage,
    maxWindowShare,
    status: coverage >= 0.7 ? 'available' : 'limited'
  };
}

function isExplicitlyIncluded(review) {
  return review?.included !== false;
}

function samplingPolicy(sampling = {}) {
  const stratifiedByRating = sampling?.strategy === 'parallel-star-filters';
  return {
    strategy: sampling?.strategy || 'unknown',
    stratifiedByRating,
    distributionMode: stratifiedByRating ? 'excluded-controlled-sample' : 'observed-sample',
    defectMode: stratifiedByRating ? 'standardized-controlled-sample' : 'observed-sample',
    populationInferenceEnabled: !stratifiedByRating
  };
}

function statisticalSamples(reviews) {
  const annotated = reviews.map((review, index) => ({ review, index, signal: classifyReviewSignals(review) }));
  const evidence = annotated.filter(({ review, signal }) => isExplicitlyIncluded(review) && !signal.seeding);
  // Fisher cần giữ lại review nghi seeding/vague để phát hiện quan hệ bất thường.
  // Off-topic và low-value thuần túy không được phép tác động vào thống kê.
  const audit = annotated.filter(({ review, signal }) => {
    if (signal.source === 'legacy-rules' && review?.included === undefined) return true;
    if (review?.labels?.is_off_topic || review?.labels?.relevance === 'off_topic') return false;
    return isExplicitlyIncluded(review) || signal.seeding || signal.vague;
  });
  return { evidence, audit };
}

function reviewDefectSeverity(signal) {
  return signal.issues.reduce((sum, issue) => sum + issue.severity, 0);
}

function defectPenaltyForSample(evidence, policy) {
  if (!evidence.length) return 0;
  if (!policy.stratifiedByRating) {
    return evidence.reduce((sum, { signal }) => sum + reviewDefectSeverity(signal), 0) / evidence.length;
  }
  const strata = new Map();
  for (const entry of evidence) {
    const rating = Number(entry.review.rating);
    if (rating < 1 || rating > 5) continue;
    if (!strata.has(rating)) strata.set(rating, []);
    strata.get(rating).push(entry);
  }
  if (!strata.size) return 0;
  const perStratum = [...strata.values()].map((entries) => (
    entries.reduce((sum, { signal }) => sum + reviewDefectSeverity(signal), 0) / entries.length
  ));
  return perStratum.reduce((sum, value) => sum + value, 0) / perStratum.length;
}

function componentScores(distributionReviews, distributionSignals, evidence, defectPenalty, policy) {
  const seedingRate = ratio(distributionSignals.filter((item) => item.seeding).length, distributionReviews.length);
  const fiveStarRate = ratio(distributionReviews.filter((review) => Number(review.rating) === 5).length, distributionReviews.length);
  const oneStarRate = ratio(distributionReviews.filter((review) => Number(review.rating) === 1).length, distributionReviews.length);
  const saturationPenalty = clamp((fiveStarRate - 0.85) / 0.15, 0, 1);
  const attackPenalty = clamp((oneStarRate - 0.5) / 0.5, 0, 1);
  // Năm Apify run chủ động lấy gần bằng nhau ở từng mức sao. Phân bố đó là
  // thiết kế lấy mẫu, không phải phân bố rating tự nhiên của sản phẩm.
  const distribution = policy.stratifiedByRating
    ? null
    : clamp(100 * (1 - 0.5 * seedingRate - 0.3 * saturationPenalty - 0.2 * attackPenalty));

  const textValues = evidence.map(({ review, signal }) => {
    const detail = clamp(signal.text.length / 120, 0, 1);
    const specificity = Number(signal.issues.length > 0 || signal.text.length >= 60);
    const verified = Number(Boolean(review.verified));
    const base = 100 * (0.45 * detail + 0.35 * specificity + 0.2 * verified);
    const negative = scoreNegativeReview(review);
    return negative === null ? base : 0.6 * base + 0.4 * negative;
  });
  const text = textValues.length ? textValues.reduce((sum, value) => sum + value, 0) / textValues.length : 0;
  const observedDefect = clamp(100 * (1 - 2.5 * defectPenalty));
  return {
    distribution,
    distributionStatus: policy.distributionMode,
    text,
    defect: observedDefect,
    defectStatus: policy.defectMode,
    observedDefect
  };
}

function fisherComponent(signals, reviews) {
  const build = (predicateRow, predicateColumn) => {
    const table = { a: 0, b: 0, c: 0, d: 0 };
    reviews.forEach((review, index) => {
      const row = predicateRow(signals[index], review);
      const column = predicateColumn(signals[index], review);
      if (row && column) table.a += 1;
      else if (row) table.b += 1;
      else if (column) table.c += 1;
      else table.d += 1;
    });
    const pValue = fisherExactTwoSided(table);
    const oddsRatio = correctedOddsRatio(table);
    const penalty = pValue < FISHER_ALPHA ? Math.min(3, Math.max(0, Math.log(oddsRatio))) : 0;
    return { table, pValue, oddsRatio, significant: pValue < FISHER_ALPHA, penalty };
  };
  const positive = build((signal) => signal.seeding, (_signal, review) => Number(review.rating) === 5);
  const negative = build((signal) => signal.vague, (_signal, review) => Number(review.rating) === 1);
  const seedingRate = ratio(signals.filter((signal) => signal.seeding).length, reviews.length);
  // Theo v3.1, khi không phát hiện liên hệ bất thường thì nhánh Fisher giữ
  // 100 điểm; penalty chỉ được kích hoạt khi p-value vượt ngưỡng quyết định.
  const positiveScore = 100 * (1 - seedingRate) / (1 + positive.penalty);
  const negativeScore = 100 / (1 + negative.penalty);
  return {
    score: clamp(0.6 * positiveScore + 0.4 * negativeScore),
    positive: { ...positive, score: positiveScore },
    negative: { ...negative, score: negativeScore },
    seedingRate
  };
}

function resolveBaselines(options, category) {
  const configured = options.baselines && typeof options.baselines === 'object' ? options.baselines : null;
  const values = configured?.values?.[category] || configured?.values?.general || ILLUSTRATIVE_BASELINES[category] || ILLUSTRATIVE_BASELINES.general;
  return { values, calibrated: Boolean(configured?.calibrated), source: configured?.source || 'Ví dụ minh họa trong tài liệu v3.1' };
}

export function combineTrustComponents(componentScores, options = {}) {
  const distributionActive = componentScores.distribution !== null && componentScores.distribution !== undefined;
  const weighted = {
    distribution: {
      score: clamp(componentScores.distribution),
      weight: 0.15,
      active: distributionActive,
      label: 'Phân bố rating',
      status: componentScores.distributionStatus || 'observed-distribution'
    },
    text: { score: clamp(componentScores.text), weight: 0.20, active: true, label: 'Chất lượng nội dung' },
    fisher: { score: clamp(componentScores.fisher), weight: 0.20, active: true, label: 'Fisher 2×2' },
    defect: {
      score: clamp(componentScores.defect),
      weight: 0.30,
      active: true,
      label: 'Rủi ro khuyết tật',
      status: componentScores.defectStatus || 'observed-prevalence'
    },
    temporal: { score: clamp(componentScores.temporal), weight: 0.15, active: true, label: 'Tính ổn định thời gian' }
  };
  const activeWeight = Object.values(weighted).reduce((sum, component) => sum + (component.active ? component.weight : 0), 0);
  const rawScore = activeWeight
    ? Object.values(weighted).reduce((sum, component) => sum + (component.active ? component.score * component.weight : 0), 0) / activeWeight
    : 0;
  const caps = {
    fisher: weighted.fisher.score < 40 ? 55 : 100,
    defect: weighted.defect.score < 25 ? 39 : 100,
    high: weighted.fisher.score < 60 || weighted.defect.score < 60 ? 79 : 100
  };
  const applied = Object.entries(caps).filter(([, value]) => value < 100).map(([id, value]) => ({ id, value }));
  return {
    score: Math.round(Math.min(rawScore, caps.fisher, caps.defect, caps.high)),
    rawScore,
    components: weighted,
    caps: { ...caps, applied }
  };
}

export function calculateTrustScoreV31(reviews = [], options = {}) {
  const normalizedReviews = Array.isArray(reviews) ? reviews : [];
  const policy = samplingPolicy(options.sampling);
  const samples = statisticalSamples(normalizedReviews);
  const evidenceReviews = samples.evidence.map(({ review }) => review);
  const auditReviews = samples.audit.map(({ review }) => review);
  const auditSignals = samples.audit.map(({ signal }) => signal);
  const explicitCategory = fold(options.category);
  const category = ['fashion', 'electronics', 'beauty', 'general'].includes(explicitCategory)
    ? explicitCategory
    : inferCategory({ ...options.product, category: options.category || options.product?.category });
  const baseline = resolveBaselines(options, category);
  const issueCounts = ISSUE_DEFINITIONS.map((issue) => ({
    ...issue,
    count: samples.evidence.filter(({ signal }) => signal.issues.some((match) => match.id === issue.id)).length
  }));
  const defectPenalty = defectPenaltyForSample(samples.evidence, policy);
  const defectTests = issueCounts.map((issue) => {
    const p0 = Number(baseline.values?.[issue.id]);
    const hasBaseline = Number.isFinite(p0) && p0 >= 0 && p0 <= 1;
    const pValue = hasBaseline && policy.populationInferenceEnabled
      ? exactBinomialSurvival(evidenceReviews.length, issue.count, p0)
      : null;
    return {
      id: issue.id,
      label: issue.label,
      count: issue.count,
      severity: issue.severity,
      p0: hasBaseline ? p0 : null,
      pValue,
      significantBonferroni: pValue !== null && pValue <= ALPHA_FAMILY / ISSUE_DEFINITIONS.length,
      decisionEnabled: baseline.calibrated && hasBaseline && policy.populationInferenceEnabled
    };
  });
  const completeDefectFamily = defectTests.every((item) => Number.isFinite(item.pValue));
  const defects = (completeDefectFamily
    ? holmAdjust(defectTests)
    : defectTests.map((item) => ({ ...item, adjustedPValue: null, significantHolm: false })))
    .map((item) => ({
      ...item,
      multipleTestingMethod: completeDefectFamily ? 'holm-bonferroni' : 'bonferroni-fixed',
      significantAdjusted: completeDefectFamily ? item.significantHolm : item.significantBonferroni
    }));

  const fisher = fisherComponent(auditSignals, auditReviews);
  const components = componentScores(auditReviews, auditSignals, samples.evidence, defectPenalty, policy);
  const temporal = temporalScore(evidenceReviews);
  const combined = combineTrustComponents({
    distribution: components.distribution,
    distributionStatus: components.distributionStatus,
    text: components.text,
    fisher: fisher.score,
    defect: components.defect,
    defectStatus: components.defectStatus,
    temporal: temporal.score
  });
  const dateCoverage = temporal.coverage;
  const baselineCoverage = policy.populationInferenceEnabled
    ? ratio(defects.filter((item) => item.p0 !== null).length, defects.length)
    : 0;
  const adequacyScore = Math.round(100 * (
    0.75 * Math.min(1, evidenceReviews.length / 100)
    + 0.15 * dateCoverage
    + 0.10 * baselineCoverage
  ));

  return {
    version: '3.1',
    score: combined.score,
    rawScore: combined.rawScore,
    components: combined.components,
    caps: combined.caps,
    sample: {
      total: normalizedReviews.length,
      statisticalPopulation: auditReviews.length,
      afterSeedingRemoval: evidenceReviews.length,
      rejectedFromEvidence: normalizedReviews.length - evidenceReviews.length,
      seedingCount: normalizedReviews.filter((review) => classifyReviewSignals(review).seeding).length
    },
    sampling: {
      strategy: policy.strategy,
      controlledStarStrata: policy.stratifiedByRating,
      distributionMode: policy.distributionMode,
      defectMode: policy.defectMode,
      populationInferenceEnabled: policy.populationInferenceEnabled,
      perStarLimit: Number(options.sampling?.perStarLimit) || null
    },
    adequacy: {
      score: adequacyScore,
      label: adequacyScore >= 80 ? 'Tốt' : adequacyScore >= 55 ? 'Khá' : 'Hạn chế',
      targetSample: 100,
      dateCoverage
    },
    fisher,
    defects: {
      score: components.defect,
      observedScore: components.observedDefect,
      status: components.defectStatus,
      penalty: defectPenalty,
      tests: defects,
      alphaFamily: ALPHA_FAMILY,
      bonferroniAlpha: ALPHA_FAMILY / ISSUE_DEFINITIONS.length,
      familyComplete: completeDefectFamily,
      multipleTestingMethod: completeDefectFamily ? 'holm-bonferroni' : 'bonferroni-fixed',
      baseline: { category, calibrated: baseline.calibrated, source: baseline.source }
    },
    temporal,
    negativeReviewScores: samples.evidence
      .map(({ review, index }) => ({ index, score: scoreNegativeReview(review) }))
      .filter((item) => item.score !== null),
    notes: [
      'Fisher exact dùng số đếm nguyên gốc; hiệu chỉnh +0,5 chỉ dùng để ổn định odds ratio.',
      baseline.calibrated && policy.populationInferenceEnabled
        ? `Kiểm định khuyết tật dùng baseline đã hiệu chuẩn: ${baseline.source}.`
        : policy.populationInferenceEnabled
          ? 'Các p0 mặc định chỉ là ví dụ từ tài liệu; p-value khuyết tật chỉ để tham khảo cho tới khi baseline được hiệu chuẩn.'
          : 'Không chạy suy luận tỷ lệ khuyết tật theo p0 vì dữ liệu được chủ động chia tầng theo mức sao.',
      evidenceReviews.length < 100
        ? `Mẫu bằng chứng có ${evidenceReviews.length}/100 review mục tiêu; cần đọc kết quả với mức thận trọng cao hơn.`
        : 'Mẫu đạt ngưỡng thiết kế 100 review.',
      policy.stratifiedByRating
        ? 'Mẫu được cân bằng theo mức sao: thành phần phân bố rating được loại khỏi phép cộng và các trọng số còn lại được chuẩn hóa. Nhược điểm được tính cân bằng giữa các tầng sao, không diễn giải là tỷ lệ của toàn bộ sản phẩm.'
        : 'Tỷ lệ nhược điểm được quan sát trên mẫu không chia tầng theo mức sao.'
    ]
  };
}
