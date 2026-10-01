// Loaded only when the account dialog is opened. Credentials stay in memory;
// only the server validates identity and creates the HttpOnly session.
let sdkPromise;
function loadGoogleSdk() {
  if (window.google?.accounts?.id) return Promise.resolve(window.google.accounts.id);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    const timer = setTimeout(() => { script.remove(); reject(new Error('Không tải được Google. Vui lòng kiểm tra kết nối rồi thử lại.')); }, 20000);
    script.onload = () => { clearTimeout(timer); window.google?.accounts?.id ? resolve(window.google.accounts.id) : reject(new Error('Google chưa sẵn sàng. Vui lòng thử lại.')); };
    script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('Không tải được Google. Bạn vẫn có thể đăng nhập bằng mật khẩu bên dưới.')); };
    document.head.append(script);
  }).catch(error => { sdkPromise = null; throw error; });
  return sdkPromise;
}

async function googleRequest(body) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch('/api/auth-google', {
      method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload.error || 'Đăng nhập Google tạm thời không khả dụng.'), { code: payload.code, accountResponse: true });
    return payload;
  } catch (error) {
    if (error.accountResponse) throw error;
    throw new Error('Chưa thể kết nối với Google. Bạn có thể thử lại hoặc dùng mật khẩu RealView.');
  } finally { window.clearTimeout(timeout); }
}

export function createGoogleLoginController({ dialog, setMode, onSignedIn, setBusy, isBusy }) {
  const option = dialog.querySelector('[data-google-option]');
  const slot = dialog.querySelector('[data-google-button]');
  const status = dialog.querySelector('[data-google-status]');
  const errorBox = dialog.querySelector('[data-google-error]');
  let sdk, challenge, pending, preparation, generation = 0, renderedWidth = 0;
  const claimHistory = () => dialog.dataset.mode === 'register' && dialog.querySelector('[data-auth-form="register"] [name="claimGuestHistory"]').checked;
  function message(text, spinning = false) {
    status.hidden = !text;
    status.querySelector('[data-google-status-text]').textContent = text;
    status.querySelector('.google-spinner').hidden = !spinning;
  }
  function showError(error) {
    message('');
    errorBox.hidden = false;
    errorBox.querySelector('p').textContent = error.message || 'Chưa thể kết nối với Google. Bạn có thể thử lại hoặc dùng mật khẩu bên dưới.';
  }
  function render() {
    const registering = dialog.dataset.mode === 'register';
    const width = Math.min(400, Math.floor(slot.clientWidth || 300));
    renderedWidth = width;
    slot.setAttribute('role', 'group');
    slot.setAttribute('aria-label', registering ? 'Đăng ký bằng tài khoản Google' : 'Đăng nhập bằng tài khoản Google');
    slot.replaceChildren();
    // Official Google labels differ by tab; both use receiveCredential and the
    // same server action, which creates a session without a RealView password.
    sdk.renderButton(slot, { type: 'standard', theme: 'outline', size: 'large', text: registering ? 'signup_with' : 'signin_with', shape: 'pill', locale: 'vi', width,
      click_listener: () => {
        if (challenge?.expiresAt <= Date.now()) {
          showError(new Error('Phiên đăng nhập đã hết hạn. Hãy nhấn “Thử lại với Google” để bắt đầu lại.'));
          return;
        }
        message('Hoàn tất trong cửa sổ Google. Nếu đã đóng cửa sổ, bạn có thể nhấn nút Google để thử lại.');
      }
    });
  }
  const resize = new ResizeObserver(() => {
    const width = Math.min(400, Math.floor(slot.clientWidth));
    if (width > 0 && width !== renderedWidth && sdk && challenge && dialog.open && ['login', 'register'].includes(dialog.dataset.mode)) render();
  });
  resize.observe(slot);
  async function receiveCredential(response) {
    if (!dialog.open || !['login', 'register'].includes(dialog.dataset.mode) || isBusy() || !challenge) return;
    setBusy(true); message('Đang xác minh tài khoản Google…', true); errorBox.hidden = true;
    try {
      const result = await googleRequest({ action: 'authenticate', challengeId: challenge.challengeId, credential: response.credential, claimGuestHistory: claimHistory() });
      challenge = null;
      if (result.status === 'signed_in') { onSignedIn(result); return; }
      if (!['link_required', 'email_required'].includes(result.status) || !result.pendingId) throw new Error('Google chưa xác minh được tài khoản. Vui lòng thử lại.');
      pending = { id: result.pendingId, expiresAt: Date.now() + result.expiresIn * 1000, claimGuestHistory: claimHistory() };
      setMode(result.status === 'link_required' ? 'google_link' : 'google_email_request');
      message('');
    } catch (error) { challenge = null; slot.replaceChildren(); showError(error); }
    finally { setBusy(false); }
  }
  async function prepare() {
    if (preparation) {
      const ticket = generation;
      await preparation;
      if (ticket !== generation || !dialog.open) return;
      if (challenge && challenge.expiresAt > Date.now()) {
        if (['login', 'register'].includes(dialog.dataset.mode)) render();
        return;
      }
    }
    const ticket = generation;
    preparation = (async () => {
      try {
        option.hidden = false; errorBox.hidden = true; message('Chuẩn bị đăng nhập Google…', true);
        const config = await googleRequest();
        if (ticket !== generation || !dialog.open) return;
        if (!config.enabled) { option.hidden = true; message(''); return; }
        sdk = await loadGoogleSdk();
        if (ticket !== generation || !dialog.open) return;
        if (!challenge || challenge.expiresAt <= Date.now()) {
          const begun = await googleRequest({ action: 'begin' });
          if (ticket !== generation || !dialog.open) return;
          challenge = { ...begun, expiresAt: Date.now() + begun.expiresIn * 1000 - 5000 };
          // Reconfigure only for a new server nonce, not on every tab switch.
          sdk.initialize({ client_id: begun.clientId, nonce: begun.nonce, callback: receiveCredential, ux_mode: 'popup', auto_select: false, button_auto_select: false });
        }
        if (['login', 'register'].includes(dialog.dataset.mode)) render();
        message('');
      } catch (error) { if (ticket === generation && dialog.open) showError(error); }
      finally { preparation = null; }
    })();
    return preparation;
  }
  async function complete(action, values = {}) {
    if (!pending || pending.expiresAt <= Date.now()) {
      pending = null;
      throw new Error('Phiên xác minh đã hết hạn. Quay lại đăng nhập bằng Google để bắt đầu lại.');
    }
    const result = await googleRequest({ action, pendingId: pending.id, ...values, claimGuestHistory: pending.claimGuestHistory });
    if (result.status === 'signed_in') { pending = null; onSignedIn(result); }
    return result;
  }
  return {
    prepare,
    retry() { challenge = null; slot.replaceChildren(); return prepare(); },
    completeLink: password => complete('link_account', { password }),
    sendCode: () => complete('request_email_verification'),
    verifyCode: code => complete('verify_email', { code }),
    close() { generation++; pending = null; slot.replaceChildren(); message(''); sdk?.cancel(); },
    logout() { challenge = null; pending = null; sdk?.disableAutoSelect(); }
  };
}
