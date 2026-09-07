import { isWrittenReview, MINIMUM_REVIEWS_FOR_ANALYSIS } from './analysis-eligibility.mjs';

const ALPHA_FAMILY = 0.01;
const FISHER_ALPHA = 0.025;
const DEFAULT_RATING_STRATA = Object.freeze([1, 2, 3, 4, 5]);
const MINIMUM_RAW_REVIEWS = MINIMUM_REVIEWS_FOR_ANALYSIS;
const DEFAULT_PER_STRATUM_TARGET = 20;
const MAX_PER_STRATUM_TARGET = 100;
const UNSTRATIFIED_TARGET_SAMPLE = 60;
const MIN_STRATUM_FILL_FOR_VALID_STATUS = 0.5;

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
  const sourceReview = review && typeof review === 'object' ? review : {};
  const text = fold(sourceReview.text);
  if (sourceReview.labels && typeof sourceReview.labels === 'object') {
    const categoryIds = sourceReview.labels.has_defect === false
      ? []
      : Array.isArray(sourceReview.labels.defect_categories) ? sourceReview.labels.defect_categories : [];
    const issues = ISSUE_DEFINITIONS.filter((issue) => categoryIds.includes(issue.id));
    return {
      text,
      issues,
      seeding: Boolean(sourceReview.labels.is_seeding),
      vague: Boolean(sourceReview.labels.is_vague),
      lowValue: Boolean(sourceReview.labels.is_low_value),
      offTopic: Boolean(sourceReview.labels.is_off_topic || sourceReview.labels.relevance === 'off_topic'),
      duplicate: Boolean(sourceReview.labels.is_duplicate),
      informationValue: String(sourceReview.labels.information_value || '').toLowerCase(),
      source: sourceReview.labels.reviewed_by || 'two-layer-labeler'
    };
  }
  const issues = findReviewIssues(text);
  const seeding = SEEDING_PATTERNS.some((pattern) => pattern.test(text))
    || /seeding|nhan xu/i.test(String(sourceReview.exclusionReason || ''));
  const vague = Number(sourceReview.rating) <= 2
    && issues.length === 0
    && (text.length < 35 || VAGUE_PATTERNS.some((pattern) => pattern.test(text)));
  return { text, issues, seeding, vague, lowValue: false, offTopic: false, duplicate: false, informationValue: '', source: 'legacy-rules' };
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
  const rating = Number(review.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 2) return null;
  const signals = classifyReviewSignals(review);
  const lengthSignal = Math.log(signals.text.length + 1);
  const logistic = 100 / (1 + Math.exp(-1.5 * (lengthSignal - Math.log(36))));
  return clamp(logistic * (1 + 0.5 * Number(signals.issues.length > 0)) * (1 - 0.7 * Number(signals.vague)));
}

function inferCategory(product = {}) {
  const descriptor = fold(`${product.category || ''} ${product.title || ''}`);
  if (/dien thoai|camera|pin|sac|cap|tai nghe|may|dien tu|iphone|android/.test(descriptor)) return 'electronics';
  if (/my pham|kem|serum|son|duong|sua rua mat|lam dep/.test(descriptor)) return 'beauty';
  if (/(^|\s)(ao|quan|vay|giay|tui|non)(\s|$)|doi dep|dep quai|dep sandal|giay dep|size|thoi trang/.test(descriptor)) return 'fashion';
  return 'general';
}

function parseReviewDate(value) {
  const text = String(value || '').trim();
  const vietnamese = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (vietnamese) {
    const day = Number(vietnamese[1]);
    const month = Number(vietnamese[2]);
    const year = Number(vietnamese[3]);
    const time = Date.UTC(year, month - 1, day);
    const parsed = new Date(time);
    return parsed.getUTCFullYear() === year
      && parsed.getUTCMonth() === month - 1
      && parsed.getUTCDate() === day
      ? time
      : null;
  }
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : null;
}

function temporalScore(reviews) {
  const dates = reviews.map((review) => parseReviewDate(review.date)).filter(Number.isFinite).sort((a, b) => a - b);
  const coverage = ratio(dates.length, reviews.length);
  if (dates.length < 5) return { score: null, coverage, maxWindowShare: null, status: 'unavailable' };
  let maximumSevenDayCount = 1;
  let left = 0;
  for (let right = 0; right < dates.length; right += 1) {
    while (dates[right] - dates[left] > 7 * 24 * 60 * 60 * 1000) left += 1;
    maximumSevenDayCount = Math.max(maximumSevenDayCount, right - left + 1);
  }
  const maxWindowShare = ratio(maximumSevenDayCount, dates.length);
  const burstPenalty = clamp((maxWindowShare - 0.55) / 0.45, 0, 1);
  const observedScore = clamp(100 * (1 - burstPenalty));
  return {
    score: coverage >= 0.7 ? observedScore : null,
    coverage,
    maxWindowShare,
    status: coverage >= 0.7 ? 'available' : 'limited'
  };
}

function isExplicitlyIncluded(review) {
  return review?.included !== false;
}

function isEvidenceEntry({ review, signal }) {
  return isExplicitlyIncluded(review)
    && !review?.labels?.hard_reject
    && !review?.labeling?.layer1?.hard_reject
    && !signal.seeding
    && !signal.vague
    && !(signal.lowValue && !signal.issues.length)
    && !signal.offTopic
    && !signal.duplicate
    && !review?.labels?.layer2_unavailable;
}

function samplingPolicy(sampling = {}) {
  const stratifiedByRating = sampling?.strategy === 'parallel-star-filters';
  const randomized = sampling?.randomized === true;
  const configuredStrata = Array.isArray(sampling?.ratingStrata)
    ? [...new Set(sampling.ratingStrata.map(Number)
      .filter((rating) => Number.isInteger(rating) && rating >= 1 && rating <= 5))].sort((a, b) => a - b)
    : [];
  const ratingStrata = stratifiedByRating && configuredStrata.length
    ? configuredStrata
    : [...DEFAULT_RATING_STRATA];
  const configuredPerStratumTarget = Math.trunc(Number(sampling?.perStarLimit));
  const perStratumTarget = Number.isFinite(configuredPerStratumTarget) && configuredPerStratumTarget > 0
    ? Math.min(configuredPerStratumTarget, MAX_PER_STRATUM_TARGET)
    : DEFAULT_PER_STRATUM_TARGET;
  return {
    strategy: sampling?.strategy || 'unknown',
    stratifiedByRating,
    distributionMode: stratifiedByRating ? 'excluded-controlled-sample' : 'observed-sample',
    defectMode: stratifiedByRating ? 'standardized-controlled-sample' : 'observed-sample',
    randomized,
    // Ngẫu nhiên bên trong từng tầng sao không khôi phục phân bố tự nhiên.
    // Chỉ mẫu ngẫu nhiên không chia tầng mới được phép suy luận tổng thể.
    populationInferenceEnabled: randomized && !stratifiedByRating,
    ratingStrata,
    standardRatings: ratingStrata,
    perStratumTarget
  };
}

function statisticalSamples(reviews, policy) {
  const annotated = reviews.map((review, index) => ({ review, index, signal: classifyReviewSignals(review) }));
  // Cả Shopee và TikTok đều dùng đủ 5 tầng 1★–5★ theo thiết kế chuẩn.
  const audit = policy.stratifiedByRating
    ? annotated.filter(({ review }) => policy.ratingStrata.includes(Number(review.rating)))
    : annotated;
  const evidence = audit.filter(isEvidenceEntry);
  return { annotated, evidence, audit, excludedByDesign: annotated.length - audit.length };
}

const MAX_ISSUE_SEVERITY = Math.max(...ISSUE_DEFINITIONS.map((issue) => issue.severity));

// Defect là thống kê nội dung để người dùng đọc ưu/nhược điểm, không phải thước
// đo review đáng tin hay không. Dùng mức nghiêm trọng cao nhất để không đếm
// chồng nhiều category có thể cùng mô tả một lỗi.
function reviewDefectBurden(signal) {
  const uniqueIssues = [...new Map(signal.issues.map((issue) => [issue.id, issue])).values()];
  return uniqueIssues.length
    ? clamp(Math.max(...uniqueIssues.map((issue) => issue.severity)) / MAX_ISSUE_SEVERITY, 0, 1)
    : 0;
}

function contributorKey(entry) {
  const authorId = String(entry?.review?.authorId || '').trim();
  return authorId ? `author:${authorId}` : `anonymous:${entry?.index}`;
}

function meanByContributor(entries, valueForEntry) {
  if (!entries.length) return 0;
  const groupedValues = new Map();
  for (const entry of entries) {
    const key = contributorKey(entry);
    if (!groupedValues.has(key)) groupedValues.set(key, []);
    groupedValues.get(key).push(valueForEntry(entry));
  }
  return mean([...groupedValues.values()].map((values) => mean(values)));
}

function meanDefectBurden(entries) {
  return meanByContributor(entries, ({ signal }) => reviewDefectBurden(signal));
}

function defectEstimateForSample(evidence, policy) {
  if (!evidence.length) {
    return { risk: null, method: 'no-evidence', strata: [], comparableAcrossPlatforms: false };
  }
  const pooledRisk = meanDefectBurden(evidence);
  if (!policy.stratifiedByRating) {
    return { risk: pooledRisk, method: 'observed-descriptive', strata: [], comparableAcrossPlatforms: false };
  }

  const strata = policy.ratingStrata.map((rating) => {
    const entries = evidence.filter((entry) => Number(entry.review.rating) === rating);
    if (!entries.length) return null;
    const observedRisk = meanDefectBurden(entries);
    return { rating, count: entries.length, observedRisk };
  }).filter(Boolean);
  const complete = strata.length === policy.ratingStrata.length;
  const risk = complete
    ? strata.reduce((sum, stratum) => sum + stratum.observedRisk, 0) / policy.ratingStrata.length
    : strata.length
      ? strata.reduce((sum, stratum) => sum + stratum.observedRisk, 0) / strata.length
      : pooledRisk;
  return {
    risk: clamp(risk, 0, 1),
    method: complete ? 'equal-anchor-ratings' : 'incomplete-anchor-ratings',
    strata,
    pooledRisk,
    standardRatings: policy.ratingStrata,
    comparableAcrossPlatforms: false,
    comparableUnderCommonDesign: complete
  };
}

function distinctContributorCount(entries) {
  const authors = new Set();
  let anonymous = 0;
  for (const { review } of entries) {
    const authorId = String(review?.authorId || '').trim();
    if (authorId) authors.add(authorId);
    else anonymous += 1;
  }
  return authors.size + anonymous;
}

function inferenceEligibility(audit, requested) {
  if (!requested) return { enabled: false, reason: 'sampling-design-not-eligible' };
  const authors = new Set();
  const reviewIds = new Set();
  for (const { review, signal } of audit) {
    if (signal.duplicate) return { enabled: false, reason: 'duplicate-observations' };
    const authorId = String(review?.authorId || '').trim();
    if (!authorId) return { enabled: false, reason: 'unknown-contributor-identity' };
    if (authors.has(authorId)) return { enabled: false, reason: 'repeated-contributor' };
    authors.add(authorId);
    const reviewId = String(review?.reviewId || review?.id || '').trim();
    if (reviewId) {
      if (reviewIds.has(reviewId)) return { enabled: false, reason: 'repeated-review-id' };
      reviewIds.add(reviewId);
    }
  }
  return { enabled: true, reason: null };
}

// Nếu cùng authorId xuất hiện ở nhiều tầng, tổng đóng góp của tài khoản đó vẫn
// chỉ bằng 1 và được chia đều cho các tầng đã xuất hiện. Cách này không phụ
// thuộc thứ tự đầu vào và tránh giả tăng cỡ mẫu qua nhiều mức sao.
function contributorCountsByRating(entries, ratings) {
  const ratingSet = new Set(ratings);
  const counts = new Map(ratings.map((rating) => [rating, 0]));
  const authorRatings = new Map();
  for (const { review } of entries) {
    const rating = Number(review?.rating);
    if (!ratingSet.has(rating)) continue;
    const authorId = String(review?.authorId || '').trim();
    if (!authorId) {
      counts.set(rating, counts.get(rating) + 1);
      continue;
    }
    if (!authorRatings.has(authorId)) authorRatings.set(authorId, new Set());
    authorRatings.get(authorId).add(rating);
  }
  for (const observedRatings of authorRatings.values()) {
    const contribution = 1 / observedRatings.size;
    for (const rating of observedRatings) counts.set(rating, counts.get(rating) + contribution);
  }
  return counts;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function coverageStatus(rawTotal, coverage, hasUnderfilledStrata = false) {
  if (rawTotal < MINIMUM_RAW_REVIEWS) return 'insufficient';
  if (coverage < 0.5) return 'limited';
  if (coverage < 0.7 || hasUnderfilledStrata) return 'provisional';
  return 'valid';
}

// Coverage dùng mẫu số cố định của thiết kế. Tầng thiếu luôn đóng góp 0 và
// review vượt chỉ tiêu của một tầng không thể bù cho tầng khác. Công thức này
// đơn điệu: thêm bằng chứng từ contributor mới không làm coverage giảm.
function sampleAdequacy(evidence, policy, rawTotal) {
  if (!policy.stratifiedByRating) {
    const contributorCount = distinctContributorCount(evidence);
    const coverage = clamp(contributorCount / UNSTRATIFIED_TARGET_SAMPLE, 0, 1);
    const coveredSampleSlots = coverage * UNSTRATIFIED_TARGET_SAMPLE;
    return {
      coverage,
      countCoverage: coverage,
      strataCoverage: null,
      balanceDiagnostic: null,
      observedCount: contributorCount,
      coveredSampleSlots,
      targetSample: UNSTRATIFIED_TARGET_SAMPLE,
      status: coverageStatus(rawTotal, coverage),
      missingRatings: [],
      strata: []
    };
  }

  const contributorCounts = contributorCountsByRating(evidence, policy.ratingStrata);
  const strata = policy.ratingStrata.map((rating) => {
    const count = contributorCounts.get(rating);
    return { rating, count, fill: clamp(count / policy.perStratumTarget, 0, 1) };
  });
  const missingRatings = strata.filter(({ count }) => count === 0).map(({ rating }) => rating);
  const thinRatings = strata
    .filter(({ fill }) => fill < MIN_STRATUM_FILL_FOR_VALID_STATUS)
    .map(({ rating }) => rating);
  const countCoverage = mean(strata.map(({ fill }) => fill));
  const strataCoverage = ratio(strata.length - missingRatings.length, strata.length);
  const total = strata.reduce((sum, { count }) => sum + count, 0);
  const squaredTotal = strata.reduce((sum, { count }) => sum + count ** 2, 0);
  // Chỉ chẩn đoán mức cân bằng; không tham gia TrustScore vì chỉ số này có thể
  // giảm khi thêm review vào một tầng và vì vậy không phù hợp làm độ phủ.
  const balanceDiagnostic = squaredTotal > 0 ? (total ** 2) / (strata.length * squaredTotal) : 0;
  // CountCoverage đã thưởng độ rộng một cách tự nhiên nhờ cap riêng từng tầng.
  // Không trộn thêm trọng số tùy ý; strata/balance chỉ dùng để chẩn đoán.
  const coverage = countCoverage;
  const targetSample = policy.ratingStrata.length * policy.perStratumTarget;
  const coveredSampleSlots = countCoverage * targetSample;
  return {
    coverage,
    countCoverage,
    strataCoverage,
    balanceDiagnostic,
    observedCount: total,
    coveredSampleSlots,
    targetSample,
    status: coverageStatus(rawTotal, coverage, thinRatings.length > 0),
    missingRatings,
    thinRatings,
    strata
  };
}

function textEvidenceScore({ signal }) {
  const detail = clamp(signal.text.length / 80, 0, 1);
  const informationMap = { high: 1, medium: 0.75, low: 0.35, none: 0 };
  const information = Object.hasOwn(informationMap, signal.informationValue)
    ? informationMap[signal.informationValue]
    : detail;
  // Provider không có độ phủ verification giống nhau. Giữ TrustScore so sánh
  // được bằng cách chấm nội dung theo cùng một công thức; verification chỉ là
  // thống kê chẩn đoán và không được biến missing thành verified=true/false.
  return 100 * (0.625 * information + 0.375 * detail);
}

function scoreAuditGroup(audit, evidence) {
  const classifiedAudit = audit.filter(({ review }) => !review?.labels?.layer2_unavailable);
  return {
    // Tầng đã quan sát nhưng không còn bằng chứng hợp lệ phải nhận 0 điểm nội
    // dung; không được biến mất khỏi trung bình rồi làm điểm tăng giả.
    text: evidence.length ? meanByContributor(evidence, textEvidenceScore) : 0,
    authenticity: classifiedAudit.length
      ? meanByContributor(classifiedAudit, (entry) => isEvidenceEntry(entry) ? 100 : 0)
      : null,
    labeling: audit.length
      ? meanByContributor(audit, ({ review }) => review?.labels?.layer2_unavailable ? 0 : 100)
      : 0
  };
}

function meanAvailable(values) {
  const available = values.filter(Number.isFinite);
  return mean(available);
}

function componentScores(audit, evidence, adequacy, policy) {
  let quality;
  if (policy.stratifiedByRating) {
    // Mỗi tầng sao đã quan sát có trọng số bằng nhau. Không bịa chất lượng cho
    // tầng chưa thu thập được; độ thiếu được mô tả bởi coverage. Tầng đã có
    // dữ liệu nhưng không còn bằng chứng hợp lệ giữ điểm nội dung 0.
    const observedStrata = policy.ratingStrata
      .map((rating) => {
        const auditEntries = audit.filter(({ review }) => Number(review.rating) === rating);
        if (!auditEntries.length) return null;
        const evidenceEntries = evidence.filter(({ review }) => Number(review.rating) === rating);
        return scoreAuditGroup(auditEntries, evidenceEntries);
      })
      .filter(Boolean);
    quality = {
      text: meanAvailable(observedStrata.map(({ text }) => text)),
      authenticity: meanAvailable(observedStrata.map(({ authenticity }) => authenticity)),
      labeling: meanAvailable(observedStrata.map(({ labeling }) => labeling))
    };
  } else {
    const pooled = scoreAuditGroup(audit, evidence);
    quality = {
      text: Number.isFinite(pooled.text) ? pooled.text : 0,
      authenticity: Number.isFinite(pooled.authenticity) ? pooled.authenticity : 0,
      labeling: pooled.labeling
    };
  }
  const seedingRate = ratio(audit.filter(({ signal }) => signal.seeding).length, audit.length);
  const vagueRate = ratio(audit.filter(({ signal }) => signal.vague).length, audit.length);
  const lowValueRate = ratio(audit.filter(({ signal }) => signal.lowValue).length, audit.length);
  const offTopicRate = ratio(audit.filter(({ signal }) => signal.offTopic).length, audit.length);
  const duplicateRate = ratio(audit.filter(({ signal }) => signal.duplicate).length, audit.length);
  const unavailableRate = ratio(audit.filter(({ review }) => review?.labels?.layer2_unavailable).length, audit.length);
  return {
    ...quality,
    adequacy: 100 * adequacy.coverage,
    rates: { seeding: seedingRate, vague: vagueRate, lowValue: lowValueRate, offTopic: offTopicRate, duplicate: duplicateRate, layer2Unavailable: unavailableRate }
  };
}

function fisherComponent(signals, reviews, inferenceEnabled = false) {
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
    const pValue = inferenceEnabled ? fisherExactTwoSided(table) : null;
    const oddsRatio = correctedOddsRatio(table);
    const penalty = pValue !== null && pValue < FISHER_ALPHA ? Math.min(3, Math.max(0, Math.log(oddsRatio))) : 0;
    return { table, pValue, oddsRatio, significant: pValue !== null && pValue < FISHER_ALPHA, penalty, inferenceEnabled };
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
  const weighted = {
    text: { score: clamp(componentScores.text), weight: 1 / 3, active: true, label: 'Chất lượng bằng chứng' },
    authenticity: { score: clamp(componentScores.authenticity), weight: 1 / 3, active: true, label: 'Mức ít nhiễu' },
    labeling: { score: clamp(componentScores.labeling), weight: 1 / 3, active: true, label: 'Độ phủ kiểm định' },
    adequacy: { score: clamp(componentScores.adequacy), weight: 0, active: false, role: 'coverage-modifier', label: 'Độ đầy đủ của mẫu' }
  };
  const activeWeight = Object.values(weighted).reduce((sum, component) => sum + (component.active ? component.weight : 0), 0);
  const qualityScore = activeWeight
    ? Object.values(weighted).reduce((sum, component) => sum + (component.active ? component.score * component.weight : 0), 0) / activeWeight
    : 0;
  const coverage = clamp(options.coverage ?? componentScores.adequacy, 0, 100) / 100;
  // Thiếu mẫu chỉ kéo phần điểm trên mức trung lập 50 về 50. Điểm thấp không
  // bao giờ được "cứu" tăng lên do thiếu dữ liệu, và coverage chỉ dùng một lần.
  const rawScore = qualityScore <= 50
    ? qualityScore
    : 50 + coverage * (qualityScore - 50);
  return {
    score: Math.round(clamp(rawScore)),
    rawScore,
    qualityScore,
    components: weighted,
    guardrails: {
      method: 'one-sided-coverage-shrinkage',
      coverage,
      neutralPoint: 50,
      totalPenalty: Math.max(0, qualityScore - rawScore),
      applied: qualityScore > 50 && coverage < 1 ? ['sample-coverage'] : []
    },
    caps: { fisher: 100, defect: 100, high: 100, applied: [], deprecated: true }
  };
}

export function calculateTrustScoreV31(reviews = [], options = {}) {
  const normalizedReviews = Array.isArray(reviews)
    ? reviews.filter(isWrittenReview)
    : [];
  const policy = samplingPolicy(options.sampling);
  const samples = statisticalSamples(normalizedReviews, policy);
  const inference = inferenceEligibility(samples.audit, policy.populationInferenceEnabled);
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
  const defectEstimate = defectEstimateForSample(samples.evidence, policy);
  const defectTests = issueCounts.map((issue) => {
    const p0 = Number(baseline.values?.[issue.id]);
    const hasBaseline = Number.isFinite(p0) && p0 >= 0 && p0 <= 1;
    const decisionEnabled = baseline.calibrated && hasBaseline && inference.enabled;
    const pValue = decisionEnabled
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
      decisionEnabled
    };
  });
  const completeDefectFamily = defectTests.every((item) => Number.isFinite(item.pValue));
  const defects = (completeDefectFamily
    ? holmAdjust(defectTests)
    : defectTests.map((item) => ({ ...item, adjustedPValue: null, significantHolm: false })))
    .map((item) => ({
      ...item,
      multipleTestingMethod: completeDefectFamily ? 'holm-bonferroni' : 'bonferroni-fixed',
      significantAdjusted: item.decisionEnabled && (completeDefectFamily ? item.significantHolm : item.significantBonferroni)
    }));

  const fisher = fisherComponent(auditSignals, auditReviews, inference.enabled);
  const adequacy = sampleAdequacy(samples.evidence, policy, normalizedReviews.length);
  const components = componentScores(samples.audit, samples.evidence, adequacy, policy);
  const temporal = temporalScore(evidenceReviews);
  const combined = combineTrustComponents({
    text: components.text,
    authenticity: components.authenticity,
    labeling: components.labeling,
    adequacy: components.adequacy
  });
  const dateCoverage = temporal.coverage;
  const scoreAvailable = normalizedReviews.length >= MINIMUM_RAW_REVIEWS;

  return {
    version: '4.2',
    scope: 'review-set-reliability',
    scoreType: 'composite-index-not-probability',
    score: scoreAvailable ? combined.score : null,
    rawScore: scoreAvailable ? combined.rawScore : null,
    baseQualityScore: scoreAvailable ? combined.qualityScore : null,
    scoreStatus: adequacy.status,
    components: combined.components,
    caps: combined.caps,
    guardrails: combined.guardrails,
    formula: {
      baseQuality: '(text + authenticity + labeling) / 3',
      sampleCoverage: policy.stratifiedByRating
        ? 'mean(min(distinct_evidence_contributors_in_stratum / per_stratum_target, 1))'
        : 'min(distinct_evidence_contributors / target_sample, 1)',
      finalScore: 'Q <= 50 ? Q : 50 + coverage * (Q - 50)',
      rounding: 'nearest-integer-at-final-step-only'
    },
    sample: {
      total: normalizedReviews.length,
      statisticalPopulation: auditReviews.length,
      afterSeedingRemoval: evidenceReviews.length,
      rejectedFromEvidence: auditReviews.length - evidenceReviews.length,
      excludedBySamplingDesign: samples.excludedByDesign,
      seedingCount: samples.audit.filter(({ signal }) => signal.seeding).length,
      totalSeedingCount: samples.annotated.filter(({ signal }) => signal.seeding).length,
      distinctContributorEvidenceSize: distinctContributorCount(samples.evidence),
      independentEvidenceSize: distinctContributorCount(samples.evidence),
      independentEvidenceSizeDeprecated: true,
      distinctContributorCoverageSize: adequacy.observedCount,
      independentCoverageSize: policy.stratifiedByRating
        ? adequacy.strata.reduce((sum, stratum) => sum + stratum.count, 0)
        : adequacy.observedCount,
      independentCoverageSizeDeprecated: true,
      verification: {
        verified: samples.audit.filter(({ review }) => review.verified === true).length,
        unverified: samples.audit.filter(({ review }) => review.verified === false).length,
        unknown: samples.audit.filter(({ review }) => typeof review.verified !== 'boolean').length
      }
    },
    sampling: {
      strategy: policy.strategy,
      controlledStarStrata: policy.stratifiedByRating,
      distributionMode: policy.distributionMode,
      defectMode: policy.defectMode,
      populationInferenceRequested: policy.populationInferenceEnabled,
      populationInferenceEnabled: inference.enabled,
      populationInferenceDisabledReason: inference.reason,
      randomized: policy.randomized,
      standardRatings: policy.standardRatings,
      perStarLimit: policy.stratifiedByRating ? policy.perStratumTarget : null
    },
    adequacy: {
      score: Math.round(100 * adequacy.coverage),
      label: adequacy.status === 'valid'
        ? 'Đủ dùng'
        : adequacy.status === 'provisional'
          ? 'Độ phủ tạm thời'
          : adequacy.status === 'limited'
            ? 'Độ phủ hạn chế'
            : 'Chưa đủ 20 review',
      targetSample: adequacy.targetSample,
      coverage: adequacy.coverage,
      countCoverage: adequacy.countCoverage,
      strataCoverage: adequacy.strataCoverage,
      balanceDiagnostic: adequacy.balanceDiagnostic,
      balanceAffectsTrustScore: false,
      coveredSampleSlots: adequacy.coveredSampleSlots,
      balancedEvidenceSize: adequacy.coveredSampleSlots,
      balancedEvidenceSizeDeprecated: true,
      effectiveSampleSize: adequacy.coveredSampleSlots,
      effectiveSampleSizeDeprecated: true,
      missingRatings: adequacy.missingRatings,
      thinRatings: adequacy.thinRatings || [],
      strata: adequacy.strata,
      dateCoverage
    },
    fisher,
    defects: {
      diagnosticOnly: true,
      affectsTrustScore: false,
      score: defectEstimate.risk === null ? null : 100 * (1 - defectEstimate.risk),
      observedScore: defectEstimate.risk === null ? null : 100 * (1 - defectEstimate.risk),
      status: policy.defectMode,
      penalty: defectEstimate.risk,
      risk: defectEstimate.risk,
      estimator: defectEstimate,
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
      'TrustScore đo độ tin cậy của tập review; defectScore chỉ mô tả nội dung ưu/nhược điểm và không tham gia tổng điểm.',
      'Mỗi authorId chỉ đóng góp tối đa một đơn vị vào độ phủ toàn mẫu; review ẩn danh được tính là các quan sát riêng và không được tuyên bố là độc lập xác suất.',
      baseline.calibrated && inference.enabled
        ? `Kiểm định khuyết tật dùng baseline đã hiệu chuẩn: ${baseline.source}.`
        : policy.populationInferenceEnabled && !inference.enabled
          ? `Không chạy suy luận tổng thể vì dữ liệu không thỏa điều kiện đơn vị quan sát độc lập (${inference.reason}).`
          : policy.populationInferenceEnabled
            ? 'Các p0 mặc định chỉ là ví dụ từ tài liệu; không tính p-value khuyết tật khi baseline chưa được hiệu chuẩn.'
            : policy.stratifiedByRating
              ? 'Không chạy suy luận tỷ lệ khuyết tật theo p0 vì dữ liệu được chủ động chia tầng theo mức sao.'
              : 'Không chạy suy luận tỷ lệ khuyết tật theo p0 vì nguồn thu thập không bảo đảm chọn mẫu ngẫu nhiên.',
      adequacy.status === 'insufficient'
        ? `Chỉ có ${normalizedReviews.length}/${MINIMUM_RAW_REVIEWS} review thô; không trả TrustScore.`
        : `Độ phủ mẫu đạt ${(100 * adequacy.coverage).toFixed(1)}%; đã lấp ${adequacy.coveredSampleSlots.toFixed(1)}/${adequacy.targetSample} vị trí của thiết kế và review lấy dư ở một tầng không bù được tầng khác.`,
      policy.stratifiedByRating
        ? `Mẫu chia tầng theo các mức ${policy.ratingStrata.map((rating) => `${rating}★`).join(', ')}. Đây là chỉ số theo thiết kế mẫu chuẩn, không phải tỷ lệ đại diện cho toàn bộ nền tảng.`
        : 'Nhược điểm chỉ được mô tả trên mẫu đã lấy, không suy rộng thành tỷ lệ của toàn bộ sản phẩm.'
    ]
  };
}
