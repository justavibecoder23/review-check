const form = document.querySelector('#analyze-form');
const input = document.querySelector('#product-url');
const button = document.querySelector('#submit-button');
const loading = document.querySelector('#loading');
const result = document.querySelector('#result');
const errorBox = document.querySelector('#form-error');
const sourceNotice = document.querySelector('#source-notice');
const loadingCopy = document.querySelector('#loading-copy');
const loadingProgress = document.querySelector('.loading-progress');

function publicProgressMessage(progress = {}) {
  if (progress.phase === 'complete') return 'Phân tích hoàn tất.';
  if (progress.phase === 'collecting') {
    return Number(progress.percent) <= 14
      ? 'Đang khởi tạo hệ thống lấy reviews...'
      : 'Đang lấy reviews...';
  }
  if (['labeling', 'filtering'].includes(progress.phase)) return 'Đang phân tích reviews...';
  if (['saving', 'scoring'].includes(progress.phase)) return 'Đang hoàn thiện kết quả...';
  return 'Đang khởi tạo hệ thống...';
}
const backToTop = document.querySelector('.back-to-top');
const defaultButtonContent = button?.innerHTML;
const delayLines = [
  'Đang khởi tạo hệ thống...',
  'Đang khởi tạo hệ thống lấy reviews...',
  'Đang lấy reviews...',
  'Đang hoàn thiện kết quả...'
];

const navLinks = [...document.querySelectorAll('.main-nav .nav-parent[href^="#"]')];
const navIndicator = document.querySelector('.nav-indicator');
const mainNav = document.querySelector('.main-nav');
const siteHeader = document.querySelector('.site-header');
const navToggle = document.querySelector('.nav-toggle');
const navToggleLabel = document.querySelector('.nav-toggle-label');
const navSections = navLinks
  .map((link) => document.querySelector(link.hash))
  .filter(Boolean);
let indicatorAnimation;
let activeNavId;

function updateBackToTop() {
  if (!backToTop) return;
  backToTop.classList.toggle('is-visible', window.scrollY > window.innerHeight);
}

backToTop?.addEventListener('click', () => {
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
window.addEventListener('scroll', updateBackToTop, { passive: true });
updateBackToTop();

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
  if (!navIndicator || !mainNav || !targetLink || targetLink.offsetParent === null) return;

  const targetX = targetLink.getBoundingClientRect().left - mainNav.getBoundingClientRect().left;
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
  for (const key of ['scanned', 'genuine', 'excluded']) document.querySelector(`#${key}`).textContent = stats[key];
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

function openResultsPage(data) {
  try {
    sessionStorage.setItem('realview:last-analysis', JSON.stringify(data));
    window.location.assign('/results.html');
  } catch {
    // Giữ giao diện kết quả cũ làm phương án dự phòng nếu trình duyệt chặn sessionStorage.
    render(data);
  }
}

async function analyzeWithSse(url, onProgress) {
  const response = await fetch('/api/analyze-stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ url })
  });
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok || !contentType.includes('text/event-stream')) {
    let message = 'Không thể mở luồng phân tích.';
    try { message = (await response.json()).error || message; } catch { /* Phản hồi không phải JSON. */ }
    throw new Error(message);
  }
  if (!response.body) throw new Error('Trình duyệt không hỗ trợ đọc tiến độ trực tiếp.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult;

  const handleBlock = (block) => {
    let event = 'message';
    const dataLines = [];
    for (const line of block.replace(/\r/g, '').split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return;
    const data = JSON.parse(dataLines.join('\n'));
    if (event === 'progress') onProgress(data);
    if (event === 'result') finalResult = data;
    if (event === 'error') throw new Error(data.error || 'Không thể phân tích link này.');
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || '';
    for (const block of blocks) handleBlock(block);
    if (done) break;
  }
  if (buffer.trim()) handleBlock(buffer);
  if (!finalResult) throw new Error('Luồng phân tích kết thúc trước khi có kết quả.');
  return finalResult;
}

if (form) form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.classList.add('hidden');
  result.classList.add('hidden');
  loading.classList.remove('hidden');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.innerHTML = 'Đang phân tích <span aria-hidden="true">•••</span>';
  form.setAttribute('aria-busy', 'true');
  if (loadingCopy) loadingCopy.textContent = delayLines[0];
  loadingProgress?.classList.add('is-live');
  loadingProgress?.style.setProperty('--analysis-progress', '0%');
  loadingProgress?.setAttribute('aria-valuenow', '0');
  requestAnimationFrame(() => {
    loading.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  try {
    const data = await analyzeWithSse(input.value.trim(), (progress) => {
      if (loadingCopy) loadingCopy.textContent = publicProgressMessage(progress);
      const percent = Math.min(100, Math.max(0, Number(progress.percent) || 0));
      loadingProgress?.style.setProperty('--analysis-progress', `${percent}%`);
      loadingProgress?.setAttribute('aria-valuenow', String(percent));
    });
    openResultsPage(data);
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.classList.remove('hidden');
  } finally {
    loading.classList.add('hidden');
    loadingProgress?.classList.remove('is-live');
    button.disabled = false;
    button.removeAttribute('aria-busy');
    form.removeAttribute('aria-busy');
    if (defaultButtonContent) button.innerHTML = defaultButtonContent;
  }
});
