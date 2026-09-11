import { getCurrentUser } from './auth.js';

const form = document.querySelector('[data-contact-form]');
let verificationId = '';
let verifiedPayloadSignature = '';
let authenticatedUser = null;

function applyAccount(user) {
  authenticatedUser = user || null;
  const emailInput = form?.elements?.email;
  if (!emailInput) return;
  if (authenticatedUser) {
    emailInput.value = authenticatedUser.email;
    emailInput.readOnly = true;
    emailInput.setAttribute('aria-describedby', 'contact-email-help');
  } else {
    emailInput.readOnly = false;
    emailInput.removeAttribute('aria-describedby');
  }
  const help = form.querySelector('[data-contact-email-help]');
  if (help) help.hidden = !authenticatedUser;
}

getCurrentUser().then(applyAccount);
window.addEventListener('realview:auth-changed', (event) => applyAccount(event.detail?.user));

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
  button.disabled = true;
  button.textContent = authenticatedUser ? 'Đang gửi…' : verificationId ? 'Đang xác minh…' : 'Đang gửi mã…';
  showStatus('', 'loading');
  try {
    const values = Object.fromEntries(new FormData(form));
    const signature = JSON.stringify({ name: values.name, email: values.email, message: values.message });
    const requestingCode = !authenticatedUser && (!verificationId || signature !== verifiedPayloadSignature);
    const response = await fetch('/api/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...values,
        action: requestingCode ? 'request_verification' : 'submit_contact',
        verificationId
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Không thể gửi liên hệ lúc này.');
    if (requestingCode) {
      verificationId = payload.verificationId;
      verifiedPayloadSignature = signature;
      const verification = form.querySelector('[data-contact-verification]');
      verification.hidden = false;
      verification.querySelector('input').required = true;
      verification.querySelector('input').focus();
      button.innerHTML = 'Xác minh và gửi <span aria-hidden="true">→</span>';
      showStatus(payload.message, 'success');
      return;
    }
    form.reset();
    verificationId = '';
    verifiedPayloadSignature = '';
    const verification = form.querySelector('[data-contact-verification]');
    verification.hidden = true;
    verification.querySelector('input').required = false;
    window.realviewTrackEvent?.('generate_lead', { method: 'contact_form' });
    if (payload.delivered) {
      showStatus('Đã gửi phản hồi đến hộp thư RealView. Cảm ơn bạn đã liên hệ.', 'success');
    } else {
      showStatus('Phản hồi đã được lưu, nhưng email chuyển tiếp chưa gửi được. Đội ngũ RealView sẽ kiểm tra cấu hình hộp thư.', 'warning');
    }
  } catch (error) {
    showStatus(error.message, 'error');
  } finally {
    button.disabled = false;
    button.innerHTML = verificationId && !authenticatedUser
      ? 'Xác minh và gửi <span aria-hidden="true">→</span>'
      : 'Gửi liên hệ <span aria-hidden="true">→</span>';
  }
});

