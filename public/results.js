const STORAGE_KEY = 'realview:last-analysis';
const content = document.querySelector('#results-content');
const emptyState = document.querySelector('#results-empty');
const siteHeader = document.querySelector('.site-header');
const navToggle = document.querySelector('.nav-toggle');
const navToggleLabel = document.querySelector('.nav-toggle-label');

function setMobileMenu(open) {
  if (!siteHeader || !navToggle) return;
  siteHeader.classList.toggle('is-menu-open', open);
  navToggle.setAttribute('aria-expanded', String(open));
  if (navToggleLabel) navToggleLabel.textContent = open ? 'Đóng menu' : 'Mở menu';
}

navToggle?.addEventListener('click', () => setMobileMenu(navToggle.getAttribute('aria-expanded') !== 'true'));
document.addEventListener('click', (event) => {
  if (siteHeader?.classList.contains('is-menu-open') && !siteHeader.contains(event.target)) setMobileMenu(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setMobileMenu(false);
});

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function safeUrl(value, fallback = '/#home') {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : fallback;
  } catch {
    return fallback;
  }
}

function safeImageUrl(value) {
  const url = safeUrl(value, '');
  return url && /^https?:/i.test(url) ? url : '';
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

function toneForScore(score) {
  if (score > 80) return { id: 'green', label: 'Độ tin cậy cao' };
  if (score >= 60) return { id: 'yellow', label: 'Khá đáng tin' };
  if (score >= 50) return { id: 'orange', label: 'Nên cân nhắc kỹ' };
  return { id: 'red', label: 'Độ tin cậy thấp' };
}

function fallbackTrust(data, reviews) {
  const included = reviews.filter((review) => review.included !== false);
  const excluded = reviews.filter((review) => review.included === false);
  const average = included.length ? included.reduce((sum, review) => sum + clamp(review.rating, 0, 5), 0) / included.length : 0;
  const usefulRatio = reviews.length ? included.length / reviews.length : 0;
  const verifiedRatio = included.length ? included.filter((review) => review.verified).length / included.length : 0;
  const detailedRatio = included.length ? included.filter((review) => String(review.text || '').length >= 45).length / included.length : 0;
  const score = Math.round(clamp(average / 5 * 55 + usefulRatio * 15 + verifiedRatio * 15 + detailedRatio * 15, 0, 100));
  const tone = toneForScore(score);
  const confidenceScore = Number(data?.stats?.confidenceScore) || Math.round(clamp(18 + Math.min(reviews.length, 30) / 30 * 32 + usefulRatio * 18 + verifiedRatio * 16 + detailedRatio * 16, 0, 97));
  return {
    score,
    tone: tone.id,
    label: tone.label,
    confidence: { score: confidenceScore, label: confidenceScore >= 78 ? 'Cao' : confidenceScore >= 56 ? 'Trung bình' : 'Thấp' },
    summary: data?.verdict || 'Điểm số phản ánh mức hài lòng và chất lượng bằng chứng trong các review hữu ích.',
    pros: [{ title: 'Phản hồi tích cực', detail: `${included.filter((review) => Number(review.rating) >= 4).length} review hữu ích chấm từ 4 sao.`, mentions: included.filter((review) => Number(review.rating) >= 4).length }],
    cons: [{ title: 'Phản hồi cần cân nhắc', detail: `${included.filter((review) => Number(review.rating) <= 3).length} review hữu ích chấm từ 3 sao trở xuống.`, mentions: included.filter((review) => Number(review.rating) <= 3).length }],
    drivers: [
      { impact: usefulRatio >= .6 ? 'up' : 'down', title: 'Tỷ lệ review hữu ích', detail: `${included.length}/${reviews.length} review vượt qua bước giảm nhiễu.` },
      { impact: verifiedRatio >= .6 ? 'up' : 'down', title: 'Khả năng kiểm chứng', detail: `${Math.round(verifiedRatio * 100)}% review giữ lại đến từ người mua đã xác minh.` },
      ...(excluded.length ? [{ impact: 'neutral', title: 'Review đã bị loại', detail: `${excluded.length} phản hồi không được dùng để kết luận sản phẩm.` }] : [])
    ],
    engine: 'rules'
  };
}

function starMarkup(rating) {
  const safeRating = Math.round(clamp(rating, 0, 5));
  return Array.from({ length: 5 }, (_, index) => `<span class="evidence-star ${index < safeRating ? 'is-filled' : ''}" aria-hidden="true">★</span>`).join('');
}

function authorName(review) {
  const author = String(review.author || '').trim();
  return !author || /^\*+$/.test(author) ? 'Người mua Shopee' : author;
}

function reviewCard(review, included, index) {
  const name = authorName(review);
  const initial = name.replace(/\*+/g, '').trim().charAt(0).toLocaleUpperCase('vi') || 'R';
  const rating = Math.round(clamp(review.rating, 0, 5));
  const reason = review.exclusionReason || 'Nội dung chưa đủ thông tin để đưa vào kết quả chính.';
  return `
    <article class="evidence-card ${included ? 'is-kept' : 'is-excluded'}" aria-label="Review ${index + 1}, ${rating} trên 5 sao">
      <header>
        <span class="evidence-avatar" aria-hidden="true">${escapeHtml(initial)}</span>
        <span class="evidence-person"><strong>${escapeHtml(name)}</strong><small>${review.verified ? 'Đã xác minh mua hàng' : 'Chưa có tín hiệu xác minh'} · ${escapeHtml(review.date || 'Không rõ ngày')}</small></span>
        ${review.verified ? '<span class="verified-mark" title="Đã xác minh mua hàng" aria-label="Đã xác minh mua hàng">✓</span>' : ''}
      </header>
      <div class="evidence-stars" role="img" aria-label="${rating} trên 5 sao">${starMarkup(rating)}</div>
      <p>${escapeHtml(review.text || 'Review không có nội dung chữ.')}</p>
      ${included ? '<span class="evidence-label">Được dùng làm bằng chứng</span>' : `<div class="exclusion-reason"><small>Lý do bị loại</small><strong>${escapeHtml(reason)}</strong></div>`}
    </article>`;
}

function emptyReviewState(included) {
  return `<div class="review-empty"><strong>${included ? 'Chưa có review đủ điều kiện' : 'Không có review nào bị loại'}</strong><span>${included ? 'Mẫu dữ liệu hiện tại chưa có phản hồi đủ chi tiết.' : 'Tất cả review thu thập được đều vượt qua bước giảm nhiễu.'}</span></div>`;
}

function renderSentimentList(selector, items) {
  const root = document.querySelector(selector);
  root.innerHTML = items.map((item) => `
    <article class="sentiment-item">
      <span class="sentiment-check" aria-hidden="true">${selector.includes('pros') ? '✓' : '!'}</span>
      <div><h4>${escapeHtml(item.title)}</h4><p>${escapeHtml(item.detail)}</p></div>
      ${Number(item.mentions) > 0 ? `<b>${Math.round(Number(item.mentions))}×</b>` : ''}
    </article>`).join('');
}

function driverIcon(impact) {
  if (impact === 'up') return '↗';
  if (impact === 'down') return '↘';
  return '→';
}

function setupReviewCarousel(root) {
  const track = root?.querySelector('.review-grid');
  const previous = root?.querySelector('.review-carousel-prev');
  const next = root?.querySelector('.review-carousel-next');
  const status = root?.querySelector('.review-carousel-status');
  if (!track || !previous || !next || !status) return;

  const cards = Array.from(track.querySelectorAll('.evidence-card'));
  const cardCount = cards.length;

  function metrics() {
    const firstCard = cards[0];
    const gap = Number.parseFloat(getComputedStyle(track).gap) || 0;
    const cardWidth = firstCard?.getBoundingClientRect().width || track.clientWidth;
    const visibleCards = Math.max(1, Math.round((track.clientWidth + gap) / (cardWidth + gap)));
    return {
      step: (cardWidth + gap) * visibleCards,
      visibleCards,
      maxScroll: Math.max(0, track.scrollWidth - track.clientWidth)
    };
  }

  function updateControls() {
    if (!cardCount) {
      previous.disabled = true;
      next.disabled = true;
      status.textContent = 'Không có review để chuyển';
      return;
    }

    const { visibleCards, maxScroll } = metrics();
    const totalPages = Math.max(1, Math.ceil(cardCount / visibleCards));
    const progress = maxScroll ? track.scrollLeft / maxScroll : 0;
    const currentPage = Math.min(totalPages, Math.round(progress * (totalPages - 1)) + 1);
    previous.disabled = track.scrollLeft <= 2;
    next.disabled = maxScroll - track.scrollLeft <= 2;
    status.textContent = `${cardCount} review · Trang ${currentPage}/${totalPages}`;
  }

  previous.addEventListener('click', () => {
    const { step } = metrics();
    track.scrollBy({ left: -step, behavior: 'smooth' });
  });
  next.addEventListener('click', () => {
    const { step } = metrics();
    track.scrollBy({ left: step, behavior: 'smooth' });
  });
  track.addEventListener('scroll', updateControls, { passive: true });
  root.closest('details')?.addEventListener('toggle', () => requestAnimationFrame(updateControls));
  window.addEventListener('resize', updateControls);
  requestAnimationFrame(updateControls);
}

function renderResult(data) {
  const product = data.product || {};
  const stats = data.stats || {};
  const reviews = Array.isArray(data.reviews) ? data.reviews : [];
  const keptReviews = reviews.filter((review) => review.included !== false);
  const excludedReviews = reviews.filter((review) => review.included === false);
  const trust = data.trust || fallbackTrust(data, reviews);
  const score = Math.round(clamp(trust.score, 0, 100));
  const tone = toneForScore(score);
  const confidenceScore = Math.round(clamp(trust.confidence?.score ?? stats.confidenceScore, 0, 100));
  const confidenceLabel = trust.confidence?.label || stats.confidence || (confidenceScore >= 78 ? 'Cao' : confidenceScore >= 56 ? 'Trung bình' : 'Thấp');
  const platform = String(product.platform || 'Shopee');
  const productUrl = safeUrl(product.url);
  const productTitle = String(product.title || `Sản phẩm đang phân tích trên ${platform}`);

  document.querySelector('#results-platform').textContent = platform.toLocaleUpperCase('vi');
  document.querySelector('#results-title').textContent = productTitle;
  const metaParts = [];
  if (product.price) metaParts.push(String(product.price));
  if (product.rating) metaParts.push(`${product.rating} sao trên sàn`);
  if (product.itemId) metaParts.push(`Mã SP ${product.itemId}`);
  document.querySelector('#product-meta').textContent = metaParts.join(' · ') || 'Phân tích từ review công khai';

  for (const selector of ['#open-product', '#product-inline-link']) document.querySelector(selector).href = productUrl;
  document.querySelector('#open-product span').textContent = `Xem sản phẩm trên ${platform}`;

  const imageUrl = safeImageUrl(product.image);
  if (imageUrl) {
    const image = document.querySelector('#product-image');
    const illustration = document.querySelector('#product-illustration');
    image.src = imageUrl;
    image.alt = `Ảnh ${productTitle}`;
    image.classList.remove('hidden');
    illustration.classList.add('hidden');
    image.addEventListener('error', () => {
      image.classList.add('hidden');
      illustration.classList.remove('hidden');
    }, { once: true });
  }

  document.querySelector('#trust-card').dataset.tone = tone.id;
  document.querySelector('#trust-gauge').style.setProperty('--score', score);
  document.querySelector('#trust-gauge').dataset.scoreLength = String(score).length;
  document.querySelector('#trust-gauge').setAttribute('aria-label', `TrustScore ${score} trên 100`);
  document.querySelector('#trust-score').textContent = score;
  document.querySelector('#action-score').textContent = score;
  document.querySelector('#trust-label').textContent = trust.label || tone.label;
  document.querySelector('#confidence-score').textContent = `${confidenceScore}%`;
  document.querySelector('#confidence-label').textContent = confidenceLabel;
  document.querySelector('#trust-summary').textContent = trust.summary || data.verdict;
  document.querySelector('#analysis-source').textContent = trust.engine === 'gemini' ? 'Gemini AI + bộ lọc RealView' : 'Bộ lọc minh bạch RealView';

  const scanned = Number(stats.scanned ?? reviews.length) || 0;
  const kept = Number(stats.genuine ?? keptReviews.length) || 0;
  const excluded = Number(stats.excluded ?? excludedReviews.length) || 0;
  document.querySelector('#scanned-count').textContent = scanned;
  document.querySelector('#kept-count-top').textContent = kept;
  document.querySelector('#excluded-count-top').textContent = excluded;
  document.querySelector('#kept-count').textContent = kept;
  document.querySelector('#excluded-count').textContent = excluded;

  renderSentimentList('#pros-list', Array.isArray(trust.pros) && trust.pros.length ? trust.pros : fallbackTrust(data, reviews).pros);
  renderSentimentList('#cons-list', Array.isArray(trust.cons) && trust.cons.length ? trust.cons : fallbackTrust(data, reviews).cons);

  const drivers = Array.isArray(trust.drivers) ? trust.drivers : [];
  document.querySelector('#trust-drivers').innerHTML = drivers.map((driver, index) => `
    <article class="driver-card" data-impact="${['up', 'down', 'neutral'].includes(driver.impact) ? driver.impact : 'neutral'}">
      <span class="driver-number">0${index + 1}</span>
      <span class="driver-impact" aria-hidden="true">${driverIcon(driver.impact)}</span>
      <div><small>${driver.impact === 'up' ? 'Nâng điểm' : driver.impact === 'down' ? 'Hạ điểm' : 'Giới hạn kết luận'}</small><h3>${escapeHtml(driver.title)}</h3><p>${escapeHtml(driver.detail)}</p></div>
    </article>`).join('');

  document.querySelector('#kept-list').innerHTML = keptReviews.length ? keptReviews.map((review, index) => reviewCard(review, true, index)).join('') : emptyReviewState(true);
  document.querySelector('#excluded-list').innerHTML = excludedReviews.length ? excludedReviews.map((review, index) => reviewCard(review, false, index)).join('') : emptyReviewState(false);
  document.querySelectorAll('[data-review-carousel]').forEach(setupReviewCarousel);

  content.classList.remove('hidden');
  document.querySelector('#result-action-bar').classList.remove('hidden');
}

let data;
try {
  data = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
} catch {
  data = null;
}

if (data?.reviews && data?.product) renderResult(data);
else emptyState.classList.remove('hidden');

