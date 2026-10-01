let currentUser = null;
let statusPromise;
let currentBlogRole = null;
let currentBlogCapabilities = null;
let blogAccessPromise;
let returnFocus;
let pendingRegistration = null;
let googleController, googleControllerPromise;
let authBusy = false;
let passwordContext = 'request_password_reset';
let authRevision = 0;

function setAuthBusy(busy) {
  authBusy = busy;
  const dialog = ensureDialog();
  dialog.setAttribute('aria-busy', String(busy));
  dialog.querySelector('[data-auth-close]').disabled = busy;
  dialog.querySelector('[data-google-button]').classList.toggle('is-busy', busy);
}

async function prepareGoogleLogin() {
  if (!googleControllerPromise) googleControllerPromise = import('./google-login.js').then(({ createGoogleLoginController }) => {
    googleController = createGoogleLoginController({ dialog: ensureDialog(), setMode, onSignedIn: payload => finishAuthentication(payload, 'google'), setBusy: setAuthBusy, isBusy: () => authBusy });
    return googleController;
  }).catch(error => { googleControllerPromise = null; throw error; });
  try { const controller = await googleControllerPromise; if (ensureDialog().open) await controller.prepare(); }
  catch {
    const box = ensureDialog().querySelector('[data-google-error]');
    box.hidden = false;
    box.querySelector('p').textContent = 'Chưa thể tải đăng nhập Google. Bạn vẫn có thể dùng mật khẩu bên dưới.';
  }
}

function finishAuthentication(payload, method) {
  authRevision++;
  currentUser = payload.user;
  currentBlogRole = null; currentBlogCapabilities = null;
  statusPromise = Promise.resolve(currentUser);
  pendingRegistration = null;
  setAuthBusy(false);
  renderAccountControls();
  closeAuthDialog();
  void refreshBlogAccess({ refresh: true });
  if (payload.showOfflineConsentNotice) showOfflineConsentNotice(currentUser);
  showMarketingConsentPrompt(currentUser);
  window.realviewTrackEvent?.(payload.created ? 'sign_up' : 'login', { method });
  window.dispatchEvent(new CustomEvent('realview:auth-changed', { detail: { user: currentUser } }));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

async function apiRequest(body) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload.error || 'Không thể xử lý yêu cầu lúc này.'), { code: payload.code, accountResponse: true });
    return payload;
  } catch (error) {
    if (error.accountResponse) throw error;
    throw new Error('Chưa thể kết nối với RealView. Vui lòng kiểm tra mạng rồi thử lại.');
  } finally { window.clearTimeout(timeout); }
}

function accountControlsMarkup() {
  if (currentUser) {
    const name = currentUser.displayName || currentUser.username;
    const initial = Array.from(name)[0]?.toUpperCase() || 'R';
    return `
      <button class="account-chip" type="button" data-account-menu aria-expanded="false" aria-label="Mở menu tài khoản ${escapeHtml(currentUser.username)}">
        <span aria-hidden="true">${escapeHtml(initial)}</span><b>${escapeHtml(name)}</b>
      </button>
      <div class="account-popover" data-account-popover hidden>
        <div><span>Tài khoản RealView</span><strong>${escapeHtml(currentUser.username)}</strong><small>${escapeHtml(currentUser.email)}</small></div>
        <p class="account-email-preference"><strong>Email cập nhật RealView</strong><span>${currentUser.emailMarketingConsent?.status === 'subscribed' ? 'Đã đồng ý nhận' : 'Chưa đăng ký nhận'}</span></p>
        ${currentBlogCapabilities?.managePosts ? '<a class="account-admin-link" href="/admin/blog"><i aria-hidden="true">✎</i><b>Quản trị bài viết<small>Đăng và chỉnh sửa Blog</small></b></a>' : ''}
        ${currentBlogCapabilities?.manageAccess ? '<a class="account-admin-link account-admin-link--access" href="/admin/access"><i aria-hidden="true">⌘</i><b>Quyền truy cập<small>Quản lý admin và editor</small></b></a>' : ''}
        <button class="account-password-action" type="button" data-auth-password>${currentUser.hasPassword === false ? 'Thêm mật khẩu RealView' : 'Đổi mật khẩu'}</button>
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
        <div class="google-option" data-google-option hidden>
          <div class="google-button-slot" data-google-button></div>
          <p class="google-purpose">Chỉ dùng thông tin cơ bản để xác thực tài khoản.</p>
          <p class="google-status" data-google-status role="status" aria-live="polite" hidden><span class="google-spinner" aria-hidden="true" hidden></span><span data-google-status-text></span></p>
          <div class="google-error" data-google-error role="alert" hidden><p></p><button type="button" data-google-retry>Thử lại với Google</button></div>
          <div class="auth-divider">hoặc dùng tài khoản RealView</div>
        </div>
        <form id="auth-login-panel" class="account-form" data-auth-form="login" role="tabpanel" aria-labelledby="auth-login-tab">
          <label><span>Email hoặc tên đăng nhập</span><input name="identifier" type="text" autocomplete="username" maxlength="254" required placeholder="Nhập email hoặc tên đăng nhập" /></label>
          <label><span>Mật khẩu</span><input name="password" type="password" autocomplete="current-password" minlength="8" maxlength="128" required placeholder="Nhập mật khẩu" /></label>
          <p class="account-form-error" data-auth-error role="alert" hidden></p>
          <button class="account-forgot" type="button" data-auth-mode="request_password_reset">Quên mật khẩu?</button>
          <button class="account-submit" type="submit">Đăng nhập <span aria-hidden="true">→</span></button>
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
          <p class="account-form-help">Mã có hiệu lực trong 10 phút. Nếu trước đây chỉ dùng Google, bạn có thể xác minh email để thêm mật khẩu RealView. Mật khẩu Google không thay đổi.</p>
          <p class="account-form-error" data-auth-error role="alert" hidden></p>
          <button class="account-submit" type="submit">Gửi mã xác minh <span aria-hidden="true">→</span></button>
          <p class="account-switch"><button type="button" data-auth-tab="login">Quay lại đăng nhập</button></p>
        </form>
        <form class="account-form" data-auth-form="request_password_change" hidden>
          <label><span>Email tài khoản</span><input name="email" type="email" autocomplete="email" readonly required /></label>
          <p class="account-form-help">Xác minh bằng mã gửi đến email này trước khi cập nhật mật khẩu RealView. Việc này không thay đổi mật khẩu Google.</p>
          <p class="account-form-error" data-auth-error role="alert" hidden></p>
          <button class="account-submit" type="submit">Gửi mã xác minh <span aria-hidden="true">→</span></button>
        </form>
        <form id="auth-reset-panel" class="account-form" data-auth-form="reset_password" hidden>
          <input name="requestId" type="hidden" />
          <label><span>Mã xác minh</span><input class="account-code-input" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required placeholder="000000" /></label>
          <label><span>Mật khẩu mới</span><input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required placeholder="Tối thiểu 8 ký tự" /></label>
          <label><span>Nhập lại mật khẩu mới</span><input name="passwordConfirm" type="password" autocomplete="new-password" minlength="8" maxlength="128" required placeholder="Nhập lại mật khẩu" /></label>
          <p class="account-form-error" data-auth-error role="alert" hidden></p>
          <button class="account-submit" type="submit">Đặt mật khẩu mới <span aria-hidden="true">→</span></button>
          <p class="account-form-help">Mã dùng một lần, hết hạn sau 10 phút. Gửi lại sau ít nhất 60 giây; mã cũ sẽ hết hiệu lực. Các phiên đăng nhập cũ sẽ được đăng xuất khi mật khẩu cập nhật.</p>
          <p class="account-switch">Chưa nhận được mã? <button type="button" data-auth-resend>Gửi lại mã</button></p>
        </form>
        <form class="account-form" data-auth-form="google_link" hidden>
          <p class="auth-explanation">Email này đã có tài khoản RealView. Nhập mật khẩu RealView của tài khoản đó để xác nhận liên kết. Lịch sử của bạn được giữ nguyên.</p>
          <label><span>Mật khẩu RealView</span><input name="password" type="password" autocomplete="current-password" minlength="8" maxlength="128" required /></label>
          <p class="account-form-error" data-auth-error role="alert" hidden></p>
          <button class="account-submit" type="submit">Xác nhận và liên kết</button>
          <p class="account-switch"><button type="button" data-auth-mode="request_password_reset">Quên mật khẩu RealView?</button></p>
          <button class="auth-secondary" type="button" data-auth-tab="login">Quay lại đăng nhập</button>
        </form>
        <form class="account-form" data-auth-form="google_email_request" hidden>
          <p class="auth-explanation">Google chưa đủ thông tin để xác minh quyền sở hữu email này. RealView sẽ gửi thêm một mã xác minh; không yêu cầu tạo mật khẩu.</p>
          <p class="account-form-error" data-auth-error role="alert" hidden></p>
          <button class="account-submit" type="submit">Gửi mã xác minh email</button>
          <button class="auth-secondary" type="button" data-auth-tab="login">Quay lại đăng nhập</button>
        </form>
        <form class="account-form" data-auth-form="google_email_verify" hidden>
          <label><span>Mã xác minh email</span><input class="account-code-input" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required placeholder="000000" /></label>
          <p class="account-form-help">Mã có hiệu lực trong 10 phút và chỉ dùng được một lần.</p>
          <p class="account-form-error" data-auth-error role="alert" hidden></p>
          <button class="account-submit" type="submit">Xác minh và tiếp tục</button>
          <button class="auth-secondary" type="button" data-auth-google-resend>Gửi lại mã</button>
          <button class="account-forgot" type="button" data-auth-tab="login">Quay lại đăng nhập</button>
        </form>
        <p class="auth-legal">Khi tiếp tục, bạn đồng ý với <a href="/dieu-khoan-su-dung" target="_blank" rel="noopener">Điều khoản sử dụng</a> và xác nhận đã đọc <a href="/chinh-sach-bao-mat" target="_blank" rel="noopener">Chính sách bảo mật</a>.</p>
      </div>
    </dialog>`;
}

function ensureDialog() {
  let dialog = document.querySelector('#account-dialog');
  if (dialog) return dialog;
  document.body.insertAdjacentHTML('beforeend', dialogMarkup());
  dialog = document.querySelector('#account-dialog');
  dialog.querySelectorAll('input[type="password"]').forEach((input, index) => {
    const original = input.closest('label');
    const group = document.createElement('div'); group.className = 'password-group';
    const label = document.createElement('label');
    input.id = `realview-password-${index}`;
    label.htmlFor = input.id; label.textContent = original.querySelector('span').textContent;
    const field = document.createElement('div'); field.className = 'password-field';
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.dataset.authPasswordToggle = input.id;
    toggle.textContent = 'Hiện'; toggle.setAttribute('aria-label', 'Hiện mật khẩu'); toggle.setAttribute('aria-pressed', 'false');
    original.replaceWith(group); field.append(input, toggle); group.append(label, field);
  });
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); closeAuthDialog(); });
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

function showAccountMessage(message) {
  const notice = document.createElement('aside');
  notice.className = 'account-consent-toast'; notice.setAttribute('role', 'status');
  notice.innerHTML = `<p>${escapeHtml(message)}</p><button type="button" aria-label="Đóng thông báo">×</button>`;
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

function setMode(mode = 'login', { focus = true } = {}) {
  const dialog = ensureDialog();
  const modes = ['login', 'register', 'verify_registration', 'request_password_reset', 'request_password_change', 'reset_password', 'google_link', 'google_email_request', 'google_email_verify'];
  const activeMode = modes.includes(mode) ? mode : 'login';
  dialog.dataset.mode = activeMode;
  if (['request_password_reset', 'request_password_change'].includes(activeMode)) passwordContext = activeMode;
  if (activeMode === 'request_password_change') dialog.querySelector('[data-auth-form="request_password_change"]').elements.email.value = currentUser?.email || '';
  dialog.querySelectorAll('[data-auth-tab]').forEach((tab) => {
    const active = tab.dataset.authTab === activeMode;
    if (tab.getAttribute('role') === 'tab') {
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    }
  });
  dialog.querySelectorAll('[data-auth-form]').forEach((form) => {
    form.hidden = form.dataset.authForm !== activeMode;
    if (form.hidden) form.querySelectorAll('input[type="password"], input[data-was-password], input[name="code"]').forEach(input => { input.value = ''; });
  });
  const googleOption = dialog.querySelector('[data-google-option]');
  googleOption.hidden = !['login', 'register'].includes(activeMode);
  dialog.querySelector('.account-tabs').hidden = !['login', 'register'].includes(activeMode);
  const copy = {
    login: ['Chào mừng bạn trở lại', 'Đăng nhập để tiếp tục xem lịch sử phân tích.'],
    register: ['Tạo tài khoản RealView', 'Lưu lịch sử phân tích riêng theo tài khoản của bạn.'],
    verify_registration: ['Xác minh email', 'Nhập mã đã gửi đến email để hoàn tất tạo tài khoản.'],
    request_password_reset: ['Khôi phục mật khẩu', 'Nhập email đã đăng ký để nhận mã xác minh.'],
    request_password_change: [currentUser?.hasPassword === false ? 'Thêm mật khẩu RealView' : 'Đổi mật khẩu RealView', 'Xác minh email trước khi thay đổi phương thức đăng nhập.'],
    reset_password: ['Tạo mật khẩu RealView', 'Dùng mật khẩu này để đăng nhập RealView bằng email hoặc tên đăng nhập. Mật khẩu Google không thay đổi.'],
    google_link: ['Xác nhận liên kết tài khoản', 'Một tài khoản, giữ nguyên lịch sử phân tích.'],
    google_email_request: ['Xác minh email của bạn', 'Thêm một bước xác minh để bảo vệ tài khoản.'],
    google_email_verify: ['Kiểm tra email của bạn', 'Nhập mã 6 số để hoàn tất đăng nhập Google.']
  }[activeMode];
  dialog.querySelector('#account-dialog-title').textContent = copy[0];
  dialog.querySelector('[data-auth-description]').textContent = copy[1];
  dialog.querySelectorAll('[data-auth-error]').forEach((error) => {
    error.hidden = true;
    error.textContent = '';
  });
  if (focus) window.setTimeout(() => dialog.querySelector(`[data-auth-form="${activeMode}"] input`)?.focus(), 40);
  if (dialog.open && ['login', 'register'].includes(activeMode)) void prepareGoogleLogin();
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
  if (['login', 'register'].includes(mode)) void prepareGoogleLogin();
}

export function closeAuthDialog() {
  if (authBusy) return;
  pendingRegistration = null;
  googleController?.close();
  const dialog = document.querySelector('#account-dialog');
  dialog?.querySelectorAll('[data-auth-form]').forEach(form => form.reset());
  dialog?.querySelectorAll('[data-auth-password-toggle]').forEach(button => {
    const input = document.getElementById(button.dataset.authPasswordToggle);
    input.type = 'password'; button.textContent = 'Hiện'; button.setAttribute('aria-pressed', 'false'); button.setAttribute('aria-label', 'Hiện mật khẩu');
  });
  if (dialog?.open) dialog.close();
}

export async function getCurrentUser({ refresh = false } = {}) {
  if (statusPromise && !refresh) return statusPromise;
  const revision = authRevision;
  statusPromise = fetch('/api/auth', { credentials: 'same-origin', cache: 'no-store' })
    .then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (revision !== authRevision) return currentUser;
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
      if (revision !== authRevision) return currentUser;
      currentUser = null;
      currentBlogRole = null;
      currentBlogCapabilities = null;
      renderAccountControls();
      return null;
    });
  return statusPromise;
}

async function submitAccountForm(form) {
  if (authBusy) return;
  setAuthBusy(true);
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
    if (action === 'google_link') { await googleController.completeLink(values.password); return; }
    if (action === 'google_email_request') { await googleController.sendCode(); setMode('google_email_verify'); return; }
    if (action === 'google_email_verify') { await googleController.verifyCode(values.code); return; }
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
      finishAuthentication({ ...payload, created: true }, 'verified_email');
      return;
    }
    if (action === 'reset_password') {
      if (values.password !== values.passwordConfirm) {
        throw new Error('Mật khẩu nhập lại chưa trùng khớp.');
      }
      delete values.passwordConfirm;
    }
    const payload = await apiRequest({ action, ...values });
    if (['request_password_reset', 'request_password_change'].includes(action)) {
      const resetForm = ensureDialog().querySelector('[data-auth-form="reset_password"]');
      resetForm.elements.requestId.value = payload.resetId;
      setMode('reset_password');
      const notice = ensureDialog().querySelector('[data-auth-notice]');
      notice.textContent = payload.message;
      notice.hidden = false;
      return;
    }
    finishAuthentication(payload, action === 'reset_password' ? 'email_code' : 'password');
    if (action === 'reset_password') {
      window.realviewTrackEvent?.('password_reset', { method: 'email_code' });
      showAccountMessage('Mật khẩu RealView đã được cập nhật. Bạn có thể đăng nhập bằng email hoặc tên đăng nhập; liên kết Google và lịch sử được giữ nguyên.');
    }
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    setAuthBusy(false);
    submit.disabled = false;
    submit.innerHTML = submit.dataset.label;
  }
}

async function logout() {
  if (authBusy) return;
  setAuthBusy(true);
  try { await apiRequest({ action: 'logout' }); }
  catch { showAccountMessage('Chưa thể xác nhận đăng xuất. Vui lòng kiểm tra kết nối rồi thử lại.'); return; }
  finally { setAuthBusy(false); }
  googleController?.logout();
  authRevision++;
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
  // Keep the account button interactive immediately, but defer the optional
  // session lookup until after the mobile hero has finished its first load.
  if (document.querySelector('#analyze-form') && window.matchMedia('(max-width: 700px)').matches) {
    const loadSession = () => window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      if ('requestIdleCallback' in window) window.requestIdleCallback(() => { void getCurrentUser(); }, { timeout: 2000 });
      else window.setTimeout(() => { void getCurrentUser(); }, 200);
    }));
    if (document.readyState === 'complete') loadSession();
    else window.addEventListener('load', loadSession, { once: true });
  } else {
    void getCurrentUser();
  }
  document.addEventListener('click', (event) => {
    if (authBusy && event.target.closest('#account-dialog, [data-auth-open], [data-auth-password], [data-auth-logout]')) return;
    const passwordToggle = event.target.closest('[data-auth-password-toggle]');
    if (passwordToggle) {
      const input = document.getElementById(passwordToggle.dataset.authPasswordToggle);
      input.dataset.wasPassword = '';
      const visible = input.type === 'password'; input.type = visible ? 'text' : 'password';
      passwordToggle.textContent = visible ? 'Ẩn' : 'Hiện';
      passwordToggle.setAttribute('aria-pressed', String(visible));
      passwordToggle.setAttribute('aria-label', visible ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'); return;
    }
    if (event.target.closest('[data-auth-password]') && currentUser) {
      openAuthDialog({ mode: 'request_password_change' }); return;
    }
    if (event.target.closest('[data-auth-resend]')) { setMode(passwordContext); return; }
    if (event.target.closest('[data-auth-google-resend]')) { setMode('google_email_request'); return; }
    if (event.target.closest('[data-google-retry]')) { if (googleController) void googleController.retry(); else void prepareGoogleLogin(); return; }
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
  ensureDialog().querySelector('.account-tabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || authBusy) return;
    event.preventDefault();
    const mode = event.key === 'Home' ? 'login' : event.key === 'End' ? 'register' : ensureDialog().dataset.mode === 'login' ? 'register' : 'login';
    setMode(mode, { focus: false }); ensureDialog().querySelector(`[role="tab"][data-auth-tab="${mode}"]`).focus();
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

