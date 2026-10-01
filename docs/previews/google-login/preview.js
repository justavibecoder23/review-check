// Approval-only UI. No auth SDK, API request, account persistence or credentials.
const root = document.querySelector('.google-preview');
const selector = root.querySelector('#preview-state');
const card = root.querySelector('.preview-card');
const title = root.querySelector('h1');
const description = root.querySelector('#account-description');
const tabs = root.querySelector('.account-tabs');
const social = root.querySelector('.google-option');
const googleButton = root.querySelector('[data-google]');
const status = root.querySelector('.google-status');
const error = root.querySelector('.google-error');
const cancel = root.querySelector('.google-cancel');
const notice = root.querySelector('.auth-preview-status');
let timer;
let activeMode = 'login';
let emailSent = false;
const panels = [...root.querySelectorAll('.account-form')];
const headings = {
  login: ['Chào mừng bạn trở lại', 'Đăng nhập để lưu và xem lại lịch sử phân tích.'],
  register: ['Bắt đầu cùng RealView', 'Tạo tài khoản để lưu những góc nhìn hữu ích.'],
  link: ['Liên kết tài khoản của bạn', 'Xác nhận một lần để sử dụng đăng nhập Google.'],
  email: ['Xác minh địa chỉ email', 'Một bước xác nhận để bảo vệ tài khoản của bạn.'],
  forgot: ['Đặt lại mật khẩu', 'Lấy lại quyền truy cập vào tài khoản RealView.'],
  success: ['Bạn đã đăng nhập', 'Chào mừng bạn đến với RealView.']
};
function resetBusy() {
  clearTimeout(timer);
  status.hidden = true;
  googleButton.disabled = false;
  card.removeAttribute('aria-busy');
}
function render(mode) {
  resetBusy();
  activeMode = mode;
  emailSent = false;
  card.hidden = false;
  root.querySelector('.preview-closed').hidden = true;
  notice.hidden = true;
  notice.textContent = '';
  panels.forEach((panel) => { panel.reset(); panel.hidden = true; });
  card.querySelectorAll('[data-password-toggle]').forEach((button) => {
    button.previousElementSibling.type = 'password';
    button.textContent = 'Hiện';
    button.setAttribute('aria-label', 'Hiện mật khẩu');
    button.setAttribute('aria-pressed', 'false');
  });
  const view = ['error', 'cancel'].includes(mode) ? 'login' : mode;
  title.textContent = headings[view][0];
  description.textContent = headings[view][1];
  tabs.hidden = !['login', 'register'].includes(view);
  social.hidden = tabs.hidden;
  root.querySelector('.auth-success').hidden = view !== 'success';
  root.querySelector('.auth-legal').hidden = view === 'success';
  error.hidden = mode !== 'error';
  cancel.hidden = mode !== 'cancel';
  error.querySelector('p').textContent = 'Chưa thể kết nối với Google. Bạn có thể thử lại hoặc đăng nhập bằng mật khẩu bên dưới.';
  root.querySelector(`#auth-${view}-panel`)?.removeAttribute('hidden');
  root.querySelectorAll('[role="tab"]').forEach((tab) => { tab.setAttribute('aria-selected', String(tab.dataset.mode === view)); });
  root.querySelector('.email-code').hidden = true;
  root.querySelector('[data-email-action]').textContent = 'Gửi mã xác minh';
  root.querySelector('[name="code"]').required = false;
  if (view !== 'forgot') selector.value = mode;
}
function previewGoogle() {
  resetBusy();
  error.hidden = true;
  cancel.hidden = true;
  googleButton.disabled = true;
  status.hidden = false;
  card.setAttribute('aria-busy', 'true');
  timer = setTimeout(() => render('success'), 1100);
}
selector.addEventListener('change', () => render(selector.value));
root.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => render(button.dataset.mode)));
googleButton.addEventListener('click', previewGoogle);
root.querySelector('[data-retry]').addEventListener('click', previewGoogle);
root.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => {
  resetBusy();
  panels.forEach((panel) => panel.reset());
  card.hidden = true;
  root.querySelector('.preview-closed').hidden = false;
}));
root.querySelectorAll('[data-password-toggle]').forEach((button) => button.addEventListener('click', () => {
  const input = button.previousElementSibling;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  button.textContent = show ? 'Ẩn' : 'Hiện';
  button.setAttribute('aria-label', show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu');
  button.setAttribute('aria-pressed', String(show));
}));
root.querySelector('[data-forgot]').addEventListener('click', () => render('forgot'));
panels.forEach((form) => form.addEventListener('submit', (event) => {
  event.preventDefault();
  // Local-only placeholder transitions; entered values are not stored or sent.
  if (activeMode === 'email' && !emailSent) {
    emailSent = true;
    root.querySelector('.email-code').hidden = false;
    root.querySelector('[name="code"]').required = true;
    root.querySelector('[data-email-action]').textContent = 'Xác minh và tiếp tục';
    notice.textContent = 'Bản duyệt: chưa gửi email thật. Nhập 6 chữ số bất kỳ để xem bước tiếp theo.';
    notice.hidden = false;
  } else if (activeMode === 'forgot' || activeMode === 'register') {
    form.reset();
    notice.textContent = 'Bản duyệt: giao diện yêu cầu mã xác minh. Chưa gửi email hoặc tạo tài khoản thật.';
    notice.hidden = false;
  } else render('success');
}));
// Arrow keys switch the two actual authentication tabs.
tabs.addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 'login' : event.key === 'End' ? 'register' : activeMode === 'register' ? 'login' : 'register';
  render(next);
  root.querySelector(`[role="tab"][data-mode="${next}"]`).focus();
});
render('login');
