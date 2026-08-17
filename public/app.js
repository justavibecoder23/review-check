const form = document.querySelector('#analyze-form');
const input = document.querySelector('#product-url');
const button = document.querySelector('#submit-button');
const loading = document.querySelector('#loading');
const result = document.querySelector('#result');
const errorBox = document.querySelector('#form-error');
const sourceNotice = document.querySelector('#source-notice');
const delayLines = ['Kết nối nguồn bình luận', 'Đang bỏ review nhận xu và khen chung chung', 'Đang nhóm các phản hồi trùng ý'];

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
