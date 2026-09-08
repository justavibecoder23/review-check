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
  return url && /^https:/i.test(url) ? url : '';
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

function conciseSummary(value, limit = 175) {
  const text = String(value || '').trim();
  if (!text || text.length <= limit) return text;
  const firstSentence = text.match(/^.*?[.!?](?:\s|$)/u)?.[0]?.trim();
  if (firstSentence && firstSentence.length <= limit) return firstSentence;
  const clipped = text.slice(0, limit);
  const boundary = clipped.lastIndexOf(' ');
  return `${clipped.slice(0, boundary > 90 ? boundary : limit).trim()}…`;
}

function methodScore(value, suffix = '/100') {
  if (value === null || value === undefined || value === '') return '—';
  return Number.isFinite(Number(value)) ? `${Math.round(Number(value))}${suffix}` : '—';
}

function toneForScore(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return { id: 'neutral', label: 'Chưa đủ bằng chứng' };
  if (score >= 80) return { id: 'green', label: 'Độ tin cậy cao' };
  if (score >= 60) return { id: 'yellow', label: 'Khá đáng tin' };
  if (score >= 50) return { id: 'orange', label: 'Nên cân nhắc kỹ' };
  return { id: 'red', label: 'Độ tin cậy thấp' };
}

function renderScoreLegend(score) {
  const tone = toneForScore(score);
  document.querySelectorAll('[data-score-tone]').forEach((item) => {
    const current = item.dataset.scoreTone === tone.id;
    item.classList.toggle('is-current', current);
    if (current) {
      item.setAttribute('aria-current', 'true');
    } else {
      item.removeAttribute('aria-current');
    }
  });
}

function fallbackTrust(data, reviews) {
  const included = reviews.filter((review) => review.included !== false);
  const excluded = reviews.filter((review) => review.included === false);
  const usefulRatio = reviews.length ? included.length / reviews.length : 0;
  const knownVerification = included.filter((review) => typeof review.verified === 'boolean');
  const verifiedRatio = knownVerification.length ? knownVerification.filter((review) => review.verified).length / knownVerification.length : null;
  const tone = toneForScore(null);
  return {
    score: null,
    scoreStatus: 'unavailable',
    tone: tone.id,
    label: tone.label,
    summary: 'Backend chưa cung cấp đủ dữ liệu để tính TrustScore. Bạn vẫn có thể đọc các review đã lọc, nhưng giao diện không tự suy ra điểm từ số sao.',
    pros: [{ title: 'Phản hồi tích cực', detail: 'Các review này ghi nhận trải nghiệm tích cực với sản phẩm.', mentions: included.filter((review) => Number(review.rating) >= 4).length, evidenceIds: included.map((review, index) => ({ review, index })).filter(({ review }) => Number(review.rating) >= 4).map(({ review, index }) => reviewEvidenceId(review, index)) }],
    cons: [{ title: 'Phản hồi cần cân nhắc', detail: 'Các review này nêu trải nghiệm chưa tốt hoặc điểm cần cân nhắc.', mentions: included.filter((review) => Number(review.rating) <= 3).length, evidenceIds: included.map((review, index) => ({ review, index })).filter(({ review }) => Number(review.rating) <= 3).map(({ review, index }) => reviewEvidenceId(review, index)) }],
    drivers: [
      { impact: usefulRatio >= .6 ? 'up' : 'down', title: 'Tỷ lệ review hữu ích', detail: `${included.length}/${reviews.length} review vượt qua bước giảm nhiễu.` },
      {
        impact: verifiedRatio === null ? 'neutral' : verifiedRatio >= .6 ? 'up' : 'down',
        title: 'Khả năng kiểm chứng',
        detail: verifiedRatio === null
          ? 'Nguồn dữ liệu không cung cấp trạng thái xác minh mua hàng. Hệ thống không tự suy diễn.'
          : `${Math.round(verifiedRatio * 100)}% review có trạng thái xác minh rõ ràng đến từ người mua đã xác minh.`
      },
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

function reviewEvidenceId(review, index) {
  return String(review?.labelId || `kept-${index + 1}`);
}

function reviewCard(review, included, index) {
  const name = authorName(review);
  const initial = name.replace(/\*+/g, '').trim().charAt(0).toLocaleUpperCase('vi') || 'R';
  const rating = Math.round(clamp(review.rating, 0, 5));
  const reason = review.exclusionReason || 'Nội dung chưa đủ thông tin để đưa vào kết quả chính.';
  return `
    <article class="evidence-card ${included ? 'is-kept' : 'is-excluded'}" data-evidence-id="${escapeHtml(reviewEvidenceId(review, index))}" tabindex="-1" aria-label="Review ${index + 1}, ${rating} trên 5 sao">
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

function renderSentimentList(selector, items, totalReviews) {
  const root = document.querySelector(selector);
  const sampleSize = Math.max(0, Math.round(Number(totalReviews) || 0));
  root.innerHTML = items.map((item) => {
    const rawMentions = Math.max(0, Math.round(Number(item.mentions) || 0));
    const mentions = sampleSize ? Math.min(rawMentions, sampleSize) : 0;
    const evidenceIds = Array.isArray(item.evidenceIds) ? item.evidenceIds.map(String).filter(Boolean) : [];
    const evidenceAttribute = escapeHtml(evidenceIds.join('|'));
    return `
    <article class="sentiment-item">
      <span class="sentiment-check" aria-hidden="true">${selector.includes('pros') ? '✓' : '!'}</span>
      <div><h4>${escapeHtml(item.title)}</h4><p>${escapeHtml(item.detail)}</p></div>
      ${mentions > 0 ? `<button class="sentiment-mentions" type="button" data-evidence-ids="${evidenceAttribute}" data-topic-title="${escapeHtml(item.title)}" aria-pressed="false" aria-label="Xem ${mentions} trên ${sampleSize} review đáng tham khảo về ${escapeHtml(item.title)}"${evidenceIds.length ? '' : ' disabled'}><b>${mentions}</b><small>/${sampleSize} review</small></button>` : ''}
    </article>`;
  }).join('');
}

function driverIcon(impact) {
  if (impact === 'up') return '↗';
  if (impact === 'down') return '↘';
  return '→';
}

function normalizeDriverImpact(impact) {
  return ['up', 'down', 'neutral'].includes(impact) ? impact : 'neutral';
}

function renderDriverGroups(drivers) {
  const normalizedDrivers = (Array.isArray(drivers) ? drivers : []).map((driver) => ({
    ...driver,
    impact: normalizeDriverImpact(driver?.impact)
  }));
  const groups = [
    {
      impact: 'up',
      eyebrow: 'Củng cố',
      title: 'Yếu tố củng cố độ tin cậy',
      description: 'Những tín hiệu giúp tập review đáng tin hơn.',
      empty: 'Chưa ghi nhận yếu tố củng cố nổi bật.'
    },
    {
      impact: 'down',
      eyebrow: 'Hạ điểm',
      title: 'Yếu tố làm giảm độ tin cậy',
      description: 'Những tín hiệu trực tiếp kéo TrustScore xuống.',
      empty: 'Chưa ghi nhận yếu tố làm giảm điểm.'
    },
    {
      impact: 'neutral',
      eyebrow: 'Trung lập',
      title: 'Yếu tố trung lập',
      description: 'Thông tin giúp hiểu bối cảnh nhưng không trực tiếp nâng hoặc hạ điểm.',
      empty: 'Chưa ghi nhận yếu tố trung lập.'
    }
  ];
  let driverNumber = 0;

  return groups.map((group) => {
    const groupDrivers = normalizedDrivers.filter((driver) => driver.impact === group.impact);
    const cards = groupDrivers.map((driver) => {
      driverNumber += 1;
      return `
        <article class="driver-card" data-impact="${group.impact}">
          <span class="driver-number">${String(driverNumber).padStart(2, '0')}</span>
          <span class="driver-impact" aria-hidden="true">${driverIcon(group.impact)}</span>
          <div><small>${group.eyebrow}</small><h4>${escapeHtml(driver.title)}</h4><p class="driver-detail">${escapeHtml(driver.detail)}</p></div>
        </article>`;
    }).join('');

    return `
      <section class="driver-group" data-driver-group="${group.impact}" aria-labelledby="driver-group-${group.impact}">
        <header class="driver-group-header">
          <span class="driver-group-mark" aria-hidden="true">${driverIcon(group.impact)}</span>
          <div>
            <p>${group.eyebrow}</p>
            <h3 id="driver-group-${group.impact}">${group.title}</h3>
            <span>${group.description}</span>
          </div>
          <strong class="driver-group-count" aria-label="${groupDrivers.length} yếu tố">${groupDrivers.length}</strong>
        </header>
        ${cards ? `<div class="driver-grid">${cards}</div>` : `<p class="driver-group-empty">${group.empty}</p>`}
      </section>`;
  }).join('');
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
    status.textContent = track.dataset.topicLabel || `${cardCount} review · Trang ${currentPage}/${totalPages}`;
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
  track.addEventListener('topicchange', updateControls);
  root.closest('details')?.addEventListener('toggle', () => requestAnimationFrame(updateControls));
  window.addEventListener('resize', updateControls);
  requestAnimationFrame(updateControls);
}

function linkSentimentEvidence() {
  const details = document.querySelector('#kept-reviews');
  const track = document.querySelector('#kept-list');
  if (!details || !track) return;

  const buttons = Array.from(document.querySelectorAll('.sentiment-mentions:not(:disabled)'));
  buttons.forEach((button) => button.addEventListener('click', () => {
    const selected = button.getAttribute('aria-pressed') === 'true';
    buttons.forEach((item) => item.setAttribute('aria-pressed', 'false'));
    const cards = Array.from(track.querySelectorAll('.evidence-card'));
    cards.forEach((card) => card.classList.remove('is-topic-match'));

    if (selected) {
      delete track.dataset.topicLabel;
      track.dispatchEvent(new Event('topicchange'));
      return;
    }

    const evidenceIds = new Set(String(button.dataset.evidenceIds || '').split('|').filter(Boolean));
    const matches = cards.filter((card) => evidenceIds.has(card.dataset.evidenceId));
    if (!matches.length) return;

    button.setAttribute('aria-pressed', 'true');
    matches.forEach((card) => card.classList.add('is-topic-match'));
    const topicTitle = String(button.dataset.topicTitle || 'chủ đề đã chọn');
    track.dataset.topicLabel = `${matches.length} review về “${topicTitle}” đang được đánh dấu`;
    details.open = true;
    track.dispatchEvent(new Event('topicchange'));

    requestAnimationFrame(() => {
      details.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const first = matches[0];
      track.scrollTo({ left: Math.max(0, first.offsetLeft - track.offsetLeft - 12), behavior: 'smooth' });
      window.setTimeout(() => first.focus({ preventScroll: true }), 450);
    });
  }));
}

function renderResult(data) {
  const product = data.product || {};
  const stats = data.stats || {};
  const reviews = Array.isArray(data.reviews) ? data.reviews : [];
  const keptReviews = reviews.filter((review) => review.included !== false);
  const excludedReviews = reviews.filter((review) => review.included === false);
  const trust = data.trust || fallbackTrust(data, reviews);
  const scoreAvailable = typeof trust.score === 'number' && Number.isFinite(trust.score);
  const score = scoreAvailable ? Math.round(clamp(trust.score, 0, 100)) : 0;
  const scoreText = scoreAvailable ? String(score) : '—';
  const tone = toneForScore(scoreAvailable ? score : null);
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

  const imageUrl = safeImageUrl(product.image || product.imageUrl || product.thumbnail);
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
  document.querySelector('#trust-gauge').dataset.scoreLength = scoreText.length;
  document.querySelector('#trust-gauge').setAttribute('aria-label', scoreAvailable ? `TrustScore ${score} trên 100` : 'Chưa đủ bằng chứng để tính TrustScore');
  document.querySelector('#trust-score').textContent = scoreText;
  document.querySelector('#action-score').textContent = scoreText;
  document.querySelector('#trust-label').textContent = trust.label || tone.label;
  renderScoreLegend(scoreAvailable ? score : null);
  const fullSummary = String(trust.summary || data.verdict || '');
  const shortSummary = conciseSummary(fullSummary);
  const summaryDetail = fullSummary.slice(shortSummary.endsWith('…') ? 0 : shortSummary.length).trim();
  document.querySelector('#trust-summary').textContent = shortSummary;
  document.querySelector('#trust-summary-detail').textContent = summaryDetail || fullSummary;
  document.querySelector('#trust-summary-more').hidden = !fullSummary || fullSummary === shortSummary;
  document.querySelector('#analysis-source').textContent = trust.engine === 'gemini' ? 'Gemini AI + bộ lọc RealView' : 'Bộ lọc minh bạch RealView';

  const method = trust.method || {};
  document.querySelector('#method-text-score').textContent = methodScore(method.components?.text?.score);
  document.querySelector('#method-auth-score').textContent = methodScore(method.components?.authenticity?.score);
  document.querySelector('#method-label-score').textContent = methodScore(method.components?.labeling?.score);
  document.querySelector('#method-coverage-score').textContent = methodScore(
    Number.isFinite(Number(method.adequacy?.coverage)) ? Number(method.adequacy.coverage) * 100 : null,
    '%'
  );

  const scanned = Number(stats.scanned ?? reviews.length) || 0;
  const kept = Number(stats.included ?? stats.genuine ?? keptReviews.length) || 0;
  const excluded = Number(stats.excluded ?? excludedReviews.length) || 0;
  document.querySelector('#scanned-count').textContent = scanned;
  document.querySelector('#kept-count-top').textContent = kept;
  document.querySelector('#excluded-count-top').textContent = excluded;
  document.querySelector('#kept-count').textContent = kept;
  document.querySelector('#excluded-count').textContent = excluded;
  renderSentimentList('#pros-list', Array.isArray(trust.pros) && trust.pros.length ? trust.pros : fallbackTrust(data, reviews).pros, kept);
  renderSentimentList('#cons-list', Array.isArray(trust.cons) && trust.cons.length ? trust.cons : fallbackTrust(data, reviews).cons, kept);

  const drivers = Array.isArray(trust.drivers) ? trust.drivers : [];
  document.querySelector('#trust-drivers').innerHTML = renderDriverGroups(drivers);

  document.querySelector('#kept-list').innerHTML = keptReviews.length ? keptReviews.map((review, index) => reviewCard(review, true, index)).join('') : emptyReviewState(true);
  document.querySelector('#excluded-list').innerHTML = excludedReviews.length ? excludedReviews.map((review, index) => reviewCard(review, false, index)).join('') : emptyReviewState(false);
  document.querySelectorAll('[data-review-carousel]').forEach(setupReviewCarousel);
  linkSentimentEvidence();

  content.classList.remove('hidden');
  document.querySelector('#result-action-bar').classList.remove('hidden');
  const introDialog = document.querySelector('#trust-intro-dialog');
  if (introDialog?.showModal && !introDialog.open) requestAnimationFrame(() => introDialog.showModal());
}

let data;
try {
  data = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
} catch {
  data = null;
}

if (data?.reviews && data?.product) renderResult(data);
else emptyState.classList.remove('hidden');

const trustIntroDialog = document.querySelector('#trust-intro-dialog');
trustIntroDialog?.querySelector('.trust-intro-close')?.addEventListener('click', () => trustIntroDialog.close());
trustIntroDialog?.querySelector('.trust-intro-primary')?.addEventListener('click', () => trustIntroDialog.close());
trustIntroDialog?.addEventListener('click', (event) => {
  if (event.target === trustIntroDialog) trustIntroDialog.close();
});
const trustMethodTrigger = document.querySelector('#trust-method-trigger');
const trustMethodPopover = document.querySelector('#trust-method-popover');
if (trustMethodTrigger && trustMethodPopover) {
  document.querySelector('#trust-method-close')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    trustMethodPopover.hidePopover();
  });
  
  const positionTrustMethodPopover = () => {
    if (!trustMethodPopover.matches(':popover-open')) return;
    const triggerRect = trustMethodTrigger.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 24);
    const height = trustMethodPopover.offsetHeight;
    const left = Math.max(12, Math.min(window.innerWidth - width - 12, triggerRect.left + triggerRect.width / 2 - width / 2));
    const openAbove = triggerRect.bottom + height + 18 > window.innerHeight && triggerRect.top > height + 18;
    const top = openAbove ? triggerRect.top - height - 12 : triggerRect.bottom + 12;
    const arrowLeft = Math.max(24, Math.min(width - 24, triggerRect.left + triggerRect.width / 2 - left));
    trustMethodPopover.style.width = `${width}px`;
    trustMethodPopover.style.left = `${left}px`;
    trustMethodPopover.style.top = `${Math.max(12, top)}px`;
    trustMethodPopover.style.setProperty('--method-arrow-left', `${arrowLeft}px`);
    trustMethodPopover.dataset.placement = openAbove ? 'top' : 'bottom';
  };

  trustMethodPopover.addEventListener('toggle', (event) => {
    trustMethodTrigger.setAttribute('aria-expanded', String(event.newState === 'open'));
    if (event.newState === 'open') requestAnimationFrame(positionTrustMethodPopover);
  });
  window.addEventListener('resize', positionTrustMethodPopover, { passive: true });
  window.addEventListener('scroll', positionTrustMethodPopover, { passive: true, capture: true });
}

// Setup scroll to top button
const backToTop = document.querySelector('.back-to-top');
if (backToTop) {
  function updateBackToTop() {
    backToTop.classList.toggle('is-visible', window.scrollY > 400);
  }

  backToTop.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  window.addEventListener('scroll', updateBackToTop, { passive: true });
  updateBackToTop();
}
