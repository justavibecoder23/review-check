const form = document.querySelector('#analyze-form');
const input = document.querySelector('#product-url');
const button = document.querySelector('#submit-button');
const loading = document.querySelector('#loading');
const result = document.querySelector('#result');
const errorBox = document.querySelector('#form-error');
const sourceNotice = document.querySelector('#source-notice');
const delayLines = ['Kết nối nguồn bình luận', 'Đang bỏ review nhận xu và khen chung chung', 'Đang nhóm các phản hồi trùng ý'];

const navLinks = [...document.querySelectorAll('.main-nav a[href^="#"]')];
const navIndicator = document.querySelector('.nav-indicator');
const siteHeader = document.querySelector('.site-header');
const navToggle = document.querySelector('.nav-toggle');
const navToggleLabel = document.querySelector('.nav-toggle-label');
const navSections = navLinks
  .map((link) => document.querySelector(link.hash))
  .filter(Boolean);
let indicatorAnimation;
let activeNavId;

function setMobileMenu(open) {
  if (!siteHeader || !navToggle) return;
  siteHeader.classList.toggle('is-menu-open', open);
  navToggle.setAttribute('aria-expanded', String(open));
  if (navToggleLabel) navToggleLabel.textContent = open ? 'Đóng menu' : 'Mở menu';
}

if (navToggle) {
  navToggle.addEventListener('click', () => {
    setMobileMenu(navToggle.getAttribute('aria-expanded') !== 'true');
  });
  document.addEventListener('click', (event) => {
    if (siteHeader?.classList.contains('is-menu-open') && !siteHeader.contains(event.target)) setMobileMenu(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setMobileMenu(false);
  });
}

function moveNavIndicator(targetLink, shouldAnimate = true) {
  if (!navIndicator || !targetLink || targetLink.offsetParent === null) return;

  const targetX = targetLink.offsetLeft;
  const targetWidth = targetLink.offsetWidth;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canAnimate = shouldAnimate && navIndicator.dataset.ready && !reduceMotion && navIndicator.animate;

  if (!canAnimate) {
    indicatorAnimation?.cancel();
    navIndicator.style.width = `${targetWidth}px`;
    navIndicator.style.borderRadius = '11px';
    navIndicator.style.transform = `translate3d(${targetX}px, 0, 0)`;
    navIndicator.dataset.ready = 'true';
    return;
  }

  const computedStyle = window.getComputedStyle(navIndicator);
  const currentMatrix = new DOMMatrixReadOnly(computedStyle.transform);
  const currentX = currentMatrix.m41;
  const currentWidth = Number.parseFloat(computedStyle.width) || targetWidth;
  const circleSize = 38;
  const circleStartX = currentX + (currentWidth - circleSize) / 2;
  const circleEndX = targetX + (targetWidth - circleSize) / 2;

  indicatorAnimation?.cancel();
  indicatorAnimation = navIndicator.animate([
    { width: `${currentWidth}px`, borderRadius: '11px', transform: `translate3d(${currentX}px, 0, 0)`, offset: 0 },
    { width: `${circleSize}px`, borderRadius: '50%', transform: `translate3d(${circleStartX}px, -3px, 0)`, offset: .24 },
    { width: `${circleSize}px`, borderRadius: '50%', transform: `translate3d(${circleEndX}px, -3px, 0)`, offset: .72 },
    { width: `${targetWidth}px`, borderRadius: '11px', transform: `translate3d(${targetX}px, 0, 0)`, offset: 1 },
  ], {
    duration: 520,
    easing: 'cubic-bezier(.22, 1, .36, 1)',
  });

  indicatorAnimation.onfinish = () => {
    navIndicator.style.width = `${targetWidth}px`;
    navIndicator.style.borderRadius = '11px';
    navIndicator.style.transform = `translate3d(${targetX}px, 0, 0)`;
    indicatorAnimation = undefined;
  };
}

function setActiveNav(sectionId, shouldAnimate = true) {
  const targetLink = navLinks.find((link) => link.hash === `#${sectionId}`);
  if (!targetLink) return;
  const sectionChanged = activeNavId !== sectionId;
  activeNavId = sectionId;

  navLinks.forEach((link) => {
    const isActive = link === targetLink;
    link.classList.toggle('is-active', isActive);
    if (isActive) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  moveNavIndicator(targetLink, shouldAnimate && sectionChanged);
}

if (navSections.length) {
  const initialSection = navSections.find((section) => `#${section.id}` === window.location.hash) || navSections[0];
  setActiveNav(initialSection.id, false);

  const sectionObserver = new IntersectionObserver((entries) => {
    const currentSection = entries.find((entry) => entry.isIntersecting);
    if (currentSection) setActiveNav(currentSection.target.id);
  }, {
    rootMargin: '-22% 0px -68% 0px',
    threshold: 0,
  });

  navSections.forEach((section) => sectionObserver.observe(section));
  navLinks.forEach((link) => link.addEventListener('click', () => {
    setActiveNav(link.hash.slice(1));
    setMobileMenu(false);
  }));
  window.addEventListener('resize', () => {
    if (window.innerWidth > 900) setMobileMenu(false);
    const activeLink = navLinks.find((link) => link.classList.contains('is-active'));
    if (activeLink) moveNavIndicator(activeLink, false);
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function renderIssues(issues) {
  const root = document.querySelector('#issues');
  if (!issues.length) {
    root.innerHTML = '<div class="empty">Chưa có nhược điểm nào xuất hiện lặp lại trong các review đã giữ lại.</div>';
    return;
  }
  root.innerHTML = issues.map((issue) => `
    <article class="issue">
      <div class="issue-top"><h3>${escapeHtml(issue.label)}</h3><span>${issue.count} đề cập</span></div>
      <p class="issue-level">${escapeHtml(issue.level)}</p>
      ${issue.examples.map((example) => `<blockquote>“${escapeHtml(example.text)}”<footer>${'★'.repeat(example.rating)}${'☆'.repeat(5 - example.rating)} · ${escapeHtml(example.date)}</footer></blockquote>`).join('')}
    </article>`).join('');
}

function renderReviews(reviews) {
  document.querySelector('#review-count').textContent = reviews.length;
  document.querySelector('#review-list').innerHTML = reviews.map((review) => `
    <article class="review ${review.included ? 'included' : 'excluded'}">
      <div><span class="stars">${'★'.repeat(review.rating)}${'☆'.repeat(5 - review.rating)}</span><small>${escapeHtml(review.date)}</small></div>
      <p>${escapeHtml(review.text)}</p>
      <em>${review.included ? 'Được tính vào kết quả' : escapeHtml(review.exclusionReason)}</em>
    </article>`).join('');
}

function render(data) {
  const { product, source, warnings, stats, verdict, issues, reviews } = data;
  document.querySelector('#platform-tag').textContent = product.platform;
  document.querySelector('#verdict').textContent = verdict;
  document.querySelector('#original-link').href = product.url;
  for (const key of ['scanned', 'genuine', 'excluded', 'confidence']) document.querySelector(`#${key}`).textContent = stats[key];
  renderIssues(issues);
  renderReviews(reviews);

  if (source.type === 'demo') {
    sourceNotice.className = 'notice demo';
    sourceNotice.innerHTML = `<strong>Chế độ mô phỏng</strong><span>${escapeHtml(warnings.at(-1))}</span>`;
  } else {
    sourceNotice.className = 'notice live';
    sourceNotice.innerHTML = `<strong>Đã dùng dữ liệu trực tiếp</strong><span>Nguồn: ${escapeHtml(source.label)}</span>`;
  }
  result.classList.remove('hidden');
  result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.classList.add('hidden');
  result.classList.add('hidden');
  loading.classList.remove('hidden');
  button.disabled = true;
  let index = 0;
  const interval = setInterval(() => {
    index = (index + 1) % delayLines.length;
    document.querySelector('#loading-copy').textContent = delayLines[index];
  }, 700);
  try {
    const response = await fetch('/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: input.value.trim() }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Không thể phân tích link này.');
    render(data);
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.classList.remove('hidden');
  } finally {
    clearInterval(interval);
    loading.classList.add('hidden');
    button.disabled = false;
  }
});
