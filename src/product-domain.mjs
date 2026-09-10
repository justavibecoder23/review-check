const DOMAINS = new Set(['food', 'beauty', 'fashion', 'electronics', 'home', 'health', 'other', 'unknown']);

const rules = [
  { domain: 'food', subcategory: 'food', pattern: /(?:kẹo|bánh|đồ ăn|thực phẩm|ăn vặt|cà phê|trà|nước uống|mì|miến|gia vị|muối|trái cây|hoa quả|táo đỏ|khô|sấy|hạt|snack|chocolate|socola)/iu },
  { domain: 'beauty', subcategory: 'lip', pattern: /(?:son môi|son kem|son tint|son lì|son bóng|dưỡng môi|trang điểm môi|lipstick|lip tint|lip balm)/iu },
  { domain: 'beauty', subcategory: 'beauty', pattern: /(?:làm đẹp|trang điểm|mỹ phẩm|kem dưỡng|serum|sữa rửa mặt|kem chống nắng|phấn|mascara|nước hoa|chăm sóc da|makeup)/iu },
  { domain: 'fashion', subcategory: 'fashion', pattern: /(?:(?<![\p{L}\p{N}])áo(?![\p{L}\p{N}])|quần|váy|đầm|giày|dép|túi xách|thời trang|size|kích cỡ)/iu },
  { domain: 'electronics', subcategory: 'electronics', pattern: /(?:màn hình|monitor|điện thoại|laptop|máy tính|tai nghe|loa|bàn phím|chuột|sạc|pin|điện tử|tivi|tv)/iu },
  { domain: 'home', subcategory: 'home', pattern: /(?:gia dụng|nồi|chảo|bếp|máy hút bụi|đèn|bàn|ghế|tủ|chăn|ga|gối|giấy vệ sinh)/iu },
  { domain: 'health', subcategory: 'health', pattern: /(?:thực phẩm chức năng|vitamin|viên uống|khẩu trang|thiết bị y tế|sức khỏe)/iu }
];

const scopedAspectPatterns = [
  { domains: ['beauty'], pattern: /(?:môi|lên màu|bám màu|độ lì|lem son|che phủ)/iu },
  { domains: ['food'], pattern: /(?:hương vị|mùi vị|độ cay|độ ngọt|độ mặn|độ chua|kết cấu khi ăn|khó ăn)/iu },
  { domains: ['fashion'], pattern: /(?:form áo|form quần|đường may|vải|size mặc)/iu },
  { domains: ['electronics'], pattern: /(?:phần cứng|màn hình|hiệu năng|pin|kết nối|âm thanh)/iu }
];

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function categoryText(product = {}) {
  const path = Array.isArray(product.categoryPath) ? product.categoryPath.join(' > ') : product.categoryPath;
  return clean([product.category, path].filter(Boolean).join(' '));
}

function matchDomain(text) {
  return rules.find((rule) => rule.pattern.test(text));
}

export function normalizeProductDomain(value) {
  const domain = clean(value).toLowerCase();
  return DOMAINS.has(domain) ? domain : 'unknown';
}

export function resolveProductDomain(product = {}) {
  const existing = product?.domainResolution;
  if (existing && normalizeProductDomain(existing.domain) !== 'unknown') {
    return {
      domain: normalizeProductDomain(existing.domain),
      subcategory: clean(existing.subcategory) || null,
      confidence: Math.min(1, Math.max(0, Number(existing.confidence) || 0)),
      source: clean(existing.source) || 'provided'
    };
  }

  const category = categoryText(product);
  const categoryMatch = matchDomain(category);
  if (categoryMatch) {
    return { domain: categoryMatch.domain, subcategory: categoryMatch.subcategory, confidence: 0.98, source: 'category' };
  }

  const titleMatch = matchDomain(clean(product.title));
  if (titleMatch) {
    // Tiêu đề là tín hiệu tốt nhưng không tuyệt đối: tên marketing có thể chứa
    // từ của ngành khác. Đồng thuận Layer 2 vẫn được phép sửa kết quả này.
    return { domain: titleMatch.domain, subcategory: titleMatch.subcategory, confidence: 0.78, source: 'title' };
  }
  return { domain: 'unknown', subcategory: null, confidence: 0, source: 'fallback' };
}

export function reconcileProductDomain(baseResolution, votes = [], options = {}) {
  const base = baseResolution || { domain: 'unknown', confidence: 0, source: 'fallback' };
  if (normalizeProductDomain(base.domain) !== 'unknown' && Number(base.confidence) >= 0.8) return base;

  const eligible = votes
    .map((vote) => ({
      domain: normalizeProductDomain(vote?.domain),
      subcategory: clean(vote?.subcategory) || null,
      confidence: Math.min(1, Math.max(0, Number(vote?.confidence) || 0))
    }))
    .filter((vote) => vote.domain !== 'unknown' && vote.confidence >= 0.85);
  const groups = new Map();
  for (const vote of eligible) {
    const current = groups.get(vote.domain) || { domain: vote.domain, votes: [], score: 0 };
    current.votes.push(vote);
    current.score += vote.confidence;
    groups.set(vote.domain, current);
  }
  const winner = [...groups.values()].sort((left, right) => right.votes.length - left.votes.length || right.score - left.score)[0];
  const minimumVotes = Number(options.batchCount) <= 1 ? 1 : 2;
  if (!winner || winner.votes.length < minimumVotes) return base;
  const average = winner.score / winner.votes.length;
  if (minimumVotes === 1 && average < 0.92) return base;
  return {
    domain: winner.domain,
    subcategory: winner.votes.find((vote) => vote.subcategory)?.subcategory || null,
    confidence: average,
    source: 'layer2-consensus'
  };
}

export function aspectCompatibleWithDomain(aspect, resolution) {
  const label = clean(aspect?.label);
  const domain = normalizeProductDomain(resolution?.domain);
  if (!label || domain === 'unknown') return false;
  const scoped = scopedAspectPatterns.find((entry) => entry.pattern.test(label));
  return !scoped || scoped.domains.includes(domain);
}

export function domainAwareSummaryEnabled(value = process.env.DOMAIN_AWARE_SUMMARY) {
  if (value === undefined || value === null || value === '') return true;
  return !['0', 'false', 'off', 'no'].includes(String(value).trim().toLowerCase());
}
