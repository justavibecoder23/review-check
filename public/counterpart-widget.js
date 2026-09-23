const STORAGE_KEY = 'realview:last-analysis';
const SESSION_PREFIX = 'realview:counterpart:v3:';
const READY_TOAST_DURATION_MS = 5_000;
const section = document.querySelector('#counterpart-section');
const comparison = document.querySelector('#counterpart-comparison');
const targetHeading = document.querySelector('#counterpart-target-heading');
const toast = document.querySelector('#counterpart-toast');
const toastMark = toast?.querySelector('.counterpart-toast-mark');
const toastTitle = document.querySelector('#counterpart-toast-title');
const toastCopy = document.querySelector('#counterpart-toast-copy');
const progressButton = document.querySelector('#counterpart-progress');
const progressTitle = document.querySelector('#counterpart-progress-title');
const progressCopy = document.querySelector('#counterpart-progress-copy');
const progressBar = document.querySelector('#counterpart-progress-bar');

let currentSource = null;
let currentMatch = null;
let activeSourceKey = '';
let toastTimer;
let stylesheetPromise;
let requestController;
let pendingToastPlatform = '';
let progressTimer;
let progressReadyTimer;
let progressValue = 0;

function ensureStylesheet() {
  if (stylesheetPromise) return stylesheetPromise;
  const existing = document.querySelector('link[data-counterpart-styles]');
  if (existing) return Promise.resolve();
  stylesheetPromise = new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/counterpart-widget.css?v=16';
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

function targetPlatformName(sourcePlatform) {
  return platformName(sourcePlatform) === 'Shopee' ? 'TikTok Shop' : 'Shopee';
}

function setProgressPlatformTone(platform) {
  progressButton?.classList.toggle('counterpart-progress--tiktok', platformName(platform) === 'TikTok Shop');
}

function titleFromProductUrl(value) {
  try {
    const parts = new URL(String(value || '')).pathname.split('/').filter(Boolean);
    const pdpIndex = parts.findIndex((part) => part.toLowerCase() === 'pdp');
    const slug = pdpIndex >= 0 ? parts[pdpIndex + 1] : '';
    if (!slug || /^product$/i.test(slug)) return '';
    return decodeURIComponent(slug).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

function sourceFromResult(result = {}) {
  const product = result.product || {};
  const url = safeUrl(product.url || product.originalUrl);
  return {
    platform: platformName(product.platform),
    title: String(product.title || titleFromProductUrl(url)).trim(),
    url,
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
  window.clearInterval(progressTimer);
  window.clearTimeout(progressReadyTimer);
  progressValue = 0;
  if (progressButton) {
    progressButton.hidden = true;
    progressButton.disabled = true;
    progressButton.classList.add('hidden');
    progressButton.classList.remove('is-searching', 'is-ready', 'is-unavailable', 'counterpart-progress--tiktok');
  }
  if (progressBar) progressBar.style.width = '0%';
  toast?.classList.add('hidden');
  if (toast) toast.hidden = true;
  section?.classList.add('hidden');
  if (section) {
    section.hidden = true;
    section.setAttribute('aria-hidden', 'true');
  }
  if (comparison) comparison.innerHTML = '';
}

function setProgress(value) {
  progressValue = Math.max(0, Math.min(100, Number(value) || 0));
  if (progressBar) progressBar.style.width = `${progressValue}%`;
  progressButton?.setAttribute('aria-valuenow', String(Math.round(progressValue)));
}

async function showSearchProgress(platform, options = {}) {
  if (!progressButton) return;
  await ensureStylesheet();
  if (currentMatch) return;
  window.clearInterval(progressTimer);
  window.clearTimeout(progressReadyTimer);
  progressButton.hidden = false;
  progressButton.disabled = true;
  progressButton.classList.remove('hidden', 'is-ready', 'is-unavailable');
  progressButton.classList.add('is-searching');
  progressButton.setAttribute('role', 'progressbar');
  progressButton.setAttribute('aria-valuemin', '0');
  progressButton.setAttribute('aria-valuemax', '100');
  progressButton.setAttribute('aria-label', `Đang tìm sản phẩm tương tự trên ${platform}`);
  if (progressTitle) progressTitle.textContent = 'Đang tìm sản phẩm tương tự trên nền tảng khác';
  if (progressCopy) progressCopy.textContent = options.metadataOnly
    ? `Đang tìm theo tên và thông tin sản phẩm trên ${platform}`
    : `Đang đối chiếu hình ảnh và thông tin trên ${platform}`;
  setProgress(7);
  progressTimer = window.setInterval(() => {
    const remaining = 88 - progressValue;
    if (remaining <= 0) return;
    setProgress(progressValue + Math.max(.6, remaining / 15));
  }, 650);
}

function completeProgress(platform) {
  if (!progressButton) return;
  setProgressPlatformTone(platform);
  window.clearInterval(progressTimer);
  window.clearTimeout(progressReadyTimer);
  progressButton.hidden = false;
  progressButton.disabled = true;
  progressButton.classList.remove('hidden', 'is-unavailable');
  progressButton.classList.add('is-searching');
  setProgress(100);
  const revealReadyState = () => {
    if (!currentMatch) return;
    progressButton.disabled = false;
    progressButton.classList.remove('is-searching');
    progressButton.classList.add('is-ready');
    progressButton.removeAttribute('role');
    progressButton.removeAttribute('aria-valuemin');
    progressButton.removeAttribute('aria-valuemax');
    progressButton.removeAttribute('aria-valuenow');
    progressButton.setAttribute('aria-label', `Đã tìm thấy sản phẩm tương tự trên ${platform}. Nhấn để xem`);
    if (progressTitle) progressTitle.textContent = `Đã tìm thấy sản phẩm tương tự trên ${platform}`;
    if (progressCopy) progressCopy.textContent = 'Nhấn để xem và đối chiếu hai sản phẩm';
  };
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) revealReadyState();
  else progressReadyTimer = window.setTimeout(revealReadyState, 520);
}

async function showProgressUnavailable(result) {
  if (!progressButton) return;
  await ensureStylesheet();
  window.clearInterval(progressTimer);
  window.clearTimeout(progressReadyTimer);
  setProgress(100);
  progressButton.hidden = false;
  progressButton.disabled = true;
  progressButton.classList.remove('hidden', 'is-searching', 'is-ready');
  progressButton.classList.add('is-unavailable');
  progressButton.removeAttribute('role');
  progressButton.removeAttribute('aria-valuemin');
  progressButton.removeAttribute('aria-valuemax');
  progressButton.removeAttribute('aria-valuenow');
  progressButton.setAttribute('aria-label', 'Chưa tìm thấy sản phẩm tương tự phù hợp');
  if (progressTitle) progressTitle.textContent = 'Chưa tìm thấy sản phẩm tương tự phù hợp';
  if (progressCopy) progressCopy.textContent = result?.reason === 'rate_limited'
    ? 'Tìm kiếm đang tạm dừng, bạn có thể thử lại sau'
    : 'Bạn vẫn có thể tiếp tục xem kết quả phân tích hiện tại';
}

async function showMetadataUnavailable(platform) {
  if (!progressButton) return;
  await ensureStylesheet();
  window.clearInterval(progressTimer);
  window.clearTimeout(progressReadyTimer);
  progressButton.hidden = false;
  progressButton.disabled = true;
  progressButton.classList.remove('hidden', 'is-searching', 'is-ready');
  progressButton.classList.add('is-unavailable');
  progressButton.removeAttribute('role');
  progressButton.removeAttribute('aria-valuemin');
  progressButton.removeAttribute('aria-valuemax');
  progressButton.removeAttribute('aria-valuenow');
  progressButton.setAttribute('aria-label', 'Chưa lấy được ảnh sản phẩm để đối chiếu');
  setProgress(100);
  if (progressTitle) progressTitle.textContent = 'Chưa lấy được ảnh sản phẩm để đối chiếu';
  if (progressCopy) progressCopy.textContent = `Kết quả phân tích vẫn dùng bình thường; RealView chưa gửi yêu cầu tìm kiếm sang ${platform}`;
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
  const platformKey = platform === 'Shopee' ? 'shopee' : 'tiktok';
  const platformIcon = platformKey === 'shopee'
    ? '<svg class="counterpart-platform-icon" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M8.2 11.5h15.6l1.3 15H6.9l1.3-15Z" /><path d="M11.5 12V8.8a4.5 4.5 0 0 1 9 0V12" /><path d="M20.2 16.1c-1.1-.7-2.4-1.1-3.8-1.1-2 0-3.4.9-3.4 2.3 0 3.1 7.2 1.5 7.2 5.2 0 1.6-1.4 2.7-3.8 2.7-1.6 0-3.1-.5-4.3-1.4" /></svg>'
    : '<svg class="counterpart-platform-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M14 4v10.2a4.2 4.2 0 1 1-3.4-4.1" /><path d="M14 4c.7 2.4 2.4 3.8 5 4" /></svg>';
  const reviewCount = Number(product.reviewCount);
  const facts = [
    Number.isFinite(reviewCount) ? fact('Review', new Intl.NumberFormat('vi-VN').format(reviewCount)) : '',
    Number(product.rating) > 0 ? fact('Đánh giá', `${Number(product.rating).toFixed(1).replace('.', ',')} ★`) : '',
    priceLabel(product.price) ? fact('Giá', priceLabel(product.price)) : ''
  ].filter(Boolean).join('');
  return `
    <article class="counterpart-product-card counterpart-product-card--${platformKey}${options.match ? ' counterpart-product-card--match' : ''}">
      <div class="counterpart-media-column">
        <span class="counterpart-platform-tag">${platformIcon}<span>${escapeHtml(platform)}</span></span>
        <div class="counterpart-product-image">
          ${image ? `<img src="${escapeHtml(image)}" alt="Ảnh ${escapeHtml(product.title)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" />` : ''}
        </div>
      </div>
      <div class="counterpart-product-copy">
        <p class="counterpart-card-kicker">${options.match ? 'Kết quả gần giống nhất' : 'Sản phẩm vừa phân tích'}</p>
        <h3>${escapeHtml(product.title || `Sản phẩm trên ${platform}`)}</h3>
        ${facts ? `<div class="counterpart-facts${options.match ? ' counterpart-facts--match' : ''}">${facts}</div>` : ''}
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
  const sourcePlatform = platformName(currentSource.platform);
  const targetPlatform = platformName(currentMatch.targetPlatform || candidate.platform);
  const bridgeLabel = sourcePlatform && targetPlatform
    ? `Đối chiếu từ ${sourcePlatform} sang ${targetPlatform}`
    : 'Đối chiếu từ nền tảng gốc sang nền tảng còn lại';
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
      <span class="counterpart-bridge-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M4 6h16" /><path d="m16 2 4 4-4 4" /><path d="M20 18H4" /><path d="M8 14 4 18l4 4" /></svg></span>
      <span>${escapeHtml(bridgeLabel)}</span>
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

function revealSection() {
  if (!currentMatch) return;
  clearTimeout(toastTimer);
  toast?.classList.add('hidden');
  if (toast) toast.hidden = true;
  renderSection();
  section.hidden = false;
  section.setAttribute('aria-hidden', 'false');
  section.classList.remove('hidden');
}

function showSection() {
  revealSection();
  if (!currentMatch) return;
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
  }, READY_TOAST_DURATION_MS);
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
  completeProgress(platform);
  revealSection();
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
  if (!source.platform || !source.url) return;
  const key = sourceKey(source);
  if (key === activeSourceKey) return;
  activeSourceKey = key;
  currentSource = source;
  resetWidget();
  if (!source.title) {
    void showMetadataUnavailable(targetPlatformName(source.platform));
    return;
  }
  const stored = readStoredMatch(key);
  if (stored) announceReady(stored);
  else void showSearchProgress(targetPlatformName(source.platform), { metadataOnly: !source.image });
  deferWork(() => {
    if (activeSourceKey !== key) return;
    requestController = new AbortController();
    requestMatch(source, requestController.signal)
      .then((match) => {
        if (!match || activeSourceKey !== key) return;
        if (match.status !== 'ready') {
          if (!stored) {
            void showProgressUnavailable(match);
            showStatusToast(match);
          }
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
      .catch((error) => {
        if (error?.name !== 'AbortError' && activeSourceKey === key && !stored) {
          void showProgressUnavailable({ reason: 'search_failed' });
        }
      });
  });
}

progressButton?.addEventListener('click', showSection);
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
