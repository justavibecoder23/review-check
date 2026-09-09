const form = document.querySelector('[data-contact-form]');

function showStatus(message, type) {
  const status = form?.querySelector('[data-contact-status]');
  if (!status) return;
  status.textContent = message;
  status.dataset.state = type;
  status.hidden = false;
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  const button = form.querySelector('[type="submit"]');
  const original = button.innerHTML;
  button.disabled = true;
  button.textContent = 'Đang gửi…';
  showStatus('', 'loading');
  try {
    const response = await fetch('/api/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(form)))
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Không thể gửi liên hệ lúc này.');
    form.reset();
    if (payload.delivered) {
      showStatus('Đã gửi phản hồi đến hộp thư RealView. Cảm ơn bạn đã liên hệ.', 'success');
    } else {
      showStatus('Phản hồi đã được lưu, nhưng email chuyển tiếp chưa gửi được. Đội ngũ RealView sẽ kiểm tra cấu hình hộp thư.', 'warning');
    }
  } catch (error) {
    showStatus(error.message, 'error');
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
});

