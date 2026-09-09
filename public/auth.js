let currentUser = null;
let statusPromise;
let returnFocus;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

async function apiRequest(body) {
  const response = await fetch('/api/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Không thể xử lý yêu cầu lúc này.');
  return payload;
}

function accountControlsMarkup() {
  if (currentUser) {
    const initial = currentUser.username.slice(0, 1).toUpperCase();
    return `
      <button class="account-chip" type="button" data-account-menu aria-expanded="false" aria-label="Mở menu tài khoản ${escapeHtml(currentUser.username)}">
        <span aria-hidden="true">${escapeHtml(initial)}</span><b>${escapeHtml(currentUser.username)}</b>
      </button>
      <div class="account-popover" data-account-popover hidden>
        <div><span>Tài khoản RealView</span><strong>${escapeHtml(currentUser.username)}</strong><small>${escapeHtml(currentUser.email)}</small></div>
        <button type="button" data-auth-logout>Đăng xuất</button>
      </div>`;
  }
  return `
    <button class="auth-button auth-button--access" type="button" data-auth-open="login" aria-label="Mở cửa sổ đăng nhập hoặc đăng ký">Đăng nhập / Đăng ký</button>`;
}

function renderAccountControls() {
  document.querySelectorAll('[data-auth-controls]').forEach((slot) => {
    slot.classList.toggle('is-signed-in', Boolean(currentUser));
    slot.innerHTML = accountControlsMarkup();
  });
}

function ensureAccountControls() {
  document.querySelectorAll('.site-header .header-inner').forEach((header) => {
    if (header.querySelector('[data-auth-controls]')) return;
    const slot = document.createElement('div');
    slot.className = 'header-auth';
    slot.dataset.authControls = '';
    const contact = header.querySelector('.header-contact');
    if (contact) contact.insertAdjacentElement('afterend', slot);
    else header.querySelector('.nav-toggle')?.insertAdjacentElement('beforebegin', slot);
  });
  renderAccountControls();
}

function dialogMarkup() {
  return `
    <dialog id="account-dialog" class="account-dialog" aria-labelledby="account-dialog-title">
      <div class="account-dialog-shell">
        <button class="account-dialog-close" type="button" data-auth-close aria-label="Đóng cửa sổ tài khoản">×</button>
        <div class="account-dialog-brand" aria-hidden="true"><img src="/assets/realview-rv.png" alt="" /></div>
        <div class="account-dialog-heading">
          <span>TÀI KHOẢN REALVIEW</span>
          <h2 id="account-dialog-title">Chào mừng bạn trở lại</h2>
          <p data-auth-description>Đăng nhập để xem lịch sử phân tích trên mọi lần truy cập.</p>
        </div>
        <p class="account-dialog-notice" data-auth-notice hidden></p>
        <div class="account-tabs" role="tablist" aria-label="Chọn đăng nhập hoặc đăng ký">
          <button id="auth-login-tab" type="button" role="tab" data-auth-tab="login" aria-controls="auth-login-panel">Đăng nhập</button>
          <button id="auth-register-tab" type="button" role="tab" data-auth-tab="register" aria-controls="auth-register-panel">Đăng ký</button>
        </div>
        <form id="auth-login-panel" class="account-form" data-auth-form="login" role="tabpanel" aria-labelledby="auth-login-tab">
          <label><span>Tên đăng nhập</span><input name="username" type="text" autocomplete="username" minlength="3" maxlength="30" required placeholder="Nhập tên đăng nhập" /></label>
          <label><span>Mật khẩu</span><input name="password" type="password" autocomplete="current-password" minlength="8" maxlength="128" required placeholder="Nhập mật khẩu" /></label>
          <p class="account-form-error" data-auth-error role="alert" hidden></p>
          <button class="account-submit" type="submit">Đăng nhập <span aria-hidden="true">→</span></button>
          <button class="account-forgot" type="button" data-auth-mode="request_password_reset">Quên mật khẩu?</button>
          <p class="account-switch">Chưa có tài khoản? <button type="button" data-auth-tab="register">Đăng ký ngay</button></p>
        </form>
        <form id="auth-register-panel" class="account-form" data-auth-form="register" role="tabpanel" aria-labelledby="auth-register-tab" hidden>
          <label><span>Email</span><input name="email" type="email" autocomplete="email" maxlength="254" required placeholder="ban@example.com" /></label>
          <label><span>Tên đăng nhập</span><input name="username" type="text" autocomplete="username" minlength="3" maxlength="30" pattern="[A-Za-z0-9._]{3,30}" required placeholder="3–30 ký tự" /></label>
          <label><span>Mật khẩu</span><input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required placeholder="Tối thiểu 8 ký tự" /></label>
          <p class="account-form-help">Email được lưu trong hồ sơ tài khoản để RealView có thể gửi thông báo trong tương lai.</p>
          <p class="account-form-error" data-auth-error role="alert" hidden></p>
          <button class="account-submit" type="submit">Tạo tài khoản <span aria-hidden="true">→</span></button>
          <p class="account-switch">Đã có tài khoản? <button type="button" data-auth-tab="login">Đăng nhập</button></p>
        </form>
        <form id="auth-forgot-panel" class="account-form" data-auth-form="request_password_reset" hidden>
          <label><span>Email đã đăng ký</span><input name="email" type="email" autocomplete="email" maxlength="254" required placeholder="ban@example.com" /></label>
          <p class="account-form-help">RealView sẽ gửi mã xác minh 6 số. Mã có hiệu lực trong 10 phút.</p>
          <p class="account-form-error" data-auth-error role="alert" hidden></p>
          <button class="account-submit" type="submit">Gửi mã xác minh <span aria-hidden="true">→</span></button>
          <p class="account-switch"><button type="button" data-auth-tab="login">Quay lại đăng nhập</button></p>
        </form>
        <form id="auth-reset-panel" class="account-form" data-auth-form="reset_password" hidden>
          <input name="requestId" type="hidden" />
          <label><span>Mã xác minh</span><input class="account-code-input" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required placeholder="000000" /></label>
          <label><span>Mật khẩu mới</span><input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required placeholder="Tối thiểu 8 ký tự" /></label>
          <label><span>Nhập lại mật khẩu mới</span><input name="passwordConfirm" type="password" autocomplete="new-password" minlength="8" maxlength="128" required placeholder="Nhập lại mật khẩu" /></label>
          <p class="account-form-error" data-auth-error role="alert" hidden></p>
          <button class="account-submit" type="submit">Đặt mật khẩu mới <span aria-hidden="true">→</span></button>
          <p class="account-switch">Chưa nhận được mã? <button type="button" data-auth-mode="request_password_reset">Gửi lại mã</button></p>
        </form>
      </div>
    </dialog>`;
}

function ensureDialog() {
  let dialog = document.querySelector('#account-dialog');
  if (dialog) return dialog;
  document.body.insertAdjacentHTML('beforeend', dialogMarkup());
  dialog = document.querySelector('#account-dialog');
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeAuthDialog();
  });
  dialog.addEventListener('close', () => {
    document.body.classList.remove('account-dialog-open');
    returnFocus?.focus?.();
  });
  return dialog;
}

function setMode(mode = 'login') {
  const dialog = ensureDialog();
  const modes = ['login', 'register', 'request_password_reset', 'reset_password'];
  const activeMode = modes.includes(mode) ? mode : 'login';
  dialog.querySelectorAll('[data-auth-tab]').forEach((tab) => {
    const active = tab.dataset.authTab === activeMode;
    if (tab.getAttribute('role') === 'tab') {
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    }
  });
  dialog.querySelectorAll('[data-auth-form]').forEach((form) => {
    form.hidden = form.dataset.authForm !== activeMode;
  });
  dialog.querySelector('.account-tabs').hidden = !['login', 'register'].includes(activeMode);
  const copy = {
    login: ['Chào mừng bạn trở lại', 'Đăng nhập để tiếp tục xem lịch sử phân tích.'],
    register: ['Tạo tài khoản RealView', 'Lưu lịch sử phân tích riêng theo tài khoản của bạn.'],
    request_password_reset: ['Khôi phục mật khẩu', 'Nhập email đã đăng ký để nhận mã xác minh.'],
    reset_password: ['Tạo mật khẩu mới', 'Nhập mã trong email và chọn mật khẩu mới cho tài khoản.']
  }[activeMode];
  dialog.querySelector('#account-dialog-title').textContent = copy[0];
  dialog.querySelector('[data-auth-description]').textContent = copy[1];
  dialog.querySelectorAll('[data-auth-error]').forEach((error) => {
    error.hidden = true;
    error.textContent = '';
  });
  window.setTimeout(() => dialog.querySelector(`[data-auth-form="${activeMode}"] input`)?.focus(), 40);
}

export function openAuthDialog({ mode = 'login', message = '' } = {}) {
  const dialog = ensureDialog();
  returnFocus = document.activeElement;
  setMode(mode);
  const notice = dialog.querySelector('[data-auth-notice]');
  notice.textContent = message;
  notice.hidden = !message;
  if (!dialog.open) dialog.showModal();
  document.body.classList.add('account-dialog-open');
}

export function closeAuthDialog() {
  const dialog = document.querySelector('#account-dialog');
  if (dialog?.open) dialog.close();
}

export async function getCurrentUser({ refresh = false } = {}) {
  if (statusPromise && !refresh) return statusPromise;
  statusPromise = fetch('/api/auth', { credentials: 'same-origin', cache: 'no-store' })
    .then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      currentUser = response.ok ? payload.user || null : null;
      renderAccountControls();
      return currentUser;
    })
    .catch(() => {
      currentUser = null;
      renderAccountControls();
      return null;
    });
  return statusPromise;
}

async function submitAccountForm(form) {
  const action = form.dataset.authForm;
  const errorBox = form.querySelector('[data-auth-error]');
  const submit = form.querySelector('[type="submit"]');
  errorBox.hidden = true;
  submit.disabled = true;
  submit.dataset.label = submit.innerHTML;
  const pendingLabels = {
    register: 'Đang tạo tài khoản…',
    login: 'Đang đăng nhập…',
    request_password_reset: 'Đang gửi mã…',
    reset_password: 'Đang cập nhật…'
  };
  submit.textContent = pendingLabels[action] || 'Đang xử lý…';
  try {
    const values = Object.fromEntries(new FormData(form));
    if (action === 'reset_password') {
      if (values.password !== values.passwordConfirm) {
        throw new Error('Mật khẩu nhập lại chưa trùng khớp.');
      }
      delete values.passwordConfirm;
    }
    const payload = await apiRequest({ action, ...values });
    if (action === 'request_password_reset') {
      const resetForm = ensureDialog().querySelector('[data-auth-form="reset_password"]');
      resetForm.elements.requestId.value = payload.resetId;
      setMode('reset_password');
      const notice = ensureDialog().querySelector('[data-auth-notice]');
      notice.textContent = payload.message;
      notice.hidden = false;
      return;
    }
    currentUser = payload.user;
    statusPromise = Promise.resolve(currentUser);
    renderAccountControls();
    closeAuthDialog();
    const eventName = action === 'register' ? 'sign_up' : action === 'reset_password' ? 'password_reset' : 'login';
    window.realviewTrackEvent?.(eventName, { method: action === 'reset_password' ? 'email_code' : 'username' });
    window.dispatchEvent(new CustomEvent('realview:auth-changed', { detail: { user: currentUser } }));
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    submit.disabled = false;
    submit.innerHTML = submit.dataset.label;
  }
}

async function logout() {
  await apiRequest({ action: 'logout' }).catch(() => {});
  currentUser = null;
  statusPromise = Promise.resolve(null);
  renderAccountControls();
  window.dispatchEvent(new CustomEvent('realview:auth-changed', { detail: { user: null } }));
}

function initialize() {
  ensureAccountControls();
  ensureDialog();
  getCurrentUser();
  document.addEventListener('click', (event) => {
    const open = event.target.closest('[data-auth-open]');
    if (open) {
      openAuthDialog({ mode: open.dataset.authOpen });
      return;
    }
    if (event.target.closest('[data-auth-close]')) {
      closeAuthDialog();
      return;
    }
    const tab = event.target.closest('[data-auth-tab]');
    if (tab) {
      setMode(tab.dataset.authTab);
      return;
    }
    const mode = event.target.closest('[data-auth-mode]');
    if (mode) {
      const notice = ensureDialog().querySelector('[data-auth-notice]');
      notice.hidden = true;
      notice.textContent = '';
      setMode(mode.dataset.authMode);
      return;
    }
    const menu = event.target.closest('[data-account-menu]');
    if (menu) {
      const popover = menu.parentElement.querySelector('[data-account-popover]');
      const openState = popover.hidden;
      popover.hidden = !openState;
      menu.setAttribute('aria-expanded', String(openState));
      return;
    }
    if (event.target.closest('[data-auth-logout]')) logout();
    else document.querySelectorAll('[data-account-popover]').forEach((popover) => { popover.hidden = true; });
  });
  document.addEventListener('submit', (event) => {
    const form = event.target.closest('[data-auth-form]');
    if (!form) return;
    event.preventDefault();
    submitAccountForm(form);
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();

