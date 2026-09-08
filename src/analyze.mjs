import { getReviews } from './sources.mjs';
import { buildTrustAnalysis } from './trust-analysis.mjs';
import { classifyReviewSignals, findReviewIssues, ISSUE_DEFINITIONS } from './trust-score-v31.mjs';
import { labelReviewsTwoLayer } from './review-labeler.mjs';
import { saveReviewDatasets } from './review-dataset-storage.mjs';
import { createProgressReporter } from './sse.mjs';
import { assertEnoughReviews, checkSamplingCoverage } from './analysis-eligibility.mjs';
import { throwIfAborted } from './abort.mjs';
import { setCachedShopeeDataset } from './product-cache.mjs';

const issueDefinitions = ISSUE_DEFINITIONS.map(({ id, label, words }) => ({ id, label, words }));
const lowValuePatterns = [/^ok+([.! ]*)$/i, /tốt([.! ]*)$/i, /^đẹp([.! ]*)$/i, /^5\s*sao/i, /chưa.{0,12}(dùng|thử)/i];

const exclusionReasonByCode = Object.freeze({
  LOW_VALUE_GIBBERISH: 'Nội dung là chuỗi ký tự ngẫu nhiên hoặc không có nghĩa',
  LOW_VALUE_LOGISTICS_ONLY: 'Chỉ đề cập giao hàng hoặc đóng gói, không đánh giá sản phẩm',
  LOW_VALUE_RESALE_ONLY: 'Nội dung chủ yếu rao bán hoặc sang tay sản phẩm, không đánh giá chất lượng',
  LOW_VALUE_REWARD_CONTENT: 'Nội dung hoặc hình ảnh được đăng để nhận xu/thưởng, không dùng làm bằng chứng',
  LOW_VALUE_PROMOTIONAL_CONTENT: 'Nội dung quảng cáo cửa hàng hoặc liệt kê mặt hàng khác, không đánh giá sản phẩm',
  LOW_VALUE_EXAGGERATED_LANGUAGE: 'Dùng nhiều lời khen/chê tuyệt đối nhưng thiếu trải nghiệm cụ thể để kiểm chứng',
  LOW_VALUE_NO_USAGE_EXPERIENCE: 'Chưa sử dụng hoặc chưa trải nghiệm sản phẩm, không đủ thông tin đánh giá',
  LOW_VALUE_NO_USAGE: 'Chưa sử dụng hoặc chưa trải nghiệm sản phẩm, không đủ thông tin đánh giá',
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
  if (review.labels?.hard_reject || review.labeling?.layer1?.hard_reject) {
    return { keep: false, reason: lowValueReason || 'Nội dung là chuỗi ký tự rác, không đủ làm bằng chứng' };
  }
  if (review.labels?.is_duplicate) {
    return { keep: false, reason: 'Nội dung trùng hoặc gần trùng với một review khác trong cùng mẫu' };
  }
  if (review.labels?.relevance === 'off_topic' || review.labels?.is_off_topic) {
    return { keep: false, reason: 'Nội dung mô tả một sản phẩm khác với sản phẩm đang phân tích' };
  }
  if (seeding && !hasIssue) return { keep: false, reason: 'Có dấu hiệu nhận xu / seeding' };
  if (seeding) return { keep: false, reason: 'Có bằng chứng seeding dù review có nhắc đến lỗi' };
  // Khi Layer 2 không thể kết luận sau retry, giữ review không bị Layer 1 khóa
  // cứng và đánh dấu fallback trong audit thay vì biến sự cố AI thành loại oan.
  if (review.labels?.layer2_fallback_accepted) return { keep: true, reason: null };
  if (review.labels?.is_vague) return { keep: false, reason: 'Phản hồi tiêu cực mơ hồ, chưa nêu lỗi cụ thể' };
  if (review.labels?.is_low_value && !hasIssue) {
    return { keep: false, reason: lowValueReason || 'Nội dung ít thông tin, không đủ làm bằng chứng' };
  }
  if (!hasIssue && !hasUsefulEvidence && ['low', 'none'].includes(informationValue)) {
    return { keep: false, reason: 'Nội dung không nêu trải nghiệm hoặc chất lượng sản phẩm đủ rõ để làm bằng chứng' };
  }
  if (review.labels?.layer2_unavailable) {
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
  const emit = (callback, payload) => {
    if (typeof callback !== 'function') return;
    try { callback(payload); } catch { /* Streaming updates must never break analysis. */ }
  };
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    const error = new Error('Hãy dán link sản phẩm Shopee hoặc TikTok Shop.');
    error.statusCode = 400;
    throw error;
  }

  progress('validating', 3, 'Đang khởi tạo hệ thống...');
  const { reviews, source, product, warnings } = await getReviews(rawUrl.trim(), {
    onProgress: options.onProgress,
    onProductMeta: (metadata) => emit(options.onProductMeta, metadata),
    signal: options.signal,
    redisFetchImpl: options.redisFetchImpl,
    blobGetImpl: options.blobGetImpl,
    blobListImpl: options.blobListImpl,
    blobToken: options.blobToken,
    now: options.now
  });
  const starDistribution = Object.fromEntries([1, 2, 3, 4, 5].map((rating) => [
    rating,
    reviews.filter((review) => Number(review.rating) === rating).length
  ]));
  emit(options.onReviewsSample, {
    total: reviews.length,
    starDistribution,
    source: {
      type: source?.type || 'live',
      label: source?.label || '',
      cache: source?.cache || null
    }
  });
  try {
    assertEnoughReviews(reviews);
  } catch (error) {
    progress('eligibility', 64, 'Sản phẩm chưa đủ đánh giá để phân tích.');
    throw error;
  }
  const coverage = checkSamplingCoverage(reviews, source?.collection);
  if (!coverage.complete && coverage.missingRatings?.length) {
    warnings.push(`Mẫu review chưa có đủ các tầng sao thiết kế (thiếu ${coverage.missingRatings.map((rating) => `${rating}★`).join(', ')}); hệ thống vẫn phân tích trên ${reviews.length} review thu thập được.`);
  }
  progress('labeling', 66, 'Đang phân tích reviews...');
  const geminiStartedAt = Date.now();
  const geminiContext = {
    deadlineAt: geminiStartedAt + 75_000,
    layer2DeadlineAt: geminiStartedAt + 45_000,
    busyRouteIds: new Set(),
    failedRouteIds: new Set()
  };
  const labeling = await labelReviewsTwoLayer(reviews, {
    product,
    geminiContext,
    signal: options.signal,
    onLayer1Stats: (stats) => emit(options.onLayer1Stats, stats)
  });
  progress('filtering', 76, 'Đang phân tích reviews...');
  // Labeler đã khử trùng trước Gemini. Chỉ bản đại diện được kiểm định; chạy
  // lại sau đó sẽ nhầm nhãn mới của đại diện với nhãn cũ của bản sao.
  const labelingStats = labeling.stats;
  const duplicateCount = labelingStats.duplicateContentCount || 0;
  if (duplicateCount) {
    warnings.push(`Đã loại ${duplicateCount} review có nội dung trùng hoặc gần trùng trong cùng mẫu.`);
  }
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
      level: 'Ghi nhận trong mẫu',
      examples: relatedReviews.map(({ text, rating, date }) => ({ text, rating, date }))
    }));

  const lowRatings = genuine.filter((review) => review.rating <= 3).length;
  const signal = issues.length === 0 ? 'Chưa thấy nhược điểm lặp lại rõ ràng' : issues[0].label;
  const processedReviews = checked.map(({ filter, ...review }) => ({
    ...review,
    included: filter.keep,
    verificationStatus: review.labels?.layer2_fallback_accepted
      ? 'fallback'
      : review.labels?.layer2_unavailable
        ? 'unverified'
        : filter.keep ? 'accepted' : 'excluded',
    exclusionReason: filter.reason
  }));
  const unverifiedCount = processedReviews.filter((review) => review.verificationStatus === 'unverified').length;
  if (reviews.length && unverifiedCount / reviews.length > 0.2) {
    warnings.push(`Có ${unverifiedCount}/${reviews.length} review chưa được Layer 2 kiểm định; nội dung của chúng không được dùng làm bằng chứng và phần thiếu này được phản ánh trong độ phủ kiểm định.`);
  }
  const fallbackTrustSample = processedReviews.filter((review) => (
    review.included !== false && !classifyReviewSignals(review).seeding
  )).length;
  progress('saving', 84, 'Đang hoàn thiện kết quả...');
  throwIfAborted(options.signal);
  const dataset = source?.type === 'cached'
    ? {
        saved: false,
        reused: true,
        runId: source.cache?.runId || null,
        provider: 'vercel-blob-cache'
      }
    : await saveReviewDatasets({
        rawReviews: reviews,
        labeledReviews: processedReviews,
        product,
        source,
        labeling: labelingStats
      }, options.datasetOptions);
  if (dataset.warning) warnings.push(dataset.warning);
  if (product.platform === 'Shopee' && source?.type === 'live'
    && dataset.saved && dataset.provider === 'vercel-blob-private') {
    const cached = await setCachedShopeeDataset(product.itemId, dataset, dataset.rawDataset, {
      redisFetchImpl: options.redisFetchImpl,
      now: options.now
    }).catch((error) => ({ saved: false, reason: error?.message || 'UNKNOWN_CACHE_ERROR' }));
    if (!cached.saved) warnings.push(`Dataset Shopee đã lưu nhưng chưa tạo được cache index: ${cached.reason}.`);
  }
  warnings.push(...labeling.warnings);
  progress('scoring', 91, 'Đang hoàn thiện kết quả...');
  const narrativeStartedAt = Date.now();
  const trust = await buildTrustAnalysis(processedReviews, {
    product,
    sampling: source?.collection,
    geminiContext,
    signal: options.signal
  });
  if (process.env.VERCEL) {
    console.log(JSON.stringify({
      level: 'info',
      event: 'gemini_pipeline_complete',
      durationMs: Date.now() - geminiStartedAt,
      layer2DurationMs: labelingStats.layer2DurationMs,
      narrativeDurationMs: Date.now() - narrativeStartedAt,
      layer2Status: labelingStats.layer2Status,
      narrativeEngine: trust.engine,
      failedRoutes: geminiContext.failedRouteIds.size
    }));
  }
  const result = {
    product,
    source,
    warnings,
    labeling: labelingStats,
    dataset: { saved: dataset.saved, reused: Boolean(dataset.reused), runId: dataset.runId, provider: dataset.provider },
    stats: {
      scanned: reviews.length,
      included: genuine.length,
      genuine: genuine.length,
      excluded: excluded.length,
      unverified: unverifiedCount,
      lowRatings,
      trustSample: trust.method?.sample?.afterSeedingRemoval ?? fallbackTrustSample,
      algorithmSample: trust.method?.sample?.afterSeedingRemoval ?? fallbackTrustSample,
      evidenceRejected: trust.method?.sample?.rejectedFromEvidence ?? (reviews.length - fallbackTrustSample),
      samplingDesignExcluded: trust.method?.sample?.excludedBySamplingDesign ?? 0,
      duplicateContentExcluded: duplicateCount,
      seedingExcluded: trust.method?.sample?.totalSeedingCount
        ?? processedReviews.filter((review) => classifyReviewSignals(review).seeding).length
    },
    verdict: issues.length
      ? `Trong mẫu đã thu thập, ${issues[0].count} review đáng tham khảo đề cập “${signal.toLowerCase()}”. Hãy đọc các dẫn chứng để tự đánh giá sản phẩm.`
      : 'Trong mẫu đã thu thập, chưa ghi nhận nhược điểm cụ thể lặp lại. Kết quả này không khẳng định sản phẩm không có vấn đề.',
    issues,
    trust,
    reviews: processedReviews
  };
  progress('complete', 100, 'Phân tích hoàn tất.');
  return result;
}

