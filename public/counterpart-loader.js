let loading;

function loadCounterpartWidget() {
  if (!loading) loading = import('./counterpart-widget.js?v=18').catch(() => null);
  return loading;
}

window.addEventListener('realview:analysis-result', async (event) => {
  await loadCounterpartWidget();
  window.dispatchEvent(new CustomEvent('realview:counterpart-source', { detail: event.detail }));
}, { once: true });

// Khi mở lại kết quả đã lưu, results.js render đồng bộ trước loader này. Không
// đọc kết quả cũ nếu URL đang yêu cầu một lượt phân tích mới.
if (!new URLSearchParams(window.location.search).has('url')) {
  try {
    const stored = JSON.parse(sessionStorage.getItem('realview:last-analysis') || 'null');
    if (stored?.product && stored?.reviews) void loadCounterpartWidget();
  } catch { /* Không có kết quả hợp lệ để tìm đối ứng. */ }
}
