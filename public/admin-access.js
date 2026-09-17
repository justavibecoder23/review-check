import { getCurrentUser, openAuthDialog } from '/auth.js';

const API_URL = '/api/admin-access';
const state = { user: null, entries: [], audit: [], editingEmail: null };
const $ = (selector, scope = document) => scope.querySelector(selector);

class ApiError extends Error {
  constructor(message, status, payload = {}) { super(message); this.status = status; this.payload = payload; }
}

async function request(body, method = 'POST') {
  const response = await fetch(API_URL, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(payload.error || 'Không thể xử lý quyền truy cập.', response.status, payload);
  return payload;
}

function setAccess(title, message, { login = false } = {}) {
  const access = $('[data-access-state]');
  $('h1', access).textContent = title;
  $('[data-access-message]', access).textContent = message;
  $('[data-access-login]', access).hidden = !login;
  access.hidden = false;
  $('[data-access-content]').hidden = true;
}

function showContent() {
  $('[data-access-state]').hidden = true;
  $('[data-access-content]').hidden = false;
}

function formatDate(value, empty = 'Không thời hạn') {
  if (!value) return empty;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return empty;
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(date);
}

function toLocalInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function statusLabel(status) {
  return ({ owner: 'Chủ sở hữu', configured: 'Cấu hình Vercel', active: 'Đang hoạt động', scheduled: 'Đã lên lịch', expired: 'Hết hạn', revoked: 'Đã thu hồi' })[status] || status;
}

function toast(message, type = 'success') {
  const item = document.createElement('div');
  item.className = `admin-toast${type === 'error' ? ' is-error' : ''}`;
  const icon = document.createElement('span'); icon.textContent = type === 'error' ? '!' : '✓';
  const text = document.createElement('div'); text.textContent = message;
  item.append(icon, text); $('[data-toast-region]').append(item);
  window.setTimeout(() => item.remove(), 4200);
}

function renderStats() {
  const activeEntries = state.entries.filter((entry) => ['owner', 'configured', 'active', 'scheduled'].includes(entry.status));
  const soon = Date.now() + 7 * 24 * 60 * 60 * 1000;
  $('[data-stat="total"]').textContent = String(activeEntries.length);
  $('[data-stat="admin"]').textContent = String(activeEntries.filter((entry) => entry.role === 'admin').length);
  $('[data-stat="editor"]').textContent = String(activeEntries.filter((entry) => entry.role === 'editor').length);
  $('[data-stat="expiring"]').textContent = String(activeEntries.filter((entry) => entry.expiresAt && Date.parse(entry.expiresAt) <= soon).length);
}

function renderEntries() {
  const tbody = $('[data-access-list]');
  tbody.replaceChildren();
  state.entries.forEach((entry) => {
    const row = document.createElement('tr');
    const account = document.createElement('td');
    const accountBox = document.createElement('div'); accountBox.className = 'access-email';
    const email = document.createElement('strong'); email.textContent = entry.email;
    const source = document.createElement('small'); source.textContent = entry.source === 'environment' ? 'Admin gốc · Vercel' : `Cập nhật ${formatDate(entry.updatedAt, 'Chưa rõ')}`;
    accountBox.append(email, source); account.append(accountBox);

    const roleCell = document.createElement('td');
    const role = document.createElement('span'); role.className = `access-role access-role--${entry.role}`; role.textContent = entry.role;
    roleCell.append(role);

    const validityCell = document.createElement('td');
    const validity = document.createElement('div'); validity.className = 'access-validity';
    const starts = document.createElement('span'); starts.textContent = entry.startsAt ? `Từ ${formatDate(entry.startsAt)}` : 'Có hiệu lực cố định';
    const expires = document.createElement('span'); expires.textContent = entry.expiresAt ? `Đến ${formatDate(entry.expiresAt)}` : 'Không thời hạn';
    validity.append(starts, expires); validityCell.append(validity);

    const statusCell = document.createElement('td');
    const status = document.createElement('span'); status.className = `access-status access-status--${entry.status}`; status.textContent = statusLabel(entry.status);
    statusCell.append(status);

    const actionCell = document.createElement('td');
    const actions = document.createElement('div'); actions.className = 'access-actions';
    if (entry.source === 'environment') {
      const locked = document.createElement('span'); locked.textContent = 'Được bảo vệ'; actions.append(locked);
    } else {
      const edit = document.createElement('button'); edit.type = 'button'; edit.dataset.edit = entry.email; edit.textContent = 'Chỉnh sửa';
      const revoke = document.createElement('button'); revoke.type = 'button'; revoke.dataset.revoke = entry.email; revoke.textContent = 'Thu hồi'; revoke.hidden = entry.status === 'revoked';
      actions.append(edit, revoke);
    }
    actionCell.append(actions);
    row.append(account, roleCell, validityCell, statusCell, actionCell);
    tbody.append(row);
  });
  $('[data-empty]').hidden = state.entries.length > 0;
  renderStats();
}

function renderAudit() {
  const target = $('[data-audit-list]'); target.replaceChildren();
  if (!state.audit.length) { const empty = document.createElement('p'); empty.textContent = 'Chưa có thay đổi phân quyền.'; target.append(empty); return; }
  const labels = { grant: 'Đã cấp quyền', update: 'Đã cập nhật', revoke: 'Đã thu hồi' };
  state.audit.slice(0, 30).forEach((event) => {
    const item = document.createElement('article'); item.className = 'access-audit-item';
    const title = document.createElement('strong'); title.textContent = `${labels[event.action] || event.action}: ${event.targetEmail}`;
    const detail = document.createElement('span'); detail.textContent = event.role ? `Vai trò ${event.role}${event.expiresAt ? ` · hết hạn ${formatDate(event.expiresAt)}` : ''}` : 'Quyền đã bị vô hiệu';
    const actor = document.createElement('small'); actor.textContent = `${event.actor?.email || 'Admin RealView'} · ${formatDate(event.createdAt, 'Chưa rõ')}`;
    item.append(title, detail, actor); target.append(item);
  });
}

async function loadAccess() {
  $('[data-loading]').hidden = false;
  try {
    const payload = await request(null, 'GET');
    state.entries = payload.entries || [];
    state.audit = payload.audit || [];
    renderEntries(); renderAudit(); showContent();
  } finally { $('[data-loading]').hidden = true; }
}

function openGrant(entry = null) {
  const form = $('[data-grant-form]'); form.reset();
  state.editingEmail = entry?.email || null;
  $('[data-form-error]').hidden = true;
  form.elements.email.disabled = Boolean(entry);
  form.elements.email.value = entry?.email || '';
  form.elements.role.value = entry?.role || 'editor';
  form.elements.startsAt.value = toLocalInput(entry?.startsAt || new Date());
  form.elements.duration.value = entry?.expiresAt ? 'custom' : 'never';
  form.elements.expiresAt.value = toLocalInput(entry?.expiresAt);
  $('[data-custom-expiry]').hidden = form.elements.duration.value !== 'custom';
  $('#grant-title').textContent = entry ? 'Chỉnh sửa quyền truy cập' : 'Thêm quyền truy cập';
  $('[data-submit-grant]').textContent = entry ? 'Lưu thay đổi' : 'Cấp quyền';
  $('[data-grant-dialog]').showModal();
}

function closeGrant() { $('[data-grant-dialog]').close(); state.editingEmail = null; }

function expiryFromForm(form) {
  const duration = form.elements.duration.value;
  if (duration === 'never') return null;
  if (duration === 'custom') return form.elements.expiresAt.value ? new Date(form.elements.expiresAt.value).toISOString() : '';
  const startsAt = new Date(form.elements.startsAt.value || Date.now());
  return new Date(startsAt.getTime() + Number(duration) * 24 * 60 * 60 * 1000).toISOString();
}

async function submitGrant(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = $('[data-form-error]'); const submit = $('[data-submit-grant]');
  error.hidden = true; submit.disabled = true;
  try {
    const isEditing = Boolean(state.editingEmail);
    const body = {
      action: isEditing ? 'update' : 'grant',
      email: state.editingEmail || form.elements.email.value,
      role: form.elements.role.value,
      startsAt: form.elements.startsAt.value ? new Date(form.elements.startsAt.value).toISOString() : new Date().toISOString(),
      expiresAt: expiryFromForm(form)
    };
    if (form.elements.duration.value === 'custom' && !body.expiresAt) throw new Error('Vui lòng chọn thời điểm hết hạn.');
    await request(body);
    closeGrant(); toast(isEditing ? 'Đã cập nhật quyền truy cập.' : 'Đã cấp quyền truy cập.');
    await loadAccess();
  } catch (caught) { error.textContent = caught.message; error.hidden = false; }
  finally { submit.disabled = false; }
}

async function confirmRevoke(entry) {
  const dialog = $('[data-revoke-dialog]');
  $('[data-revoke-message]').textContent = `${entry.email} sẽ mất quyền ${entry.role} ngay ở request quản trị tiếp theo.`;
  dialog.returnValue = '';
  dialog.showModal();
  const confirmed = await new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
  if (!confirmed) return;
  try { await request({ action: 'revoke', email: entry.email }, 'DELETE'); toast('Đã thu hồi quyền truy cập.'); await loadAccess(); }
  catch (error) { toast(error.message, 'error'); }
}

async function initializeAccess() {
  setAccess('Đang kiểm tra quyền truy cập', 'Vui lòng chờ trong giây lát.');
  state.user = await getCurrentUser({ refresh: true });
  if (!state.user) { setAccess('Bạn chưa đăng nhập', 'Chỉ tài khoản admin mới có thể quản lý quyền truy cập.', { login: true }); return; }
  try { await loadAccess(); }
  catch (error) {
    if (error.status === 401) setAccess('Phiên đăng nhập đã hết hạn', 'Hãy đăng nhập lại để tiếp tục.', { login: true });
    else if (error.status === 403) setAccess('Chỉ dành cho admin', 'Editor và user không có quyền xem hoặc thay đổi danh sách truy cập.');
    else setAccess('Không thể tải quyền truy cập', error.message);
  }
}

function initialize() {
  $('[data-access-login]').addEventListener('click', () => openAuthDialog({ mode: 'login', message: 'Đăng nhập bằng tài khoản admin RealView.' }));
  $('[data-open-grant]').addEventListener('click', () => openGrant());
  document.querySelectorAll('[data-close-grant]').forEach((button) => button.addEventListener('click', closeGrant));
  $('[data-grant-form]').addEventListener('submit', submitGrant);
  $('[name="duration"]').addEventListener('change', (event) => { $('[data-custom-expiry]').hidden = event.target.value !== 'custom'; });
  $('[data-refresh]').addEventListener('click', () => loadAccess().catch((error) => toast(error.message, 'error')));
  $('[data-access-list]').addEventListener('click', (event) => {
    const editEmail = event.target.closest('[data-edit]')?.dataset.edit;
    const revokeEmail = event.target.closest('[data-revoke]')?.dataset.revoke;
    if (editEmail) openGrant(state.entries.find((entry) => entry.email === editEmail));
    if (revokeEmail) confirmRevoke(state.entries.find((entry) => entry.email === revokeEmail));
  });
  window.addEventListener('realview:auth-changed', initializeAccess);
  initializeAccess();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
