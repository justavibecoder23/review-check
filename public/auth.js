let currentUser = null;
let statusPromise;
let currentBlogRole = null;
let currentBlogCapabilities = null;
let blogAccessPromise;
let returnFocus;
let pendingRegistration = null;

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
        <p class="account-email-preference"><strong>Email cập nhật RealView</strong><span>${currentUser.emailMarketingConsent?.status === 'subscribed' ? 'Đã đồng ý nhận' : 'Chưa đăng ký nhận'}</span></p>
        ${currentBlogCapabilities?.managePosts ? '<a class="account-admin-link" href="/admin/blog"><i aria-hidden="true">✎</i><b>Quản trị bài viết<small>Đăng và chỉnh sửa Blog</small></b></a>' : ''}
        ${currentBlogCapabilities?.manageAccess ? '<a class="account-admin-link account-admin-link--access" href="/admin/access"><i aria-hidden="true">⌘</i><b>Quyền truy cập<small>Quản lý admin và editor</small></b></a>' : ''}
        <button type="button" data-auth-logout>Đăng xuất</button>
      </div>`;
  }
  return `
    <button class="auth-button auth-button--access" type="button" data-auth-open="login" aria-label="Đăng nhập / Đăng ký"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21c0-5 3-8 8-8s8 3 8 8" /></svg><span>Đăng nhập / Đăng ký</span></button>`;
}

function renderAccountControls() {
  document.querySelectorAll('[data-auth-controls]').forEach((slot) => {
    slot.classList.toggle('is-signed-in', Boolean(currentUser));
    slot.innerHTML = accountControlsMarkup();
  });
}

async function refreshBlogAccess({ refresh = false } = {}) {
  if (!currentUser) {
    currentBlogRole = null;
    currentBlogCapabilities = null;
    blogAccessPromise = null;
    renderAccountControls();
    return null;
  }
  if (blogAccessPromise && !refresh) return blogAccessPromise;
  const accountId = currentUser.id;
  blogAccessPromise = fetch('/api/admin-blog?action=access', {
    credentials: 'same-origin',
    cache: 'no-store'
  }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (currentUser?.id !== accountId) return null;
    currentBlogRole = response.ok && ['admin', 'editor'].includes(payload.role) ? payload.role : null;
    currentBlogCapabilities = currentBlogRole ? {
      managePosts: payload.capabilities?.managePosts !== false,
      publishPosts: payload.capabilities?.publishPosts === true,
      manageAccess: payload.capabilities?.manageAccess === true
    } : null;
    renderAccountControls();
    return currentBlogRole;
  }).catch(() => {
    if (currentUser?.id === accountId) {
      currentBlogRole = null;
      currentBlogCapabilities = null;
      renderAccountControls();
    }
    return null;
  });
  return blogAccessPromise;
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
        <div class="account-dialog-brand" aria-hidden="true"><img src="/assets/realview-logo-v1.webp" alt="" width="128" height="75" /></div>
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
          <label class="account-claim-history"><input name="claimGuestHistory" type="checkbox" checked /><span>Đưa các kết quả dùng thử trên thiết bị này vào lịch sử tài khoản</span></label>
          <p class="account-form-help">Email này dùng cho hồ sơ tài khoản và thông báo dịch vụ như thư chào mừng hoặc khôi phục mật khẩu.</p>
          <label class="account-consent-option">
            <input name="emailMarketingConsent" type="checkbox" value="true" />
            <span><strong>Đồng ý nhận email marketing từ RealView (không bắt buộc)</strong><small>Tin hướng dẫn đọc review, cập nhật tính năng và nội dung hữu ích. Lựa chọn này không ảnh hưởng việc tạo tài khoản.</small></span>
          </label>
          <p class="account-form-error" data-auth-error role="alert" hidden></p>
          <button class="account-submit" type="submit">Gửi mã xác minh <span aria-hidden="true">→</span></button>
          <p class="account-switch">Đã có tài khoản? <button type="button" data-auth-tab="login">Đăng nhập</button></p>
        </form>
        <form id="auth-register-verification-panel" class="account-form" data-auth-form="verify_registration" hidden>
          <input name="verificationId" type="hidden" />
          <label><span>Mã xác minh email</span><input class="account-code-input" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required placeholder="000000" /></label>
          <p class="account-form-help">Mã gồm 6 số, có hiệu lực trong 10 phút và chỉ dùng được một lần.</p>
          <p class="account-form-error" data-auth-error role="alert" hidden></p>
          <button class="account-submit" type="submit">Xác minh và tạo tài khoản <span aria-hidden="true">→</span></button>
          <p class="account-switch"><button type="button" data-auth-tab="register">Đổi email hoặc gửi lại mã</button></p>
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
  dialog.addEventListener('cancel', (event) => event.preventDefault());
  dialog.addEventListener('close', () => {
    document.body.classList.remove('account-dialog-open');
    returnFocus?.focus?.();
  });
  return dialog;
}

function showOfflineConsentNotice(user) {
  if (!user || user.emailMarketingConsent?.source !== 'offline') return;
  const notice = document.createElement('aside');
  notice.className = 'account-consent-toast';
  notice.setAttribute('role', 'status');
  notice.innerHTML = '<strong>Bạn đã đăng ký nhận email RealView</strong><p>Chúng tôi đã ghi nhận lựa chọn đồng ý nhận email mà bạn xác nhận trước đây. Email dịch vụ của tài khoản được gửi riêng.</p><button type="button" aria-label="Đóng thông báo">×</button>';
  notice.querySelector('button').addEventListener('click', () => notice.remove());
  document.body.append(notice);
}

function ensureMarketingConsentDialog() {
  let dialog = document.querySelector('#marketing-consent-dialog');
  if (dialog) return dialog;
  document.body.insertAdjacentHTML('beforeend', `
    <dialog id="marketing-consent-dialog" class="marketing-consent-dialog" aria-labelledby="marketing-consent-title" aria-describedby="marketing-consent-description">
      <div class="marketing-consent-card">
        <button class="marketing-consent-close" type="button" data-marketing-consent-dismiss aria-label="Để sau">×</button>
        <span class="marketing-consent-mark" aria-hidden="true">R</span>
        <p class="marketing-consent-eyebrow">MỘT LỜI MỜI TỪ REALVIEW</p>
        <h2 id="marketing-consent-title">Nhận thêm góc nhìn hữu ích</h2>
        <p id="marketing-consent-description" class="marketing-consent-copy">Đăng ký email để nhận mẹo đọc review, hướng dẫn mua sắm sáng suốt và thông tin tính năng mới từ RealView.</p>
        <div class="marketing-consent-details">
          <span aria-hidden="true">✦</span>
          <p>Nội dung hữu ích, chọn lọc — gửi riêng với email dịch vụ của tài khoản.</p>
        </div>
        <p class="marketing-consent-error" data-marketing-consent-error role="alert" hidden></p>
        <button class="marketing-consent-accept" type="button" data-marketing-consent-accept>Đồng ý nhận email <span aria-hidden="true">→</span></button>
        <button class="marketing-consent-later" type="button" data-marketing-consent-dismiss>Không phải lúc này</button>
        <p class="marketing-consent-footnote">Hoàn toàn tự nguyện. Chỉ đăng ký khi bạn chọn “Đồng ý nhận email”.</p>
      </div>
    </dialog>`);
  dialog = document.querySelector('#marketing-consent-dialog');
  dialog.addEventListener('close', () => document.body.classList.remove('account-dialog-open'));
  dialog.querySelectorAll('[data-marketing-consent-dismiss]').forEach((button) => {
    button.addEventListener('click', () => dialog.close());
  });
  dialog.querySelector('[data-marketing-consent-accept]').addEventListener('click', async (event) => {
    const accept = event.currentTarget;
    const later = dialog.querySelector('.marketing-consent-later');
    const error = dialog.querySelector('[data-marketing-consent-error]');
    error.hidden = true;
    accept.disabled = true;
    later.disabled = true;
    accept.innerHTML = 'Đang lưu lựa chọn…';
    try {
      const payload = await apiRequest({ action: 'consent_email_marketing' });
      currentUser = payload.user;
      statusPromise = Promise.resolve(currentUser);
      renderAccountControls();
      dialog.close();
    } catch (requestError) {
      error.textContent = requestError.message || 'Chưa lưu được lựa chọn. Vui lòng thử lại.';
      error.hidden = false;
      accept.disabled = false;
      later.disabled = false;
      accept.innerHTML = 'Đồng ý nhận email <span aria-hidden="true">→</span>';
    }
  });
  return dialog;
}

function showMarketingConsentPrompt(user) {
  if (user?.emailMarketingConsent?.status !== 'not_subscribed') return;
  const dialog = ensureMarketingConsentDialog();
  if (!dialog.open) {
    document.body.classList.add('account-dialog-open');
    dialog.showModal();
  }
}

function setMode(mode = 'login') {
  const dialog = ensureDialog();
  const modes = ['login', 'register', 'verify_registration', 'request_password_reset', 'reset_password'];
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
    verify_registration: ['Xác minh email', 'Nhập mã đã gửi đến email để hoàn tất tạo tài khoản.'],
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
      currentBlogRole = null;
      currentBlogCapabilities = null;
      renderAccountControls();
      if (currentUser) {
        showMarketingConsentPrompt(currentUser);
        void refreshBlogAccess({ refresh: true });
      }
      return currentUser;
    })
    .catch(() => {
      currentUser = null;
      currentBlogRole = null;
      currentBlogCapabilities = null;
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
    register: 'Đang gửi mã…',
    verify_registration: 'Đang xác minh…',
    login: 'Đang đăng nhập…',
    request_password_reset: 'Đang gửi mã…',
    reset_password: 'Đang cập nhật…'
  };
  submit.textContent = pendingLabels[action] || 'Đang xử lý…';
  try {
    const values = Object.fromEntries(new FormData(form));
    if (action === 'register') {
      values.emailMarketingConsent = form.elements.emailMarketingConsent.checked;
      pendingRegistration = values;
      const payload = await apiRequest({ action: 'request_registration_verification', ...values });
      const verificationForm = ensureDialog().querySelector('[data-auth-form="verify_registration"]');
      verificationForm.elements.verificationId.value = payload.verificationId;
      setMode('verify_registration');
      const notice = ensureDialog().querySelector('[data-auth-notice]');
      notice.textContent = payload.message;
      notice.hidden = false;
      return;
    }
    if (action === 'verify_registration') {
      if (!pendingRegistration) throw new Error('Thông tin đăng ký đã hết hiệu lực. Vui lòng nhập lại.');
      const payload = await apiRequest({
        action: 'register',
        ...pendingRegistration,
        verificationId: values.verificationId,
        code: values.code
      });
      currentUser = payload.user;
      currentBlogRole = null;
      currentBlogCapabilities = null;
      pendingRegistration = null;
      statusPromise = Promise.resolve(currentUser);
      renderAccountControls();
      void refreshBlogAccess({ refresh: true });
      closeAuthDialog();
      showMarketingConsentPrompt(currentUser);
      window.realviewTrackEvent?.('sign_up', { method: 'verified_email' });
      window.dispatchEvent(new CustomEvent('realview:auth-changed', { detail: { user: currentUser } }));
      return;
    }
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
    currentBlogRole = null;
    currentBlogCapabilities = null;
    statusPromise = Promise.resolve(currentUser);
    renderAccountControls();
    if (action === 'login') {
      if (payload.showOfflineConsentNotice) showOfflineConsentNotice(currentUser);
      showMarketingConsentPrompt(currentUser);
    }
    void refreshBlogAccess({ refresh: true });
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
  currentBlogRole = null;
  currentBlogCapabilities = null;
  blogAccessPromise = null;
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

