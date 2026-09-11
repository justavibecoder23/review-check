import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { isRedisConfigured, redisCommand } from './redis-rest.mjs';

const PREFIX = 'realview:email-verification:v1';
const TTL_SECONDS = 10 * 60;
const MAX_ATTEMPTS = 5;
const PURPOSES = new Set(['registration', 'contact']);

function verificationError(message, statusCode = 400, code = 'EMAIL_VERIFICATION_ERROR') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function verificationKey(requestId) {
  return `${PREFIX}:${requestId}`;
}

function verificationUseKey(requestId) {
  return `${PREFIX}:used:${requestId}`;
}

function contextDigest(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function assertPurpose(value) {
  const purpose = String(value || '').trim();
  if (!PURPOSES.has(purpose)) throw verificationError('Mục đích xác minh không hợp lệ.', 400, 'INVALID_VERIFICATION_PURPOSE');
  return purpose;
}

function ensureStorage() {
  if (!isRedisConfigured()) throw verificationError('Kho xác minh email chưa được cấu hình.', 503, 'VERIFICATION_STORAGE_UNAVAILABLE');
}

export async function createEmailVerification({ purpose, email, context } = {}, options = {}) {
  ensureStorage();
  const normalizedPurpose = assertPurpose(purpose);
  const normalizedEmail = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254) {
    throw verificationError('Email chưa đúng định dạng.', 400, 'INVALID_EMAIL');
  }

  const requestId = randomBytes(24).toString('base64url');
  const code = String(randomInt(100000, 1000000));
  const salt = randomBytes(16).toString('hex');
  const record = {
    purpose: normalizedPurpose,
    email: normalizedEmail,
    contextHash: contextDigest(context),
    codeHash: createHash('sha256').update(`${salt}:${code}`).digest('hex'),
    salt,
    attempts: 0,
    expiresAt: Date.now() + TTL_SECONDS * 1000
  };
  await redisCommand(['SET', verificationKey(requestId), JSON.stringify(record), 'EX', TTL_SECONDS], options);
  return { requestId, code, email: normalizedEmail, expiresIn: TTL_SECONDS };
}

export async function verifyEmailCode({ requestId, code, purpose, email, context } = {}, options = {}) {
  ensureStorage();
  const normalizedRequestId = String(requestId || '').trim();
  const normalizedCode = String(code || '').trim();
  const normalizedPurpose = assertPurpose(purpose);
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedRequestId || !/^\d{6}$/.test(normalizedCode)) {
    throw verificationError('Mã xác minh không hợp lệ hoặc đã hết hạn.', 400, 'INVALID_EMAIL_CODE');
  }

  const key = verificationKey(normalizedRequestId);
  const serialized = await redisCommand(['GET', key], options);
  let record;
  try {
    record = serialized ? JSON.parse(serialized) : null;
  } catch {
    record = null;
  }
  const matchesRequest = record
    && record.purpose === normalizedPurpose
    && record.email === normalizedEmail
    && record.contextHash === contextDigest(context)
    && Date.now() < Number(record.expiresAt || 0);
  if (!matchesRequest) {
    if (serialized && Date.now() >= Number(record?.expiresAt || 0)) await redisCommand(['DEL', key], options);
    throw verificationError('Mã xác minh không hợp lệ, đã hết hạn hoặc thông tin đã thay đổi.', 400, 'INVALID_EMAIL_CODE');
  }

  const expected = Buffer.from(String(record.codeHash || ''), 'hex');
  const actual = Buffer.from(createHash('sha256').update(`${record.salt}:${normalizedCode}`).digest('hex'), 'hex');
  const valid = expected.length === actual.length && timingSafeEqual(actual, expected);
  if (!valid) {
    record.attempts = Number(record.attempts || 0) + 1;
    if (record.attempts >= MAX_ATTEMPTS) {
      await redisCommand(['DEL', key], options);
    } else {
      const remaining = Math.max(1, Math.ceil((record.expiresAt - Date.now()) / 1000));
      await redisCommand(['SET', key, JSON.stringify(record), 'EX', remaining], options);
    }
    throw verificationError('Mã xác minh không đúng. Vui lòng kiểm tra lại.', 400, 'INVALID_EMAIL_CODE');
  }

  const remaining = Math.max(1, Math.ceil((record.expiresAt - Date.now()) / 1000));
  const consumed = await redisCommand(['SET', verificationUseKey(normalizedRequestId), '1', 'NX', 'EX', remaining], options);
  if (!consumed) {
    await redisCommand(['DEL', key], options);
    throw verificationError('Mã xác minh đã được sử dụng.', 400, 'EMAIL_CODE_USED');
  }
  await redisCommand(['DEL', key], options);
  return { verified: true, email: normalizedEmail };
}

export async function deleteEmailVerification(requestId, options = {}) {
  if (!requestId || !isRedisConfigured()) return;
  await redisCommand(['DEL', verificationKey(String(requestId).trim())], options);
}

export const emailVerificationInternals = {
  TTL_SECONDS,
  MAX_ATTEMPTS,
  verificationKey,
  verificationUseKey,
  contextDigest
};
