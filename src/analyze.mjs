import { getReviews } from './sources.mjs';
import { buildTrustAnalysis } from './trust-analysis.mjs';
import { classifyReviewSignals, findReviewIssues, ISSUE_DEFINITIONS } from './trust-score-v31.mjs';
import { labelReviewsTwoLayer } from './review-labeler.mjs';
import { saveReviewDatasets } from './review-dataset-storage.mjs';
import { createProgressReporter } from './sse.mjs';
import { assertEnoughReviews } from './analysis-eligibility.mjs';

const issueDefinitions = ISSUE_DEFINITIONS.map(({ id, label, words }) => ({ id, label, words }));
const lowValuePatterns = [/^ok+([.! ]*)$/i, /tốt([.! ]*)$/i, /^đẹp([.! ]*)$/i, /^5\s*sao/i, /chưa.{0,12}(dùng|thử)/i];

const exclusionReasonByCode = Object.freeze({
  LOW_VALUE_GIBBERISH: 'Nội dung là chuỗi ký tự ngẫu nhiên hoặc không có nghĩa',
  LOW_VALUE_LOGISTICS_ONLY: 'Chỉ đề cập giao hàng hoặc đóng gói, không đánh giá sản phẩm',
  LOW_VALUE_REPETITION: 'Nội dung lặp ký tự hoặc biểu tượng, không đủ làm bằng chứng',
  LOW_VALUE_ICON_ONLY: 'Chỉ có biểu tượng, không có nhận xét về sản phẩm',
  LOW_VALUE_GENERIC: 'Nhận xét quá chung chung, không có thông tin về sản phẩm',
  LOW_VALUE_SHORT: 'Nội dung quá ngắn, không đủ làm bằng chứng'
});

function normalise(text = '') {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function findIssues(review) {
  const categoryIds = review?.labels?.defect_categories;
  if (Array.isArray(categoryIds)) return ISSUE_DEFINITIONS.filter((issue) => categoryIds.includes(issue.id));
  return findReviewIssues(typeof review === 'string' ? review : review?.text);
}

export function shouldKeep(review) {
  const text = normalise(review.text);
  const hasIssue = findIssues(review).length > 0;
  const generic = lowValuePatterns.some((pattern) => pattern.test(text));
  const signals = classifyReviewSignals(review);
  const seeding = signals.seeding;
  const informationValue = review.labels?.information_value;
  const hasUsefulEvidence = informationValue === 'medium' || informationValue === 'high';
  const reasonCodes = [review.labels?.reason_code, ...(review.labeling?.layer1?.reason_codes || [])].filter(Boolean);
  const lowValueReason = reasonCodes.map((code) => exclusionReasonByCode[code]).find(Boolean);
  if (review.labels?.relevance === 'off_topic' || review.labels?.is_off_topic) {
    return { keep: false, reason: 'Nội dung mô tả một sản phẩm khác với sản phẩm đang phân tích' };
  }
  if (seeding && !hasIssue) return { keep: false, reason: 'Có dấu hiệu nhận xu / seeding' };
  if (seeding) return { keep: false, reason: 'Có bằng chứng seeding dù review có nhắc đến lỗi' };
  if (review.labels?.is_vague) return { keep: false, reason: 'Phản hồi tiêu cực mơ hồ, chưa nêu lỗi cụ thể' };
  if (review.labels?.is_low_value && !hasIssue) {
    return { keep: false, reason: lowValueReason || 'Nội dung ít thông tin, không đủ làm bằng chứng' };
  }
  if (review.labels?.layer2_unavailable && !hasIssue && !hasUsefulEvidence) {
    return { keep: false, reason: 'Chưa đủ dữ liệu để kiểm định nội dung review' };
  }
  if ((text.length < 14 || generic) && !hasIssue && !hasUsefulEvidence) {
    return { keep: false, reason: 'Quá ngắn hoặc không có trải nghiệm cụ thể' };
  }
  if (review.rating >= 4 && !hasIssue && text.length < 38 && !hasUsefulEvidence) {
    return { keep: false, reason: 'Khen chung chung, ít thông tin kiểm chứng' };
  }
  return { keep: true, reason: null };
}

export async function analyzeProductUrl(rawUrl, options = {}) {
  const progress = createProgressReporter(options.onProgress);
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    const error = new Error('Hãy dán link sản phẩm Shopee hoặc TikTok Shop.');
    error.statusCode = 400;
    throw error;
  }

  progress('validating', 3, 'Đang khởi tạo hệ thống...');
  const { reviews, source, product, warnings } = await getReviews(rawUrl.trim(), {
    onProgress: options.onProgress
  });
  try {
    assertEnoughReviews(reviews);
  } catch (error) {
    progress('eligibility', 64, 'Sản phẩm chưa đủ đánh giá để phân tích.');
    throw error;
  }
  progress('labeling', 66, 'Đang phân tích reviews...');
  const geminiStartedAt = Date.now();
  const geminiContext = {
    deadlineAt: geminiStartedAt + 14_500,
    layer2DeadlineAt: geminiStartedAt + 8_500,
    busyRouteIds: new Set(),
    failedRouteIds: new Set()
  };
  const labeling = await labelReviewsTwoLayer(reviews, { product, geminiContext });
  progress('filtering', 76, 'Đang phân tích reviews...');
  const checked = labeling.reviews.map((review) => ({ ...review, filter: shouldKeep(review) }));
  const genuine = checked.filter((review) => review.filter.keep);
  const excluded = checked.filter((review) => !review.filter.keep);
  const grouped = new Map(issueDefinitions.map((issue) => [issue.id, { ...issue, count: 0, reviews: [] }]));

  for (const review of genuine) {
    for (const issue of findIssues(review)) {
      const group = grouped.get(issue.id);
      group.count += 1;
      if (group.reviews.length < 2) group.reviews.push(review);
    }
  }
  const issues = [...grouped.values()]
    .filter((item) => item.count)
    .sort((a, b) => b.count - a.count)
    .map(({ id, label, count, reviews: relatedReviews }) => ({
      id, label, count,
      level: count >= 3 ? 'Nên cân nhắc' : 'Có ghi nhận',
      examples: relatedReviews.map(({ text, rating, date }) => ({ text, rating, date }))
    }));

  const lowRatings = genuine.filter((review) => review.rating <= 3).length;
  const signal = issues.length === 0 ? 'Chưa thấy nhược điểm lặp lại rõ ràng' : issues[0].label;
  const processedReviews = checked.map(({ filter, ...review }) => ({ ...review, included: filter.keep, exclusionReason: filter.reason }));
  const trustSample = processedReviews.filter((review) => !classifyReviewSignals(review).seeding).length;
  progress('saving', 84, 'Đang hoàn thiện kết quả...');
  const dataset = await saveReviewDatasets({
    rawReviews: reviews,
    labeledReviews: processedReviews,
    product,
    source,
    labeling: labeling.stats
  });
  if (dataset.warning) warnings.push(dataset.warning);
  warnings.push(...labeling.warnings);
  progress('scoring', 91, 'Đang hoàn thiện kết quả...');
  const narrativeStartedAt = Date.now();
  const trust = await buildTrustAnalysis(processedReviews, {
    product,
    sampling: source?.collection,
    geminiContext
  });
  if (process.env.VERCEL) {
    console.log(JSON.stringify({
      level: 'info',
      event: 'gemini_pipeline_complete',
      durationMs: Date.now() - geminiStartedAt,
      layer2DurationMs: labeling.stats.layer2DurationMs,
      narrativeDurationMs: Date.now() - narrativeStartedAt,
      layer2Status: labeling.stats.layer2Status,
      narrativeEngine: trust.engine,
      failedRoutes: geminiContext.failedRouteIds.size
    }));
  }
  const result = {
    product,
    source,
    warnings,
    labeling: labeling.stats,
    dataset: { saved: dataset.saved, runId: dataset.runId, provider: dataset.provider },
    stats: {
      scanned: reviews.length,
      included: genuine.length,
      genuine: genuine.length,
      excluded: excluded.length,
      lowRatings,
      trustSample: trust.method?.sample?.afterSeedingRemoval ?? trustSample,
      algorithmSample: trust.method?.sample?.afterSeedingRemoval ?? trustSample,
      seedingExcluded: trust.method?.sample?.seedingCount ?? (reviews.length - trustSample)
    },
    verdict: issues.some((issue) => issue.count >= 3)
      ? `Cần cân nhắc: nhiều phản hồi thật đề cập “${signal.toLowerCase()}”.`
      : issues.length
        ? `Có một số phản hồi cần lưu ý về ${signal.toLowerCase()}.`
        : 'Chưa đủ tín hiệu tiêu cực đáng tin để kết luận sản phẩm có vấn đề.',
    issues,
    trust,
    reviews: processedReviews
  };
  progress('complete', 100, 'Phân tích hoàn tất.');
  return result;
}


