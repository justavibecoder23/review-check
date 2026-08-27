import { getReviews } from './sources.mjs';
import { buildTrustAnalysis } from './trust-analysis.mjs';

const issueDefinitions = [
  { id: 'chat-lieu', label: 'Chất liệu / độ bền', words: ['vải mỏng', 'mỏng', 'xù', 'bong', 'rách', 'sờn', 'mùi', 'cứng', 'thô', 'nhão', 'kém chất lượng', 'dễ hỏng'] },
  { id: 'kich-co', label: 'Kích cỡ / form dáng', words: ['form nhỏ', 'chật', 'rộng', 'ngắn', 'bé', 'size nhỏ', 'size lớn', 'không đúng size', 'lệch size'] },
  { id: 'dung-mo-ta', label: 'Khác mô tả / hình ảnh', words: ['khác hình', 'không giống', 'khác mô tả', 'sai màu', 'màu khác', 'thiếu', 'không đúng mẫu', 'lỗi'] },
  { id: 'giao-hang', label: 'Giao hàng / đóng gói', words: ['giao chậm', 'lâu', 'móp', 'bể', 'vỡ', 'đóng gói sơ sài', 'giao thiếu', 'trễ'] },
  { id: 'su-dung', label: 'Trải nghiệm sử dụng', words: ['không dùng được', 'không hoạt động', 'không bền', 'nóng', 'bí', 'khó chịu', 'rò', 'hết pin', 'yếu'] }
];

const seedingPatterns = [
  /nhận\s*(xu|điểm|coin)/i,
  /(review|đánh giá)\s*(lấy|để nhận)/i,
  /cho\s*(shop|sản phẩm)?\s*5\s*sao/i,
  /săn\s*sale|mã\s*giảm\s*giá|tích\s*xu/i,
  /chưa\s*(dùng|sử dụng|trải nghiệm|mở)/i,
  /giao hàng nhanh.*đóng gói.*(tốt|kỹ)/i,
  /hàng đẹp.{0,20}(5 sao|ủng hộ)/i
];
const lowValuePatterns = [/^ok+([.! ]*)$/i, /tốt([.! ]*)$/i, /^đẹp([.! ]*)$/i, /^5\s*sao/i, /chưa.{0,12}(dùng|thử)/i];

function normalise(text = '') {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function findIssues(text) {
  const lower = normalise(text);
  return issueDefinitions.filter((issue) => issue.words.some((word) => lower.includes(word)));
}

function shouldKeep(review) {
  const text = normalise(review.text);
  const hasIssue = findIssues(text).length > 0;
  const generic = lowValuePatterns.some((pattern) => pattern.test(text));
  const seeding = seedingPatterns.some((pattern) => pattern.test(text));
  if (seeding && !hasIssue) return { keep: false, reason: 'Có dấu hiệu nhận xu / seeding' };
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
  const checked = reviews.map((review) => ({ ...review, filter: shouldKeep(review) }));
  const genuine = checked.filter((review) => review.filter.keep);
  const excluded = checked.filter((review) => !review.filter.keep);
  const grouped = new Map(issueDefinitions.map((issue) => [issue.id, { ...issue, count: 0, reviews: [] }]));

  for (const review of genuine) {
    for (const issue of findIssues(review.text)) {
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
  const trust = await buildTrustAnalysis(processedReviews);
  return {
    product,
    source,
    warnings,
    stats: {
      scanned: reviews.length,
      genuine: genuine.length,
      excluded: excluded.length,
      lowRatings,
      confidence: trust.confidence.label,
      confidenceScore: trust.confidence.score
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
