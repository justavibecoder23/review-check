import { getReviews } from './sources.mjs';
import { buildTrustAnalysis } from './trust-analysis.mjs';
import { classifyReviewSignals, findReviewIssues, ISSUE_DEFINITIONS } from './trust-score-v31.mjs';
import { labelReviewsTwoLayer } from './review-labeler.mjs';
import { saveReviewDatasets } from './review-dataset-storage.mjs';

const issueDefinitions = ISSUE_DEFINITIONS.map(({ id, label, words }) => ({ id, label, words }));
const lowValuePatterns = [/^ok+([.! ]*)$/i, /tốt([.! ]*)$/i, /^đẹp([.! ]*)$/i, /^5\s*sao/i, /chưa.{0,12}(dùng|thử)/i];

function normalise(text = '') {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function findIssues(review) {
  const categoryIds = review?.labels?.defect_categories;
  if (Array.isArray(categoryIds)) return ISSUE_DEFINITIONS.filter((issue) => categoryIds.includes(issue.id));
  return findReviewIssues(typeof review === 'string' ? review : review?.text);
}

function shouldKeep(review) {
  const text = normalise(review.text);
  const hasIssue = findIssues(review).length > 0;
  const generic = lowValuePatterns.some((pattern) => pattern.test(text));
  const signals = classifyReviewSignals(review);
  const seeding = signals.seeding;
  if (seeding && !hasIssue) return { keep: false, reason: 'Có dấu hiệu nhận xu / seeding' };
  if (seeding) return { keep: false, reason: 'Có bằng chứng seeding dù review có nhắc đến lỗi' };
  if (review.labels?.is_vague) return { keep: false, reason: 'Phản hồi tiêu cực mơ hồ, chưa nêu lỗi cụ thể' };
  if (review.labels?.is_low_value && !hasIssue) return { keep: false, reason: 'Nội dung ít thông tin, không đủ làm bằng chứng' };
  if ((text.length < 14 || generic) && !hasIssue) return { keep: false, reason: 'Quá ngắn hoặc không có trải nghiệm cụ thể' };
  if (review.rating >= 4 && !hasIssue && text.length < 38) return { keep: false, reason: 'Khen chung chung, ít thông tin kiểm chứng' };
  return { keep: true, reason: null };
}

export async function analyzeProductUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    const error = new Error('Hãy dán link sản phẩm Shopee hoặc TikTok Shop.');
    error.statusCode = 400;
    throw error;
  }

  const { reviews, source, product, warnings } = await getReviews(rawUrl.trim());
  const labeling = await labelReviewsTwoLayer(reviews, { product });
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
  const dataset = await saveReviewDatasets({
    rawReviews: reviews,
    labeledReviews: processedReviews,
    product,
    source,
    labeling: labeling.stats
  });
  if (dataset.warning) warnings.push(dataset.warning);
  warnings.push(...labeling.warnings);
  const trust = await buildTrustAnalysis(processedReviews, { product });
  return {
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
      confidence: trust.confidence.label,
      confidenceScore: trust.confidence.score,
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
}
