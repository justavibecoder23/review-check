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
const HISTORY_LIMIT = 10;
const MAX_HISTORY_BYTES = 700_000;
const PREFIX = 'realview:account:v1';

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

function validateRegistration({ username, email, password }) {
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

function historyIndexKey(userId) {
  return `${PREFIX}:history:${userId}:index`;
}

function historyItemKey(userId, itemId) {
  return `${PREFIX}:history:${userId}:item:${itemId}`;
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    createdAt: user.createdAt
  };
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
    return JSON.parse(serialized);
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
    createdAt: new Date().toISOString()
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

export async function authenticateAccount({ username, password } = {}, options = {}) {
  ensureStorage();
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername || typeof password !== 'string') {
    throw accountError('Vui lòng nhập tên đăng nhập và mật khẩu.', 400, 'MISSING_CREDENTIALS');
  }
  const userId = await redisCommand(['GET', usernameKey(normalizedUsername)], options);
  const user = await readUser(userId, options);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    throw accountError('Tên đăng nhập hoặc mật khẩu không đúng.', 401, 'INVALID_CREDENTIALS');
  }
  return publicUser(user);
}

export async function createAccountSession(user, options = {}) {
  ensureStorage();
  const token = randomBytes(32).toString('base64url');
  await redisCommand(['SET', sessionKey(token), user.id, 'EX', SESSION_TTL_SECONDS], options);
  return { token, expiresIn: SESSION_TTL_SECONDS };
}

export async function getAccountFromSession(token, options = {}) {
  ensureStorage();
  if (!token) return null;
  const userId = await redisCommand(['GET', sessionKey(token)], options);
  const user = await readUser(userId, options);
  return user ? publicUser(user) : null;
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
    userId: user?.id || '',
    salt,
    codeHash: createHash('sha256').update(`${salt}:${code}`).digest('hex'),
    attempts: 0,
    expiresAt
  };
  await redisCommand([
    'SET',
    passwordResetKey(requestId),
    JSON.stringify(record),
    'EX',
    PASSWORD_RESET_TTL_SECONDS
  ], options);
  return {
    requestId,
    expiresIn: PASSWORD_RESET_TTL_SECONDS,
    user: user ? publicUser(user) : null,
    code: user ? code : null
  };
}

export async function resetAccountPassword(input = {}, options = {}) {
  ensureStorage();
  const requestId = String(input.requestId || '').trim();
  const code = String(input.code || '').trim();
  const password = input.password;
  if (!requestId || !/^\d{6}$/.test(code)) {
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

  const expected = Buffer.from(String(record.codeHash || ''), 'hex');
  const actual = Buffer.from(createHash('sha256').update(`${record.salt}:${code}`).digest('hex'), 'hex');
  const valid = expected.length === actual.length && timingSafeEqual(actual, expected);
  if (!valid) {
    record.attempts = Number(record.attempts || 0) + 1;
    if (record.attempts >= PASSWORD_RESET_MAX_ATTEMPTS) {
      await redisCommand(['DEL', key], options);
    } else {
      const remainingSeconds = Math.max(1, Math.ceil((record.expiresAt - Date.now()) / 1000));
      await redisCommand(['SET', key, JSON.stringify(record), 'EX', remainingSeconds], options);
    }
    throw accountError('Mã xác minh không đúng. Vui lòng kiểm tra lại.', 400, 'INVALID_RESET_CODE');
  }

  const user = await readUser(record.userId, options);
  if (!user) {
    await redisCommand(['DEL', key], options);
    throw accountError('Mã xác minh không hợp lệ hoặc đã hết hạn.', 400, 'INVALID_RESET_CODE');
  }
  user.passwordHash = await hashPassword(password);
  user.passwordUpdatedAt = new Date().toISOString();
  await redisTransaction([
    ['SET', userKey(user.id), JSON.stringify(user)],
    ['DEL', key]
  ], options);
  return publicUser(user);
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
  const ids = await redisCommand(['ZREVRANGE', historyIndexKey(userId), '0', String(HISTORY_LIMIT - 1)], options) || [];
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
  SESSION_TTL_SECONDS,
  PASSWORD_RESET_TTL_SECONDS,
  PASSWORD_RESET_MAX_ATTEMPTS,
  normalizeEmail,
  normalizeUsername,
  usernameKey,
  emailKey,
  userKey,
  sessionKey,
  passwordResetKey
};

