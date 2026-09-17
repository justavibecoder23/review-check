import { createHash, randomUUID } from 'node:crypto';
import { isRedisConfigured, redisCommand, redisTransaction } from './redis-rest.mjs';

const PREFIX = 'realview:blog:access:v1';
const INDEX_KEY = `${PREFIX}:grants`;
const AUDIT_KEY = `${PREFIX}:audit`;
const ALLOWED_ROLES = new Set(['admin', 'editor']);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_AUDIT_ITEMS = 500;

function accessError(message, statusCode = 400, code = 'BLOG_ACCESS_ERROR') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

export function normalizeAccessEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function configuredValues(value) {
  return [...new Set(String(value || '')
    .split(',')
    .map(normalizeAccessEmail)
    .filter(Boolean))];
}

function emailDigest(email) {
  return createHash('sha256').update(normalizeAccessEmail(email)).digest('hex');
}

function grantKey(email) {
  return `${PREFIX}:grant:${emailDigest(email)}`;
}

function ensureStorage() {
  if (!isRedisConfigured()) {
    throw accessError('Kho phân quyền chưa được cấu hình trên môi trường này.', 503, 'BLOG_ACCESS_STORAGE_UNAVAILABLE');
  }
}

function parseStored(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function normalizeDate(value, label, { nullable = false } = {}) {
  if ((value === undefined || value === null || value === '') && nullable) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw accessError(`${label} không hợp lệ.`, 400, 'INVALID_ACCESS_DATE');
  }
  return date.toISOString();
}

export function isBootstrapAdmin(email, env = process.env) {
  return configuredValues(env.BLOG_ADMIN_EMAILS).includes(normalizeAccessEmail(email));
}

export function accessCapabilities(role) {
  return {
    managePosts: role === 'admin' || role === 'editor',
    publishPosts: role === 'admin',
    manageAccess: role === 'admin'
  };
}

export function accessEntryStatus(entry, nowMs = Date.now()) {
  if (entry?.source === 'environment') return entry.role === 'admin' ? 'owner' : 'configured';
  if (entry?.revokedAt || entry?.status === 'revoked') return 'revoked';
  const startsAt = Date.parse(entry?.startsAt || '');
  const expiresAt = entry?.expiresAt ? Date.parse(entry.expiresAt) : NaN;
  if (Number.isFinite(startsAt) && startsAt > nowMs) return 'scheduled';
  if (Number.isFinite(expiresAt) && expiresAt <= nowMs) return 'expired';
  return 'active';
}

function publicEntry(entry, nowMs = Date.now()) {
  if (!entry) return null;
  return {
    ...entry,
    status: accessEntryStatus(entry, nowMs),
    capabilities: accessCapabilities(entry.role)
  };
}

export async function getDynamicAccessGrant(email, options = {}) {
  ensureStorage();
  const normalizedEmail = normalizeAccessEmail(email);
  if (!normalizedEmail) return null;
  return publicEntry(parseStored(await redisCommand(['GET', grantKey(normalizedEmail)], options)), options.nowMs ?? Date.now());
}

export async function resolveDynamicAccessRole(email, options = {}) {
  const entry = await getDynamicAccessGrant(email, options);
  return entry?.status === 'active' ? entry.role : null;
}

function actorSummary(actor = {}) {
  return {
    accountId: String(actor.account?.id || actor.id || ''),
    email: normalizeAccessEmail(actor.account?.email || actor.email),
    username: String(actor.account?.username || actor.username || '')
  };
}

function auditEvent(action, entry, actor, previous) {
  return {
    id: randomUUID(),
    action,
    targetEmail: entry.email,
    previousRole: previous?.role || null,
    role: entry.role || null,
    previousStartsAt: previous?.startsAt || null,
    startsAt: entry.startsAt || null,
    previousExpiresAt: previous?.expiresAt || null,
    expiresAt: entry.expiresAt || null,
    actor: actorSummary(actor),
    createdAt: entry.updatedAt
  };
}

export async function upsertAccessGrant(input = {}, actor = {}, options = {}) {
  ensureStorage();
  const email = normalizeAccessEmail(input.email);
  const role = String(input.role || '').trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    throw accessError('Email chưa đúng định dạng.', 400, 'INVALID_ACCESS_EMAIL');
  }
  if (!ALLOWED_ROLES.has(role)) {
    throw accessError('Vai trò chỉ có thể là admin hoặc editor.', 400, 'INVALID_ACCESS_ROLE');
  }
  if (isBootstrapAdmin(email, options.env || process.env)) {
    throw accessError('Admin gốc được quản lý bằng cấu hình Vercel và không thể chỉnh sửa tại đây.', 409, 'BOOTSTRAP_ADMIN_IMMUTABLE');
  }
  const now = new Date(options.nowMs ?? Date.now());
  const startsAt = normalizeDate(input.startsAt || now.toISOString(), 'Thời điểm bắt đầu');
  const expiresAt = normalizeDate(input.expiresAt, 'Thời điểm hết hạn', { nullable: true });
  if (expiresAt && Date.parse(expiresAt) <= Date.parse(startsAt)) {
    throw accessError('Thời điểm hết hạn phải sau thời điểm bắt đầu.', 400, 'INVALID_ACCESS_WINDOW');
  }
  const previous = parseStored(await redisCommand(['GET', grantKey(email)], options));
  if (previous && email === actorSummary(actor).email) {
    throw accessError('Không thể tự thay đổi quyền của tài khoản đang thao tác.', 409, 'CANNOT_EDIT_SELF');
  }
  const timestamp = now.toISOString();
  const entry = {
    id: previous?.id || randomUUID(),
    email,
    role,
    source: 'dynamic',
    status: 'active',
    startsAt,
    expiresAt,
    createdAt: previous?.createdAt || timestamp,
    updatedAt: timestamp,
    grantedBy: previous?.grantedBy || actorSummary(actor),
    updatedBy: actorSummary(actor),
    revokedAt: null,
    revokedBy: null
  };
  const event = auditEvent(previous ? 'update' : 'grant', entry, actor, previous);
  await redisTransaction([
    ['SET', grantKey(email), JSON.stringify(entry)],
    ['ZADD', INDEX_KEY, String(now.getTime()), emailDigest(email)],
    ['LPUSH', AUDIT_KEY, JSON.stringify(event)],
    ['LTRIM', AUDIT_KEY, '0', String(MAX_AUDIT_ITEMS - 1)]
  ], options);
  return publicEntry(entry, now.getTime());
}

export async function revokeAccessGrant(emailValue, actor = {}, options = {}) {
  ensureStorage();
  const email = normalizeAccessEmail(emailValue);
  if (isBootstrapAdmin(email, options.env || process.env)) {
    throw accessError('Không thể thu hồi quyền của admin gốc.', 409, 'BOOTSTRAP_ADMIN_IMMUTABLE');
  }
  if (email && email === actorSummary(actor).email) {
    throw accessError('Không thể tự thu hồi quyền của tài khoản đang thao tác.', 409, 'CANNOT_REVOKE_SELF');
  }
  const previous = parseStored(await redisCommand(['GET', grantKey(email)], options));
  if (!previous) throw accessError('Không tìm thấy quyền cần thu hồi.', 404, 'ACCESS_GRANT_NOT_FOUND');
  const now = new Date(options.nowMs ?? Date.now());
  const entry = {
    ...previous,
    status: 'revoked',
    updatedAt: now.toISOString(),
    updatedBy: actorSummary(actor),
    revokedAt: now.toISOString(),
    revokedBy: actorSummary(actor)
  };
  const event = auditEvent('revoke', entry, actor, previous);
  await redisTransaction([
    ['SET', grantKey(email), JSON.stringify(entry)],
    ['ZADD', INDEX_KEY, String(now.getTime()), emailDigest(email)],
    ['LPUSH', AUDIT_KEY, JSON.stringify(event)],
    ['LTRIM', AUDIT_KEY, '0', String(MAX_AUDIT_ITEMS - 1)]
  ], options);
  return publicEntry(entry, now.getTime());
}

export async function listAccessGrants(options = {}) {
  ensureStorage();
  const nowMs = options.nowMs ?? Date.now();
  const digests = await redisCommand(['ZREVRANGE', INDEX_KEY, '0', '499'], options) || [];
  const values = digests.length
    ? await redisCommand(['MGET', ...digests.map((digest) => `${PREFIX}:grant:${digest}`)], options) || []
    : [];
  const dynamic = values.map(parseStored).filter(Boolean).map((entry) => publicEntry(entry, nowMs));
  const owners = configuredValues((options.env || process.env).BLOG_ADMIN_EMAILS).map((email) => publicEntry({
    id: `owner:${emailDigest(email).slice(0, 16)}`,
    email,
    role: 'admin',
    source: 'environment',
    startsAt: null,
    expiresAt: null,
    createdAt: null,
    updatedAt: null
  }, nowMs));
  const dynamicEmails = new Set(dynamic.map((entry) => entry.email));
  const ownerEmails = new Set(owners.map((entry) => entry.email));
  const configuredEditors = configuredValues((options.env || process.env).BLOG_EDITOR_EMAILS)
    .filter((email) => !ownerEmails.has(email) && !dynamicEmails.has(email))
    .map((email) => publicEntry({
      id: `configured:${emailDigest(email).slice(0, 16)}`,
      email,
      role: 'editor',
      source: 'environment',
      startsAt: null,
      expiresAt: null,
      createdAt: null,
      updatedAt: null
    }, nowMs));
  return [...owners, ...configuredEditors, ...dynamic.filter((entry) => !ownerEmails.has(entry.email))];
}

export async function listAccessAudit(options = {}) {
  ensureStorage();
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 50));
  const values = await redisCommand(['LRANGE', AUDIT_KEY, '0', String(limit - 1)], options) || [];
  return values.map(parseStored).filter(Boolean);
}

export const blogAccessInternals = {
  PREFIX,
  INDEX_KEY,
  AUDIT_KEY,
  emailDigest,
  grantKey,
  configuredValues
};
