const STORAGE_KEY = 'realview:last-analysis';
const content = document.querySelector('#results-content');
const emptyState = document.querySelector('#results-empty');
const siteHeader = document.querySelector('.site-header');
const navToggle = document.querySelector('.nav-toggle');
const navToggleLabel = document.querySelector('.nav-toggle-label');
let toastTimer;

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

function safeProductUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '/#home';
  } catch {
    return '/#home';
  }
}

function authorName(review) {
  const author = String(review.author || '').trim();
  if (!author || /^\*+$/.test(author)) return 'Người mua Shopee';
  return author;
}

function authorInitial(name) {
  const visible = name.replace(/\*+/g, '').trim();
  return (visible[0] || 'R').toLocaleUpperCase('vi');
}

function starMarkup(rating) {
  const safeRating = Math.max(0, Math.min(5, Number(rating) || 0));
  return Array.from({ length: 5 }, (_, index) => `
    <span class="review-star ${index < safeRating ? 'is-filled' : ''}" aria-hidden="true">
      <svg viewBox="0 0 24 24"><path d="m12 2.8 2.8 5.7 6.3.9-4.5 4.4 1 6.3-5.6-3-5.6 3 1-6.3-4.5-4.4 6.3-.9L12 2.8Z" /></svg>
    </span>`).join('');
}

function reviewCard(review, index, included) {
  const name = authorName(review);
  const reason = String(review.exclusionReason || 'Nội dung chưa đủ thông tin để đưa vào kết quả chính.');
  const rating = Math.max(0, Math.min(5, Number(review.rating) || 0));
  const date = String(review.date || 'Không rõ ngày');
  return `
    <article class="rv-review-card ${included ? 'rv-review-kept' : 'rv-review-excluded'}" aria-label="Review ${index + 1}, ${rating} trên 5 sao">
      <header class="rv-review-author">
        <span class="rv-avatar-wrap" aria-hidden="true">
          <span class="rv-review-avatar">${escapeHtml(authorInitial(name))}</span>
          ${review.verified ? '<span class="rv-avatar-verified"><svg viewBox="0 0 24 24" fill="none"><path d="m7.5 12.5 3 3 6-7" /><path d="M12 3.5 19 7v5c0 4.5-3 7.2-7 8.5-4-1.3-7-4-7-8.5V7l7-3.5Z" /></svg></span>' : ''}
        </span>
        <span class="rv-review-person">
          <strong>${escapeHtml(name)}</strong>
          <span class="rv-review-meta">${review.verified ? '<span class="rv-verified-copy">Người mua đã xác minh</span>' : '<span>Người mua Shopee</span>'}<i aria-hidden="true"></i><span>${escapeHtml(date)}</span></span>
        </span>
      </header>
      <div class="rv-review-stars" role="img" aria-label="${rating} trên 5 sao">${starMarkup(rating)}</div>
      <p class="rv-review-text">${escapeHtml(review.text || 'Review không có nội dung chữ.')}</p>
      ${included ? '' : `<div class="rv-exclusion-note"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 5h16" /><path d="M7 12h10" /><path d="M10 19h4" /><path d="m17 16 4 4" /><path d="m21 16-4 4" /></svg><span><small>Lý do giảm ưu tiên</small><strong>${escapeHtml(reason)}</strong></span></div>`}
    </article>`;
}

function emptyCollection(included) {
  return `
    <article class="rv-empty-collection">
      <span aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M8 6h13M8 12h13M8 18h9" /><path d="m3 6 .5.5L5 5M3 12l.5.5L5 11M3 18l.5.5L5 17" /></svg></span>
      <div><strong>${included ? 'Chưa có review đủ điều kiện' : 'Không có review nào bị loại'}</strong><p>${included ? 'RealView chưa tìm thấy phản hồi đủ thông tin trong lượt phân tích này.' : 'Tất cả review thu thập được đều đã vượt qua bước giảm nhiễu.'}</p></div>
    </article>`;
}

function pageCapacity() {
  if (window.matchMedia('(max-width: 700px)').matches) return 3;
  if (window.matchMedia('(max-width: 960px)').matches) return 4;
  return 8;
}

function reviewPages(reviews, included) {
  if (!reviews.length) return `<div class="review-page review-page-empty">${emptyCollection(included)}</div>`;
  const capacity = pageCapacity();
  const pages = [];
  for (let start = 0; start < reviews.length; start += capacity) {
    const cards = reviews.slice(start, start + capacity)
      .map((review, index) => reviewCard(review, start + index, included))
      .join('');
    pages.push(`<div class="review-page" aria-label="Trang review ${Math.floor(start / capacity) + 1}">${cards}</div>`);
  }
  return pages.join('');
}

function setupCarousel(root) {
  const track = root.querySelector('.review-track');
  const previous = root.querySelector('.carousel-prev');
  const next = root.querySelector('.carousel-next');

  function updateControls() {
    const maxScroll = Math.max(0, track.scrollWidth - track.clientWidth);
    previous.disabled = track.scrollLeft < 4;
    next.disabled = track.scrollLeft > maxScroll - 4 || maxScroll < 4;
  }

  function move(direction) {
    track.scrollBy({ left: direction * track.clientWidth, behavior: 'smooth' });
  }

  previous.addEventListener('click', () => move(-1));
  next.addEventListener('click', () => move(1));
  track.addEventListener('scroll', updateControls, { passive: true });
  window.addEventListener('resize', updateControls);
  requestAnimationFrame(updateControls);
}

function showToast(message) {
  const toast = document.querySelector('#result-toast');
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('is-visible');
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 3200);
}

function renderResult(data) {
  const product = data.product || {};
  const stats = data.stats || {};
  const reviews = Array.isArray(data.reviews) ? data.reviews : [];
  const keptReviews = reviews.filter((review) => review.included !== false);
  const excludedReviews = reviews.filter((review) => review.included === false);
  const kept = Number(stats.genuine ?? keptReviews.length) || 0;
  const excluded = Number(stats.excluded ?? excludedReviews.length) || 0;

  document.querySelector('#results-platform').textContent = String(product.platform || 'Shopee').toLocaleUpperCase('vi');
  document.querySelector('#results-verdict').textContent = data.verdict || 'Kết quả chỉ hỗ trợ tham khảo; hãy kiểm tra kỹ thông tin sản phẩm trước khi mua.';
  document.querySelector('#open-product').href = safeProductUrl(product.url);
  document.querySelector('#kept-count').textContent = kept;
  document.querySelector('#excluded-count-top').textContent = excluded;
  document.querySelector('#excluded-count').textContent = excluded;

  const keptTrack = document.querySelector('#kept-track');
  const excludedTrack = document.querySelector('#excluded-track');
  let capacity = pageCapacity();

  function renderReviewCollections() {
    keptTrack.innerHTML = reviewPages(keptReviews, true);
    excludedTrack.innerHTML = reviewPages(excludedReviews, false);
    keptTrack.scrollTo({ left: 0 });
    excludedTrack.scrollTo({ left: 0 });
  }

  renderReviewCollections();
  window.addEventListener('resize', () => {
    const nextCapacity = pageCapacity();
    if (nextCapacity === capacity) return;
    capacity = nextCapacity;
    renderReviewCollections();
  });

  document.querySelectorAll('.review-carousel').forEach(setupCarousel);
  document.querySelector('#show-excluded').addEventListener('click', () => {
    document.querySelector('#excluded-reviews').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  document.querySelector('#filter-method').addEventListener('click', () => {
    showToast('Phần tiêu chí lọc review đang được hoàn thiện và sẽ sớm được công bố.');
  });

  content.classList.remove('hidden');
}

let data;
try {
  data = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
} catch {
  data = null;
}

if (data?.reviews && data?.product) renderResult(data);
else emptyState.classList.remove('hidden');
