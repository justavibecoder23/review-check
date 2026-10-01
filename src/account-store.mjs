import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual
} from 'node:crypto';
import { promisify } from 'node:util';
import { isRedisConfigured, redisCommand, redisTransaction } from './redis-rest.mjs';

const scrypt = promisify(scryptCallback);
const USERNAME_PATTERN = /^[a-zA-Z0-9._]{3,30}$/;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const PASSWORD_RESET_TTL_SECONDS = 10 * 60;
const PASSWORD_RESET_MAX_ATTEMPTS = 5;
const HISTORY_LIMIT = 50;
const MAX_HISTORY_BYTES = 700_000;
const PREFIX = 'realview:account:v1';
// Carry the authenticated snapshot without exposing session metadata in JSON.
const authenticatedVersions = new WeakMap();

function accountError(message, statusCode = 400, code = 'ACCOUNT_ERROR') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function validateRegistration({ username, email, password }) {
  const normalizedUsername = normalizeUsername(username);
  const normalizedEmail = normalizeEmail(email);
  if (!USERNAME_PATTERN.test(String(username || '').trim())) {
    throw accountError('Tên đăng nhập cần từ 3–30 ký tự, chỉ gồm chữ, số, dấu chấm hoặc gạch dưới.', 400, 'INVALID_USERNAME');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254) {
    throw accountError('Email chưa đúng định dạng.', 400, 'INVALID_EMAIL');
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw accountError('Mật khẩu cần từ 8–128 ký tự.', 400, 'INVALID_PASSWORD');
  }
  return { normalizedUsername, normalizedEmail, password };
}

export async function assertRegistrationAvailable(input = {}, options = {}) {
  ensureStorage();
  const value = validateRegistration(input);
  const [usernameOwner, emailOwner] = await Promise.all([
    redisCommand(['GET', usernameKey(value.normalizedUsername)], options),
    redisCommand(['GET', emailKey(value.normalizedEmail)], options)
  ]);
  if (usernameOwner) throw accountError('Tên đăng nhập này đã được sử dụng.', 409, 'USERNAME_EXISTS');
  if (emailOwner) throw accountError('Email này đã được đăng ký.', 409, 'EMAIL_EXISTS');
  return value;
}

function ensureStorage() {
  if (!isRedisConfigured()) {
    throw accountError('Kho tài khoản chưa được cấu hình trên môi trường này.', 503, 'ACCOUNT_STORAGE_UNAVAILABLE');
  }
}

function usernameKey(username) {
  return `${PREFIX}:username:${username}`;
}

function emailKey(email) {
  return `${PREFIX}:email:${email}`;
}

function userKey(userId) {
  return `${PREFIX}:user:${userId}`;
}

function sessionKey(token) {
  const digest = createHash('sha256').update(token).digest('hex');
  return `${PREFIX}:session:${digest}`;
}

function passwordResetKey(requestId) {
  return `${PREFIX}:password-reset:${requestId}`;
}

function offlineConsentNoticeKey(userId) {
  return `${PREFIX}:notice:offline-consent:${userId}`;
}

function historyIndexKey(userId) {
  return `${PREFIX}:history:${userId}:index`;
}

function historyItemKey(userId, itemId) {
  return `${PREFIX}:history:${userId}:item:${itemId}`;
}

function publicUser(user) {
  const result = {
    id: user.id,
    username: user.username,
    email: user.email,
    createdAt: user.createdAt,
    displayName: user.displayName || user.username,
    authProviders: [...(user.passwordHash ? ['password'] : []), ...(user.googleSubject ? ['google'] : [])],
    hasPassword: Boolean(user.passwordHash),
    emailMarketingConsent: user.emailMarketingConsent || {
      status: 'subscribed',
      source: 'offline',
      consentedAt: null
    }
  };
  authenticatedVersions.set(result, Number(user.sessionVersion || 0));
  return result;
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${Buffer.from(derived).toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
  const [algorithm, salt, encoded] = String(storedHash || '').split('$');
  if (algorithm !== 'scrypt' || !salt || !encoded) return false;
  const expected = Buffer.from(encoded, 'hex');
  const actual = Buffer.from(await scrypt(String(password || ''), salt, expected.length));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readUser(userId, options = {}) {
  if (!userId) return null;
  const serialized = await redisCommand(['GET', userKey(userId)], options);
  if (!serialized) return null;
  try {
    const user = JSON.parse(serialized);
    if (!user.emailMarketingConsent) {
      user.emailMarketingConsent = {
        status: 'subscribed',
        source: 'offline',
        consentedAt: null
      };
      // Derive the legacy default without rewriting a stale account snapshot.
    }
    return user;
  } catch {
    return null;
  }
}

export async function registerAccount(input = {}, options = {}) {
  ensureStorage();
  const { normalizedUsername, normalizedEmail, password } = validateRegistration(input);
  const userId = randomUUID();
  const reservedUsername = await redisCommand(['SET', usernameKey(normalizedUsername), userId, 'NX'], options);
  if (!reservedUsername) throw accountError('Tên đăng nhập này đã được sử dụng.', 409, 'USERNAME_EXISTS');

  const reservedEmail = await redisCommand(['SET', emailKey(normalizedEmail), userId, 'NX'], options);
  if (!reservedEmail) {
    await redisCommand(['DEL', usernameKey(normalizedUsername)], options);
    throw accountError('Email này đã được đăng ký.', 409, 'EMAIL_EXISTS');
  }

  const user = {
    id: userId,
    username: String(input.username).trim(),
    usernameNormalized: normalizedUsername,
    email: normalizedEmail,
    passwordHash: await hashPassword(password),
    createdAt: new Date().toISOString(),
    emailMarketingConsent: input.emailMarketingConsent === true
      ? { status: 'subscribed', source: 'registration_form', consentedAt: new Date().toISOString() }
      : { status: 'not_subscribed', source: 'registration_form', consentedAt: null }
  };

  try {
    await redisTransaction([
      ['SET', userKey(userId), JSON.stringify(user)],
      ['SADD', `${PREFIX}:emails`, normalizedEmail]
    ], options);
  } catch (error) {
    await redisTransaction([
      ['DEL', usernameKey(normalizedUsername)],
      ['DEL', emailKey(normalizedEmail)]
    ], options).catch(() => {});
    throw error;
  }
  return publicUser(user);
}

export async function authenticateAccount({ identifier, username, email, password } = {}, options = {}) {
  ensureStorage();
  const login = normalizeUsername(identifier ?? username ?? email);
  if (!login || login.length > 254 || typeof password !== 'string' || password.length > 128) {
    throw accountError('Vui lòng nhập email hoặc tên đăng nhập và mật khẩu.', 400, 'MISSING_CREDENTIALS');
  }
  const userId = await redisCommand(['GET', login.includes('@') ? emailKey(login) : usernameKey(login)], options);
  const user = await readUser(userId, options);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    throw accountError('Email, tên đăng nhập hoặc mật khẩu không đúng.', 401, 'INVALID_CREDENTIALS');
  }
  return publicUser(user);
}

export async function acceptEmailMarketingConsent(userId, options = {}) {
  ensureStorage();
  let user = await readUser(userId, options);
  if (!user) throw accountError('Không tìm thấy tài khoản.', 404, 'ACCOUNT_NOT_FOUND');
  if (user.emailMarketingConsent?.status !== 'subscribed') {
    user.emailMarketingConsent = {
      status: 'subscribed',
      source: 'login_prompt',
      consentedAt: new Date().toISOString()
    };
    const updated = await redisCommand(['EVAL', `-- account:consent
        local raw = redis.call('GET', KEYS[1])
        if not raw then return false end
        local user = cjson.decode(raw)
        if not user.emailMarketingConsent or user.emailMarketingConsent.status ~= 'subscribed' then
          user.emailMarketingConsent = cjson.decode(ARGV[1])
          raw = cjson.encode(user)
          redis.call('SET', KEYS[1], raw)
        end
        return raw
      `, 1, userKey(user.id), JSON.stringify(user.emailMarketingConsent)], options);
    if (!updated) throw accountError('Không tìm thấy tài khoản.', 404, 'ACCOUNT_NOT_FOUND');
    user = JSON.parse(updated);
  }
  return publicUser(user);
}

export async function createAccountSession(user, options = {}) {
  ensureStorage();
  const stored = await readUser(user.id, options);
  if (!stored) throw accountError('Không tìm thấy tài khoản.', 401, 'ACCOUNT_NOT_FOUND');
  const version = authenticatedVersions.get(user) ?? Number(stored.sessionVersion || 0);
  const token = randomBytes(32).toString('base64url');
  const created = await redisCommand(['EVAL', `-- account:create-session
    local raw = redis.call('GET', KEYS[1])
    if not raw then return false end
    local user = cjson.decode(raw)
    if tonumber(user.sessionVersion or 0) ~= tonumber(ARGV[1]) then return false end
    return redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
  `, 2, userKey(user.id), sessionKey(token), version, JSON.stringify({ userId: user.id, version }), SESSION_TTL_SECONDS], options);
  if (!created) throw accountError('Thông tin đăng nhập đã thay đổi. Vui lòng đăng nhập lại.', 401, 'SESSION_CHANGED');
  return { token, expiresIn: SESSION_TTL_SECONDS };
}

export async function getAccountFromSession(token, options = {}) {
  ensureStorage();
  if (!token) return null;
  const raw = await redisCommand(['GET', sessionKey(token)], options);
  if (!raw) return null;
  let session;
  try { session = JSON.parse(raw); } catch { session = { userId: raw, version: 0 }; }
  const user = await readUser(session?.userId, options);
  return user && Number(user.sessionVersion || 0) === Number(session.version) ? publicUser(user) : null;
}

export async function claimOfflineConsentNotice(user, options = {}) {
  ensureStorage();
  if (!user?.id || user.emailMarketingConsent?.source !== 'offline') return false;
  const claimed = await redisCommand([
    'SET',
    offlineConsentNoticeKey(user.id),
    new Date().toISOString(),
    'NX'
  ], options);
  return claimed === 'OK';
}

export async function deleteAccountSession(token, options = {}) {
  if (!token || !isRedisConfigured()) return;
  await redisCommand(['DEL', sessionKey(token)], options);
}

export async function createPasswordReset(email, options = {}) {
  ensureStorage();
  const normalizedEmail = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254) {
    throw accountError('Email chưa đúng định dạng.', 400, 'INVALID_EMAIL');
  }

  const requestId = randomBytes(24).toString('base64url');
  const userId = await redisCommand(['GET', emailKey(normalizedEmail)], options);
  const user = await readUser(userId, options);
  const code = String(randomInt(100000, 1000000));
  const salt = randomBytes(16).toString('hex');
  const expiresAt = Date.now() + PASSWORD_RESET_TTL_SECONDS * 1000;
  const record = {
    userId: user && (user.passwordHash || user.googleSubject) ? user.id : '',
    email: normalizedEmail,
    passwordSnapshot: user?.passwordHash || '',
    salt,
    codeHash: createHash('sha256').update(`${salt}:${code}`).digest('hex'),
    attempts: 0,
    expiresAt
  };
  const emailDigest = createHash('sha256').update(normalizedEmail).digest('hex');
  const activeKey = `${PREFIX}:password-reset-active:${emailDigest}`;
  const created = await redisCommand(['EVAL', `-- account:create-reset
    if redis.call('EXISTS', KEYS[2]) == 1 then return 'COOLDOWN' end
    local count = redis.call('INCR', KEYS[1])
    if count == 1 then redis.call('EXPIRE', KEYS[1], 3600) end
    if count > 5 then return 'LIMIT' end
    local previous = redis.call('GET', KEYS[3])
    if previous then redis.call('DEL', previous) end
    redis.call('SET', KEYS[2], '1', 'EX', 60)
    redis.call('SET', KEYS[3], KEYS[4], 'EX', ARGV[2])
    redis.call('SET', KEYS[4], ARGV[1], 'EX', ARGV[2])
    return 'OK'
  `, 4, `${PREFIX}:password-reset-rate:${emailDigest}`, `${PREFIX}:password-reset-cooldown:${emailDigest}`,
  activeKey, passwordResetKey(requestId), JSON.stringify(record), PASSWORD_RESET_TTL_SECONDS], options);
  if (created !== 'OK') throw accountError('Vui lòng đợi ít nhất 60 giây trước khi gửi lại mã. Mỗi email được gửi tối đa 5 lần mỗi giờ.', 429, 'RATE_LIMITED');
  return {
    requestId,
    expiresIn: PASSWORD_RESET_TTL_SECONDS,
    user: record.userId ? publicUser(user) : null,
    code: record.userId ? code : null
  };
}

export async function resetAccountPassword(input = {}, options = {}) {
  ensureStorage();
  const requestId = String(input.requestId || '').trim();
  const code = String(input.code || '').trim();
  const password = input.password;
  if (!/^[a-zA-Z0-9_-]{32}$/.test(requestId) || !/^\d{6}$/.test(code)) {
    throw accountError('Mã xác minh không hợp lệ hoặc đã hết hạn.', 400, 'INVALID_RESET_CODE');
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw accountError('Mật khẩu mới cần từ 8–128 ký tự.', 400, 'INVALID_PASSWORD');
  }

  const key = passwordResetKey(requestId);
  const serialized = await redisCommand(['GET', key], options);
  let record;
  try {
    record = serialized ? JSON.parse(serialized) : null;
  } catch {
    record = null;
  }
  if (!record || !record.userId || Date.now() >= Number(record.expiresAt || 0)) {
    if (serialized) await redisCommand(['DEL', key], options);
    throw accountError('Mã xác minh không hợp lệ hoặc đã hết hạn.', 400, 'INVALID_RESET_CODE');
  }

  const actual = createHash('sha256').update(`${record.salt}:${code}`).digest('hex');
  const valid = actual === record.codeHash;
  // Wrong guesses take the same atomic attempt-budget path, without expensive scrypt.
  const passwordHash = valid ? await hashPassword(password) : '';
  const emailDigest = createHash('sha256').update(String(record.email || '')).digest('hex');
  const updated = await redisCommand(['EVAL', `-- account:reset-password
      local proofRaw = redis.call('GET', KEYS[2])
      if not proofRaw or redis.call('GET', KEYS[3]) ~= KEYS[2] then return 'EXPIRED' end
      local proof = cjson.decode(proofRaw)
      if proof.salt ~= ARGV[4] or tonumber(proof.expiresAt) <= tonumber(ARGV[5]) then return 'EXPIRED' end
      if tonumber(proof.attempts or 0) >= tonumber(ARGV[6]) then return 'EXPIRED' end
      if proof.codeHash ~= ARGV[3] then
        proof.attempts = tonumber(proof.attempts or 0) + 1
        if proof.attempts >= tonumber(ARGV[6]) then redis.call('DEL', KEYS[2])
        else redis.call('SET', KEYS[2], cjson.encode(proof), 'KEEPTTL') end
        return 'WRONG'
      end
      local raw = redis.call('GET', KEYS[1])
      if not raw then return 'EXPIRED' end
      local user = cjson.decode(raw)
      local oldPassword = user.passwordHash
      if not oldPassword or oldPassword == cjson.null then oldPassword = '' end
      if user.id ~= proof.userId or user.email ~= proof.email or oldPassword ~= proof.passwordSnapshot
        or (oldPassword == '' and (not user.googleSubject or user.googleSubject == cjson.null)) then
        redis.call('DEL', KEYS[2])
        return 'EXPIRED'
      end
      user.passwordHash = ARGV[1]
      user.passwordUpdatedAt = ARGV[2]
      user.sessionVersion = tonumber(user.sessionVersion or 0) + 1
      local updated = cjson.encode(user)
      redis.call('SET', KEYS[1], updated)
      redis.call('DEL', KEYS[2], KEYS[3])
      return updated
  `, 3, userKey(record.userId), key, `${PREFIX}:password-reset-active:${emailDigest}`,
  passwordHash, new Date().toISOString(), actual, record.salt, Date.now(), PASSWORD_RESET_MAX_ATTEMPTS], options);
  if (updated === 'WRONG') throw accountError('Mã xác minh không đúng. Vui lòng kiểm tra lại.', 400, 'INVALID_RESET_CODE');
  if (!updated || updated === 'EXPIRED') throw accountError('Mã xác minh không hợp lệ hoặc đã hết hạn.', 400, 'INVALID_RESET_CODE');
  return publicUser(JSON.parse(updated));
}

function normalizeHistoryItem(item) {
  if (!item || typeof item !== 'object' || !item.id || !item.fullReport?.product) {
    throw accountError('Báo cáo lịch sử không hợp lệ.', 400, 'INVALID_HISTORY_ITEM');
  }
  const analyzedAt = new Date(item.analyzedAt);
  if (!Number.isFinite(analyzedAt.getTime())) {
    throw accountError('Thời gian phân tích không hợp lệ.', 400, 'INVALID_HISTORY_ITEM');
  }
  const normalized = {
    ...item,
    id: String(item.id).slice(0, 160),
    analyzedAt: analyzedAt.toISOString()
  };
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_HISTORY_BYTES) {
    throw accountError('Báo cáo quá lớn để lưu vào lịch sử.', 413, 'HISTORY_ITEM_TOO_LARGE');
  }
  return { normalized, serialized };
}

export async function saveAccountHistory(userId, item, options = {}) {
  ensureStorage();
  const { normalized, serialized } = normalizeHistoryItem(item);
  const indexKey = historyIndexKey(userId);
  const score = new Date(normalized.analyzedAt).getTime();
  await redisTransaction([
    ['SET', historyItemKey(userId, normalized.id), serialized],
    ['ZADD', indexKey, score, normalized.id]
  ], options);
  const ids = await redisCommand(['ZRANGE', indexKey, '0', '-1'], options) || [];
  const expired = ids.slice(0, Math.max(0, ids.length - HISTORY_LIMIT));
  if (expired.length) {
    await redisTransaction([
      ['ZREM', indexKey, ...expired],
      ['DEL', ...expired.map((id) => historyItemKey(userId, id))]
    ], options);
  }
  return normalized;
}

export async function listAccountHistory(userId, options = {}) {
  ensureStorage();
  const offset = Math.max(0, Math.min(HISTORY_LIMIT - 1, Number(options.offset) || 0));
  const limit = Math.max(1, Math.min(10, Number(options.limit) || 10));
  const ids = await redisCommand(['ZREVRANGE', historyIndexKey(userId), String(offset), String(Math.min(HISTORY_LIMIT - 1, offset + limit - 1))], options) || [];
  if (!ids.length) return [];
  const values = await redisCommand(['MGET', ...ids.map((id) => historyItemKey(userId, id))], options) || [];
  return values.flatMap((value) => {
    try {
      return value ? [JSON.parse(value)] : [];
    } catch {
      return [];
    }
  });
}

export async function countAccountHistory(userId, options = {}) {
  ensureStorage();
  return Math.min(HISTORY_LIMIT, Number(await redisCommand(['ZCARD', historyIndexKey(userId)], options)) || 0);
}

export async function getAccountHistoryItem(userId, itemId, options = {}) {
  ensureStorage();
  const id = String(itemId || '').slice(0, 160);
  if (!userId || !id) return null;
  const serialized = await redisCommand(['GET', historyItemKey(userId, id)], options);
  if (!serialized) return null;
  try {
    return JSON.parse(serialized);
  } catch {
    return null;
  }
}

export async function deleteAccountHistory(userId, itemId, options = {}) {
  ensureStorage();
  const id = String(itemId || '').slice(0, 160);
  if (!id) return;
  await redisTransaction([
    ['ZREM', historyIndexKey(userId), id],
    ['DEL', historyItemKey(userId, id)]
  ], options);
}

export async function clearAccountHistory(userId, options = {}) {
  ensureStorage();
  const indexKey = historyIndexKey(userId);
  const ids = await redisCommand(['ZRANGE', indexKey, '0', '-1'], options) || [];
  const commands = [['DEL', indexKey]];
  if (ids.length) commands.push(['DEL', ...ids.map((id) => historyItemKey(userId, id))]);
  await redisTransaction(commands, options);
}

export const accountStoreInternals = {
  publicUser,
  readUser,
  verifyPassword,
  SESSION_TTL_SECONDS,
  PASSWORD_RESET_TTL_SECONDS,
  PASSWORD_RESET_MAX_ATTEMPTS,
  normalizeEmail,
  normalizeUsername,
  usernameKey,
  emailKey,
  userKey,
  sessionKey,
  passwordResetKey,
  offlineConsentNoticeKey
};

