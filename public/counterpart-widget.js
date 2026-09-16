const STORAGE_KEY = 'realview:last-analysis';
const SESSION_PREFIX = 'realview:counterpart:v3:';
const actionBar = document.querySelector('#result-action-bar');
const dockButton = document.querySelector('#counterpart-dock-button');
const section = document.querySelector('#counterpart-section');
const comparison = document.querySelector('#counterpart-comparison');
const targetHeading = document.querySelector('#counterpart-target-heading');
const toast = document.querySelector('#counterpart-toast');
const toastMark = toast?.querySelector('.counterpart-toast-mark');
const toastTitle = document.querySelector('#counterpart-toast-title');
const toastCopy = document.querySelector('#counterpart-toast-copy');
const closeButton = document.querySelector('#counterpart-section-close');

let currentSource = null;
let currentMatch = null;
let activeSourceKey = '';
let toastTimer;
let stylesheetPromise;
let requestController;
let pendingToastPlatform = '';

function ensureStylesheet() {
  if (stylesheetPromise) return stylesheetPromise;
  const existing = document.querySelector('link[data-counterpart-styles]');
  if (existing) return Promise.resolve();
  stylesheetPromise = new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/counterpart-widget.css?v=5';
    link.dataset.counterpartStyles = 'true';
    link.addEventListener('load', resolve, { once: true });
    link.addEventListener('error', resolve, { once: true });
    document.head.append(link);
  });
  return stylesheetPromise;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function safeUrl(value, fallback = '') {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.href : fallback;
  } catch {
    return fallback;
  }
}

function platformName(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized.includes('tiktok')) return 'TikTok Shop';
  if (normalized.includes('shopee')) return 'Shopee';
  return '';
}

function sourceFromResult(result = {}) {
  const product = result.product || {};
  return {
    platform: platformName(product.platform),
    title: String(product.title || '').trim(),
    url: safeUrl(product.url || product.originalUrl),
    image: safeUrl(product.image || product.imageUrl || product.thumbnail),
    itemId: String(product.itemId || ''),
    productId: String(product.productId || ''),
    resultId: String(result.chatContext?.resultId || result.resultId || ''),
    analysisCompletedAt: new Date().toISOString()
  };
}

function sourceKey(source) {
  return encodeURIComponent(`${source.platform}:${source.itemId || source.productId || source.url}:${source.image}`).slice(0, 900);
}

function readStoredResult() {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    return null;
  }
}

function readStoredMatch(key) {
  try {
    const value = JSON.parse(sessionStorage.getItem(`${SESSION_PREFIX}${key}`) || 'null');
    if (value?.status !== 'ready') return null;
    const generatedAt = Date.parse(value.generatedAt || '');
    const maximumAge = value.candidate?.hasEnoughReviews === false ? 12 * 60 * 60 * 1_000 : 7 * 24 * 60 * 60 * 1_000;
    if (!Number.isFinite(generatedAt) || Date.now() - generatedAt > maximumAge) {
      sessionStorage.removeItem(`${SESSION_PREFIX}${key}`);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function storeMatch(key, value) {
  try { sessionStorage.setItem(`${SESSION_PREFIX}${key}`, JSON.stringify(value)); } catch { /* Redis still prevents repeated Actor work. */ }
}

function deferWork(callback) {
  if ('requestIdleCallback' in window) window.requestIdleCallback(callback, { timeout: 1_500 });
  else window.setTimeout(callback, 550);
}

function resetWidget() {
  currentMatch = null;
  requestController?.abort();
  requestController = null;
  clearTimeout(toastTimer);
  pendingToastPlatform = '';
  toast?.classList.add('hidden');
  if (toast) toast.hidden = true;
  section?.classList.add('hidden');
  if (section) {
    section.hidden = true;
    section.setAttribute('aria-hidden', 'true');
  }
  dockButton?.classList.add('hidden');
  if (dockButton) dockButton.hidden = true;
  dockButton?.classList.remove('is-ready');
  actionBar?.classList.remove('has-counterpart');
  document.body.classList.remove('counterpart-ready');
  if (comparison) comparison.innerHTML = '';
}

function fact(label, value) {
  if (value === null || value === undefined || value === '') return '';
  return `<span class="counterpart-fact">${escapeHtml(label)} <strong>${escapeHtml(value)}</strong></span>`;
}

function priceLabel(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const numeric = Number(raw.replace(/[^\d.]/g, ''));
  if (/^\d+(?:\.\d+)?$/.test(raw) && Number.isFinite(numeric) && numeric >= 1_000) {
    return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(numeric);
  }
  return raw.slice(0, 50);
}

function renderProductCard(product, options = {}) {
  const image = safeUrl(product.image);
  const url = safeUrl(product.url, '/#trang-chu');
  const platform = platformName(product.platform);
  const reviewCount = Number(product.reviewCount);
  const facts = [
    Number.isFinite(reviewCount) ? fact('Review', new Intl.NumberFormat('vi-VN').format(reviewCount)) : '',
    Number(product.rating) > 0 ? fact('Đánh giá', `${Number(product.rating).toFixed(1).replace('.', ',')} ★`) : '',
    priceLabel(product.price) ? fact('Giá', priceLabel(product.price)) : '',
    options.match ? fact('Mức khớp', `${Number(product.similarityPercent) || 0}%`) : ''
  ].filter(Boolean).join('');
  return `
    <article class="counterpart-product-card${options.match ? ' counterpart-product-card--match' : ''}">
      <div class="counterpart-product-image">
        ${image ? `<img src="${escapeHtml(image)}" alt="Ảnh ${escapeHtml(product.title)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" />` : ''}
        <span class="counterpart-platform-tag">${escapeHtml(platform)}</span>
      </div>
      <div>
        <p class="counterpart-card-kicker">${options.match ? 'Kết quả gần giống nhất' : 'Sản phẩm vừa phân tích'}</p>
        <h3>${escapeHtml(product.title || `Sản phẩm trên ${platform}`)}</h3>
        ${product.shopName ? `<p class="counterpart-shop">Gian hàng: ${escapeHtml(product.shopName)}</p>` : ''}
        ${facts ? `<div class="counterpart-facts">${facts}</div>` : ''}
        <a class="counterpart-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">
          Xem trang sản phẩm
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M14 5h5v5M10 14 19 5M19 14v5H5V5h5" /></svg>
        </a>
      </div>
    </article>`;
}

function renderSection() {
  if (!comparison || !currentSource || !currentMatch?.candidate) return;
  const candidate = currentMatch.candidate;
  const targetPlatform = platformName(currentMatch.targetPlatform || candidate.platform);
  const hasEnoughReviews = candidate.hasEnoughReviews !== false && Number(candidate.reviewCount) >= Number(candidate.minimumReviewCount || 20);
  const analysisAvailable = currentMatch.analysisAvailability?.enabled !== false;
  const notice = !analysisAvailable
    ? `<strong>Hệ thống lấy review ${escapeHtml(targetPlatform)} đang bảo trì.</strong> Bạn vẫn có thể đối chiếu sản phẩm; nếu chọn phân tích, RealView sẽ thông báo trạng thái bảo trì.`
    : hasEnoughReviews
    ? `<strong>${Number(candidate.reviewCount).toLocaleString('vi-VN')} review công khai.</strong> Sản phẩm đáp ứng ngưỡng dữ liệu ban đầu để bắt đầu phân tích.`
    : `<strong>Hiện chỉ ghi nhận ${Number(candidate.reviewCount || 0).toLocaleString('vi-VN')} review.</strong> Bạn vẫn có thể phân tích; RealView sẽ dừng và thông báo nếu không đủ 20 review có nội dung như khi dán link ở trang chủ.`;
  const analyzeUrl = `/ket-qua?url=${encodeURIComponent(candidate.url)}`;
  targetHeading.textContent = targetPlatform;
  comparison.innerHTML = `
    ${renderProductCard(currentSource)}
    <div class="counterpart-bridge" aria-label="Đối chiếu hai sản phẩm">
      <span class="counterpart-bridge-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M8 7h11l-3-3M16 17H5l3 3" /><path d="M19 7v4M5 17v-4" /></svg></span>
      <span>Khớp ảnh trước, tên và model sau</span>
    </div>
    ${renderProductCard(candidate, { match: true })}
    <div class="counterpart-actions">
      <div class="counterpart-notice${hasEnoughReviews && analysisAvailable ? '' : ' counterpart-notice--warning'}">
        <span class="counterpart-notice-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">${hasEnoughReviews && analysisAvailable ? '<path d="m5 13 4 4L19 7" />' : '<path d="M12 8v5M12 17h.01" /><path d="M10.3 4.8 3.5 17a2 2 0 0 0 1.8 3h13.4a2 2 0 0 0 1.8-3L13.7 4.8a2 2 0 0 0-3.4 0Z" />'}</svg>
        </span>
        <span>${notice}</span>
      </div>
      <a class="counterpart-analyze-button" href="${escapeHtml(analyzeUrl)}">
        Phân tích sản phẩm này
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
      </a>
    </div>`;
}

function showSection() {
  if (!currentMatch) return;
  clearTimeout(toastTimer);
  toast?.classList.add('hidden');
  if (toast) toast.hidden = true;
  renderSection();
  section.hidden = false;
  section.setAttribute('aria-hidden', 'false');
  section.classList.remove('hidden');
  requestAnimationFrame(() => {
    section.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    window.setTimeout(() => section.focus({ preventScroll: true }), 500);
  });
}

function trustIntroIsOpen() {
  const dialog = document.querySelector('#trust-intro-dialog');
  return Boolean(dialog?.open || dialog?.hasAttribute('open'));
}

function showReadyToast(platform) {
  if (!toast || !currentMatch) return;
  pendingToastPlatform = '';
  toast.classList.remove('counterpart-toast--status');
  toast.setAttribute('role', 'button');
  toast.setAttribute('tabindex', '0');
  toast.setAttribute('aria-label', 'Mở sản phẩm tương tự');
  if (toastMark) toastMark.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><path d="m5 13 4 4L19 7" /></svg>';
  if (toastTitle) toastTitle.textContent = 'Đã tìm thấy sản phẩm tương tự';
  if (toastCopy) toastCopy.textContent = `Một lựa chọn trên ${platform} đã sẵn sàng để đối chiếu`;
  toast.hidden = false;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.classList.add('hidden');
    toast.hidden = true;
  }, 7_500);
}

function showStatusToast(result) {
  if (!toast) return;
  const messages = {
    rate_limited: ['Đã tạm dừng tìm kiếm', 'Vui lòng thử lại sau ít phút.'],
    no_verified_visual_match: ['Chưa tìm thấy sản phẩm đủ giống', 'RealView không hiển thị kết quả khi hình ảnh chưa đủ tin cậy.'],
    missing_search_terms: ['Chưa đủ dữ liệu để tìm kiếm', 'Tên sản phẩm hiện chưa cung cấp đủ tín hiệu đối chiếu.'],
    search_failed: ['Tìm kiếm chưa hoàn tất', 'Dịch vụ đối chiếu đang tạm thời không phản hồi.'],
    redis_not_configured: ['Tìm kiếm đang tạm dừng', 'Hệ thống lưu trạng thái hiện chưa sẵn sàng.']
  };
  const [title, copy] = messages[result?.reason] || ['Chưa tìm thấy sản phẩm tương tự', 'Bạn vẫn có thể tiếp tục xem kết quả phân tích hiện tại.'];
  currentMatch = null;
  toast.classList.add('counterpart-toast--status');
  toast.setAttribute('role', 'status');
  toast.setAttribute('tabindex', '-1');
  toast.removeAttribute('aria-label');
  if (toastMark) toastMark.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><path d="M12 8v5M12 17h.01" /><circle cx="12" cy="12" r="9" /></svg>';
  if (toastTitle) toastTitle.textContent = title;
  if (toastCopy) toastCopy.textContent = copy;
  toast.hidden = false;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.classList.add('hidden');
    toast.hidden = true;
  }, 7_500);
}

function announceWhenVisible(platform) {
  const dialog = document.querySelector('#trust-intro-dialog');
  if (!trustIntroIsOpen()) {
    showReadyToast(platform);
    return;
  }
  pendingToastPlatform = platform;
  dialog.addEventListener('close', () => {
    if (pendingToastPlatform === platform && currentMatch) showReadyToast(platform);
  }, { once: true });
}

async function announceReady(result) {
  currentMatch = result;
  await ensureStylesheet();
  if (currentMatch !== result) return;
  const platform = platformName(result.targetPlatform || result.candidate?.platform);
  dockButton.querySelector('span').textContent = `Xem sản phẩm này trên ${platform}`;
  dockButton.setAttribute('aria-label', `Xem sản phẩm này trên ${platform}`);
  dockButton.hidden = false;
  dockButton.classList.remove('hidden');
  dockButton.classList.remove('is-ready');
  actionBar.classList.add('has-counterpart');
  document.body.classList.add('counterpart-ready');
  requestAnimationFrame(() => dockButton.classList.add('is-ready'));
  announceWhenVisible(platform);
}

function abortableDelay(milliseconds, signal) {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const timer = window.setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    function onAbort() {
      window.clearTimeout(timer);
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function readJob(jobId, signal) {
  const response = await fetch(`/api/match-counterpart?jobId=${encodeURIComponent(jobId)}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal
  });
  const result = await response.json().catch(() => null);
  if (!response.ok && response.status !== 202) return null;
  return result;
}

async function requestMatch(source, signal) {
  const response = await fetch('/api/match-counterpart', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source }),
    signal
  });
  let result = await response.json().catch(() => null);
  if (!response.ok && response.status !== 202) {
    return result || { status: 'unavailable', reason: response.status === 429 ? 'rate_limited' : 'search_failed' };
  }
  const jobId = result?.jobId;
  const deadline = Date.now() + 230_000;
  let pollAttempt = 0;
  while (jobId && !['ready', 'unavailable', 'disabled'].includes(result?.status) && Date.now() < deadline) {
    const serverDelay = Math.max(1_200, Number(result?.retryAfterMs) || 2_500);
    const backoffDelay = Math.min(5_000, serverDelay * Math.max(1, 1 + (pollAttempt * 0.35)));
    await abortableDelay(document.hidden ? Math.max(5_000, backoffDelay) : backoffDelay, signal);
    pollAttempt += 1;
    result = await readJob(jobId, signal);
    if (!result) return { status: 'unavailable', reason: 'search_failed' };
  }
  if (result?.status !== 'ready') return result || { status: 'unavailable', reason: 'search_failed' };
  if (!result.candidate?.url || !['exact', 'variant'].includes(result.candidate.matchClass)) {
    return { ...result, status: 'unavailable', reason: 'no_verified_visual_match' };
  }
  return result;
}

function beginForResult(result) {
  const source = sourceFromResult(result);
  if (!source.platform || !source.title || !source.url || !source.image) return;
  const key = sourceKey(source);
  if (key === activeSourceKey) return;
  activeSourceKey = key;
  currentSource = source;
  resetWidget();
  const stored = readStoredMatch(key);
  if (stored) announceReady(stored);
  deferWork(() => {
    if (activeSourceKey !== key) return;
    requestController = new AbortController();
    requestMatch(source, requestController.signal)
      .then((match) => {
        if (!match || activeSourceKey !== key) return;
        if (match.status !== 'ready') {
          if (!stored) showStatusToast(match);
          return;
        }
        storeMatch(key, match);
        if (stored) {
          currentMatch = match;
          if (section && !section.hidden) renderSection();
          return;
        }
        announceReady(match);
      })
      .catch(() => { /* Matching is optional and must never disturb the result page. */ });
  });
}

dockButton?.addEventListener('click', showSection);
closeButton?.addEventListener('click', () => {
  if (!section) return;
  section.hidden = true;
  section.setAttribute('aria-hidden', 'true');
  section.classList.add('hidden');
  dockButton?.focus({ preventScroll: true });
});
toast?.addEventListener('click', showSection);
toast?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    showSection();
  }
});
window.addEventListener('realview:analysis-result', (event) => beginForResult(event.detail?.result));
window.addEventListener('realview:counterpart-source', (event) => beginForResult(event.detail?.result));

if (!new URLSearchParams(window.location.search).has('url')) {
  const restoredResult = readStoredResult();
  if (restoredResult?.product && restoredResult?.reviews) beginForResult(restoredResult);
}
