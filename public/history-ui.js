import {
  clearHistory,
  deleteHistoryItem,
  formatRelativeTime,
  getHistory,
  restoreHistoryItem
} from './history-manager.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

function safeImage(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function historyCard(item, compact = false) {
  const image = safeImage(item.image);
  const score = item.score === null ? '—' : item.score;
  return `
    <article class="history-card${compact ? ' history-card--compact' : ''}" data-history-id="${escapeHtml(item.id)}">
      <button class="history-card-open" type="button" data-history-open-item="${escapeHtml(item.id)}" aria-label="Mở lại kết quả ${escapeHtml(item.title)}">
        <span class="history-card-visual">
          ${image ? `<img data-history-image src="${escapeHtml(image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />` : '<span class="history-card-placeholder" aria-hidden="true">RV</span>'}
          <span class="history-platform">${escapeHtml(item.platform)}</span>
        </span>
        <span class="history-card-copy">
          <strong title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</strong>
          <span>${item.stats.scanned} review đã quét · ${item.stats.kept} giữ lại</span>
          <small>${escapeHtml(formatRelativeTime(item.analyzedAt))}</small>
        </span>
        <span class="history-score history-score--${escapeHtml(item.tone)}"><b>${score}</b><small>TrustScore</small></span>
      </button>
      <button class="history-card-delete" type="button" data-history-delete="${escapeHtml(item.id)}" aria-label="Xóa ${escapeHtml(item.title)} khỏi lịch sử">×</button>
    </article>`;
}

function ensureDrawer() {
  let drawer = document.querySelector('#analysis-history-drawer');
  if (drawer) return drawer;
  document.body.insertAdjacentHTML('beforeend', `
    <div id="analysis-history-shell" class="history-drawer-shell" aria-hidden="true">
      <button class="history-drawer-backdrop" type="button" data-history-close aria-label="Đóng lịch sử"></button>
      <aside id="analysis-history-drawer" class="history-drawer" role="dialog" aria-modal="true" aria-labelledby="history-drawer-title" tabindex="-1">
        <header class="history-drawer-header">
          <div><small>Các báo cáo trên thiết bị này</small><h2 id="history-drawer-title">Lịch sử phân tích</h2></div>
          <button type="button" data-history-close aria-label="Đóng lịch sử">×</button>
        </header>
        <div class="history-drawer-toolbar"><span data-history-summary></span><button type="button" data-history-clear>Xóa tất cả</button></div>
        <div class="history-drawer-list" data-history-drawer-list></div>
        <p class="history-privacy-note">Lịch sử chỉ được lưu trong trình duyệt này và không được gửi lên máy chủ.</p>
      </aside>
    </div>`);
  return document.querySelector('#analysis-history-drawer');
}

function renderHistory() {
  const history = getHistory();
  document.querySelectorAll('[data-history-count]').forEach((badge) => {
    badge.textContent = String(history.length);
    badge.hidden = history.length === 0;
  });

  const section = document.querySelector('[data-history-section]');
  if (section) {
    section.hidden = history.length === 0;
    const list = section.querySelector('[data-history-list]');
    if (list) list.innerHTML = history.map((item) => historyCard(item)).join('');
  }

  const drawerList = document.querySelector('[data-history-drawer-list]');
  if (drawerList) {
    drawerList.innerHTML = history.length
      ? history.map((item) => historyCard(item, true)).join('')
      : '<div class="history-empty"><strong>Chưa có báo cáo nào</strong><span>Kết quả sẽ xuất hiện tại đây sau lần phân tích đầu tiên.</span></div>';
  }
  const summary = document.querySelector('[data-history-summary]');
  if (summary) summary.textContent = history.length ? `${history.length} báo cáo gần nhất` : 'Chưa có lịch sử';
  document.querySelectorAll('[data-history-clear]').forEach((button) => { button.hidden = history.length === 0; });
  document.querySelectorAll('[data-history-image]').forEach((image) => {
    image.addEventListener('error', () => {
      image.insertAdjacentHTML('afterend', '<span class="history-card-placeholder" aria-hidden="true">RV</span>');
      image.remove();
    }, { once: true });
  });
}

function openDrawer() {
  const drawer = ensureDrawer();
  renderHistory();
  const shell = drawer.closest('.history-drawer-shell');
  shell.classList.add('is-open');
  shell.setAttribute('aria-hidden', 'false');
  document.body.classList.add('history-drawer-open');
  drawer.focus();
}

function closeDrawer() {
  const shell = document.querySelector('#analysis-history-shell');
  if (!shell) return;
  shell.classList.remove('is-open');
  shell.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('history-drawer-open');
}

function confirmClear() {
  if (!getHistory().length) return;
  if (window.confirm('Xóa toàn bộ lịch sử phân tích trên thiết bị này?')) {
    clearHistory();
    renderHistory();
  }
}

function initialize() {
  ensureDrawer();
  renderHistory();
  document.addEventListener('click', (event) => {
    const openTrigger = event.target.closest('[data-history-open]');
    if (openTrigger) {
      event.preventDefault();
      openDrawer();
      return;
    }
    const closeTrigger = event.target.closest('[data-history-close]');
    if (closeTrigger) {
      closeDrawer();
      return;
    }
    const itemTrigger = event.target.closest('[data-history-open-item]');
    if (itemTrigger) {
      restoreHistoryItem(itemTrigger.dataset.historyOpenItem);
      return;
    }
    const deleteTrigger = event.target.closest('[data-history-delete]');
    if (deleteTrigger) {
      deleteHistoryItem(deleteTrigger.dataset.historyDelete);
      renderHistory();
      return;
    }
    if (event.target.closest('[data-history-clear]')) confirmClear();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDrawer();
  });
  window.addEventListener('storage', renderHistory);
  window.addEventListener('realview:history-changed', renderHistory);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();

export { renderHistory };
