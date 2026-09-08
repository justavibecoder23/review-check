export const HISTORY_STORAGE_KEY = 'realview:analysis-history-v1';
export const LAST_ANALYSIS_KEY = 'realview:last-analysis';
export const HISTORY_MAX_ITEMS = 10;

const VALID_TONES = new Set(['green', 'yellow', 'orange', 'red', 'neutral']);

function jsonCopy(value, fallback) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function text(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toneFromScore(score) {
  if (score === null) return 'neutral';
  if (score >= 80) return 'green';
  if (score >= 60) return 'yellow';
  if (score >= 50) return 'orange';
  return 'red';
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function historyId(product = {}) {
  const platform = text(product.platform, 'marketplace').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const productId = text(product.itemId || product.productId);
  return productId ? `${platform}_${productId}` : `${platform}_${stableHash(text(product.url))}`;
}

function pruneReview(review = {}) {
  return {
    author: text(review.author),
    rating: finiteNumber(review.rating),
    text: text(review.text),
    date: text(review.date),
    verified: typeof review.verified === 'boolean' ? review.verified : null,
    included: review.included !== false,
    exclusionReason: text(review.exclusionReason),
    labelId: text(review.labelId)
  };
}

export function pruneAnalysisReport(resultData = {}) {
  const product = resultData.product || {};
  return {
    product: {
      platform: text(product.platform),
      url: text(product.url),
      title: text(product.title),
      image: text(product.image || product.imageUrl || product.thumbnail),
      imageUrl: text(product.imageUrl),
      thumbnail: text(product.thumbnail),
      price: text(product.price),
      rating: finiteNumber(product.rating),
      itemId: text(product.itemId),
      productId: text(product.productId)
    },
    stats: {
      scanned: finiteNumber(resultData.stats?.scanned),
      included: finiteNumber(resultData.stats?.included),
      genuine: finiteNumber(resultData.stats?.genuine),
      excluded: finiteNumber(resultData.stats?.excluded),
      unverified: finiteNumber(resultData.stats?.unverified),
      lowRatings: finiteNumber(resultData.stats?.lowRatings)
    },
    trust: jsonCopy({
      score: resultData.trust?.score ?? null,
      scoreStatus: resultData.trust?.scoreStatus,
      label: resultData.trust?.label,
      tone: resultData.trust?.tone,
      summary: resultData.trust?.summary,
      pros: resultData.trust?.pros,
      cons: resultData.trust?.cons,
      drivers: resultData.trust?.drivers,
      method: resultData.trust?.method,
      engine: resultData.trust?.engine
    }, {}),
    verdict: text(resultData.verdict),
    issues: jsonCopy(Array.isArray(resultData.issues) ? resultData.issues : [], []),
    reviews: (Array.isArray(resultData.reviews) ? resultData.reviews : []).map(pruneReview),
    source: {
      type: text(resultData.source?.type),
      label: text(resultData.source?.label)
    },
    warnings: jsonCopy(Array.isArray(resultData.warnings) ? resultData.warnings : [], [])
  };
}

function normalizeHistoryItem(item) {
  if (!item || typeof item !== 'object' || !item.fullReport?.product || !Array.isArray(item.fullReport?.reviews)) return null;
  const analyzedAt = new Date(item.analyzedAt);
  if (!Number.isFinite(analyzedAt.getTime())) return null;
  const score = finiteNumber(item.score);
  return {
    id: text(item.id),
    platform: text(item.platform, 'Marketplace'),
    url: text(item.url),
    title: text(item.title, 'Sản phẩm đã phân tích'),
    image: text(item.image),
    price: text(item.price),
    score: score === null ? null : Math.round(Math.min(100, Math.max(0, score))),
    tone: VALID_TONES.has(item.tone) ? item.tone : toneFromScore(score),
    stats: {
      scanned: Math.max(0, Math.round(finiteNumber(item.stats?.scanned) || 0)),
      kept: Math.max(0, Math.round(finiteNumber(item.stats?.kept) || 0)),
      excluded: Math.max(0, Math.round(finiteNumber(item.stats?.excluded) || 0))
    },
    analyzedAt: analyzedAt.toISOString(),
    fullReport: item.fullReport
  };
}

function browserStorage(storage) {
  if (storage) return storage;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getHistory({ storage } = {}) {
  const target = browserStorage(storage);
  if (!target) return [];
  try {
    const parsed = JSON.parse(target.getItem(HISTORY_STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeHistoryItem).filter((item) => item?.id).slice(0, HISTORY_MAX_ITEMS);
  } catch {
    return [];
  }
}

function persistWithEviction(items, storage) {
  let candidates = items.slice(0, HISTORY_MAX_ITEMS);
  while (candidates.length) {
    try {
      storage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(candidates));
      return candidates;
    } catch {
      candidates = candidates.slice(0, Math.max(0, candidates.length - 2));
    }
  }
  try {
    storage.removeItem(HISTORY_STORAGE_KEY);
  } catch {
    // Lịch sử là tính năng phụ; lỗi bộ nhớ không được chặn trang kết quả.
  }
  return [];
}

export function saveToHistory(resultData, { storage, now = () => new Date() } = {}) {
  const target = browserStorage(storage);
  if (!target || !resultData?.product || !Array.isArray(resultData?.reviews)) return null;
  const fullReport = pruneAnalysisReport(resultData);
  const product = fullReport.product;
  if (!product.url && !product.itemId && !product.productId) return null;
  const score = finiteNumber(fullReport.trust?.score);
  const stats = fullReport.stats || {};
  const item = normalizeHistoryItem({
    id: historyId(product),
    platform: product.platform,
    url: product.url,
    title: product.title,
    image: product.image,
    price: product.price,
    score,
    tone: VALID_TONES.has(fullReport.trust?.tone) ? fullReport.trust.tone : toneFromScore(score),
    stats: {
      scanned: stats.scanned ?? fullReport.reviews.length,
      kept: stats.included ?? stats.genuine ?? fullReport.reviews.filter((review) => review.included).length,
      excluded: stats.excluded ?? fullReport.reviews.filter((review) => !review.included).length
    },
    analyzedAt: now().toISOString(),
    fullReport
  });
  if (!item) return null;
  const history = getHistory({ storage: target }).filter((entry) => entry.id !== item.id);
  const saved = persistWithEviction([item, ...history], target);
  return saved.find((entry) => entry.id === item.id) || null;
}

export function getHistoryItem(id, options = {}) {
  return getHistory(options).find((item) => item.id === String(id)) || null;
}

export function restoreHistoryItem(id, { storage, session, navigate } = {}) {
  const item = getHistoryItem(id, { storage });
  if (!item) return false;
  try {
    const sessionTarget = session || window.sessionStorage;
    sessionTarget.setItem(LAST_ANALYSIS_KEY, JSON.stringify(item.fullReport));
    if (typeof navigate === 'function') navigate('/results.html');
    else window.location.assign('/results.html');
    return true;
  } catch {
    return false;
  }
}

export function deleteHistoryItem(id, { storage } = {}) {
  const target = browserStorage(storage);
  if (!target) return [];
  const history = getHistory({ storage: target }).filter((item) => item.id !== String(id));
  persistWithEviction(history, target);
  return history;
}

export function clearHistory({ storage } = {}) {
  const target = browserStorage(storage);
  if (!target) return;
  try {
    target.removeItem(HISTORY_STORAGE_KEY);
  } catch {
    // Không làm gián đoạn trang nếu trình duyệt chặn localStorage.
  }
}

export function formatRelativeTime(isoString, now = new Date()) {
  const date = new Date(isoString);
  if (!Number.isFinite(date.getTime())) return '';
  const difference = Math.max(0, now.getTime() - date.getTime());
  const minutes = Math.floor(difference / 60_000);
  if (minutes < 1) return 'Vừa xong';
  if (minutes < 60) return `${minutes} phút trước`;
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((startToday - startDate) / 86_400_000);
  const time = new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit' }).format(date);
  if (days === 0) return `Hôm nay, ${time}`;
  if (days === 1) return 'Hôm qua';
  if (days < 7) return `${days} ngày trước`;
  return new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
}
