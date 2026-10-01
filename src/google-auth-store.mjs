import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { isRedisConfigured, redisCommand } from './redis-rest.mjs';
import { accountStoreInternals as accounts } from './account-store.mjs';
import { googleAuthError } from './google-identity.mjs';

const PREFIX = 'realview:google-auth:v1';
const ACCOUNT_PREFIX = 'realview:account:v1';
const TTL = 600;
const digest = (value) => createHash('sha256').update(String(value)).digest('hex');
const opaqueId = () => randomBytes(32).toString('base64url');
const key = (kind, id) => `${PREFIX}:${kind}:${digest(id)}`;
const subjectKey = (subject) => `${ACCOUNT_PREFIX}:google:${digest(subject)}`;

function storage() {
  if (!isRedisConfigured()) throw googleAuthError('Kho tài khoản chưa được cấu hình.', 503, 'ACCOUNT_STORAGE_UNAVAILABLE');
}

function validId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(value)) {
    throw googleAuthError('Yêu cầu đăng nhập không hợp lệ hoặc đã hết hạn.', 401, 'INVALID_GOOGLE_REQUEST');
  }
  return value;
}

async function boundRecord(kind, id, browser, options) {
  storage();
  validId(id);
  validId(browser);
  const raw = await redisCommand(['GET', key(kind, id)], options);
  let record;
  try { record = JSON.parse(raw); } catch { /* Fail closed. */ }
  if (!record || record.browserHash !== digest(browser) || record.expiresAt <= Date.now()) {
    throw googleAuthError('Yêu cầu đăng nhập không hợp lệ hoặc đã hết hạn.', 401, 'INVALID_GOOGLE_REQUEST');
  }
  return { record, raw };
}

export async function beginGoogleLogin(browser, clientId, options = {}) {
  storage();
  const browserToken = /^[a-zA-Z0-9_-]{43}$/.test(String(browser || '')) ? browser : opaqueId();
  const challengeId = opaqueId();
  const nonce = opaqueId();
  const record = { browserHash: digest(browserToken), clientId, nonce, expiresAt: Date.now() + TTL * 1000 };
  await redisCommand(['SET', key('challenge', challengeId), JSON.stringify(record), 'EX', TTL], options);
  return { browserToken, challengeId, nonce, expiresIn: TTL };
}

export async function readGoogleChallenge(id, browser, options = {}) {
  return boundRecord('challenge', id, browser, options);
}

export async function consumeGoogleChallenge(id, raw, options = {}) {
  const consumed = await redisCommand(['EVAL', `-- google:consume
    if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
    redis.call('DEL', KEYS[1])
    return 1
  `, 1, key('challenge', id), raw], options);
  if (Number(consumed) !== 1) throw googleAuthError('Yêu cầu đăng nhập đã được sử dụng.', 401, 'GOOGLE_REQUEST_USED');
}

export async function resolveGoogleIdentity(identity, options = {}) {
  storage();
  const linkedId = await redisCommand(['GET', subjectKey(identity.subject)], options);
  if (linkedId) {
    const user = await accounts.readUser(linkedId, options);
    if (!user || user.googleSubject !== identity.subject) {
      throw googleAuthError('Liên kết tài khoản không hợp lệ.', 409, 'GOOGLE_ACCOUNT_CONFLICT');
    }
    // A changed Google email must not change RealView email/admin permissions implicitly.
    return { kind: 'signed_in', user: accounts.publicUser(user), created: false };
  }
  const owner = await redisCommand(['GET', accounts.emailKey(identity.email)], options);
  if (owner) {
    const user = await accounts.readUser(owner, options);
    if (!user) throw googleAuthError('Tài khoản đang được cập nhật. Vui lòng thử lại.', 409, 'ACCOUNT_BUSY');
    if (user.googleSubject || !user.passwordHash) {
      throw googleAuthError('Email này đã thuộc một tài khoản Google khác.', 409, 'GOOGLE_ACCOUNT_CONFLICT');
    }
    return { kind: 'link_required', targetUserId: user.id };
  }
  return { kind: identity.authoritativeEmail ? 'create' : 'email_required', targetUserId: '' };
}

export async function createGooglePending(identity, targetUserId, browser, options = {}) {
  const pendingId = opaqueId();
  const record = { identity, targetUserId, browserHash: digest(browser), expiresAt: Date.now() + TTL * 1000 };
  await redisCommand(['SET', key('pending', pendingId), JSON.stringify(record), 'EX', TTL], options);
  return { pendingId, expiresIn: TTL };
}

export async function readGooglePending(id, browser, options = {}) {
  return boundRecord('pending', id, browser, options);
}

export async function verifyGoogleLinkPassword(id, pending, password, options = {}) {
  if (!pending.record.targetUserId) throw googleAuthError('Không có tài khoản cần liên kết.', 400, 'INVALID_GOOGLE_ACTION');
  const count = await redisCommand(['EVAL', `-- google:attempt
    local count = redis.call('INCR', KEYS[1])
    if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
    return count
  `, 1, key('attempts', id), TTL], options);
  if (Number(count) > 5) throw googleAuthError('Bạn đã thử quá nhiều lần. Hãy đăng nhập Google lại.', 429, 'RATE_LIMITED');
  if (typeof password !== 'string' || password.length > 128) {
    throw googleAuthError('Mật khẩu không đúng.', 401, 'INVALID_CREDENTIALS');
  }
  const user = await accounts.readUser(pending.record.targetUserId, options);
  if (!user || user.email !== pending.record.identity.email || !await accounts.verifyPassword(password, user.passwordHash)) {
    throw googleAuthError('Mật khẩu không đúng.', 401, 'INVALID_CREDENTIALS');
  }
  return user.passwordHash;
}

export async function createGoogleEmailCode(id, browser, options = {}) {
  const pending = await readGooglePending(id, browser, options);
  if (pending.record.targetUserId) throw googleAuthError('Vui lòng xác nhận mật khẩu tài khoản hiện có.', 400, 'INVALID_GOOGLE_ACTION');
  const code = String(randomInt(100000, 1000000));
  const salt = opaqueId();
  const record = { ...pending.record, otp: { salt, hash: digest(`${salt}:${code}`), attempts: 0, verified: false } };
  const saved = await redisCommand(['EVAL', `-- google:email-code
    if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
    redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')
    return 1
  `, 1, key('pending', id), pending.raw, JSON.stringify(record)], options);
  if (Number(saved) !== 1) throw googleAuthError('Yêu cầu đã thay đổi. Vui lòng thử lại.', 409, 'GOOGLE_REQUEST_CHANGED');
  return { code, email: record.identity.email, expiresIn: Math.max(1, Math.ceil((record.expiresAt - Date.now()) / 1000)) };
}

export async function verifyGoogleEmailCode(id, browser, code, options = {}) {
  const pending = await readGooglePending(id, browser, options);
  if (pending.record.targetUserId || !pending.record.otp || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    throw googleAuthError('Mã xác minh không hợp lệ.', 400, 'INVALID_EMAIL_CODE');
  }
  const result = await redisCommand(['EVAL', `-- google:verify-email
    if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 'changed' end
    local record = cjson.decode(ARGV[1])
    if record.otp.attempts >= 5 then return 'blocked' end
    record.otp.attempts = record.otp.attempts + 1
    local matches = record.otp.hash == ARGV[2]
    if matches then record.otp.verified = true end
    local raw = cjson.encode(record)
    redis.call('SET', KEYS[1], raw, 'KEEPTTL')
    if not matches then return 'invalid' end
    return raw
  `, 1, key('pending', id), pending.raw, digest(`${pending.record.otp.salt}:${code}`)], options);
  if (result === 'blocked') throw googleAuthError('Bạn đã thử quá nhiều mã. Hãy đăng nhập Google lại.', 429, 'RATE_LIMITED');
  if (result === 'changed') throw googleAuthError('Yêu cầu đã thay đổi. Vui lòng thử lại.', 409, 'GOOGLE_REQUEST_CHANGED');
  if (!result || result === 'invalid') throw googleAuthError('Mã xác minh không đúng.', 400, 'INVALID_EMAIL_CODE');
  return { raw: result, record: JSON.parse(result) };
}

// One atomic script owns creation/linking and pending consumption. No partial
// reservations, automatic email merges, or client-provided role assignments.
const COMMIT_SCRIPT = `-- google:commit-account
  if ARGV[3] ~= '' and redis.call('GET', KEYS[6]) ~= ARGV[3] then return {'used'} end
  local linkedId = redis.call('GET', KEYS[1])
  if linkedId then
    local raw = redis.call('GET', ARGV[1] .. ':user:' .. linkedId)
    if not raw or cjson.decode(raw).googleSubject ~= ARGV[2] then return {'conflict'} end
    if ARGV[4] ~= '' and linkedId ~= ARGV[4] then return {'conflict'} end
    if ARGV[3] ~= '' then redis.call('DEL', KEYS[6]) end
    return {'existing', raw}
  end
  local owner = redis.call('GET', KEYS[2])
  if owner then
    if ARGV[4] == '' then return {'link_required', owner} end
    if owner ~= ARGV[4] then return {'conflict'} end
    local userKey = ARGV[1] .. ':user:' .. owner
    local raw = redis.call('GET', userKey)
    if not raw then return {'busy'} end
    local user = cjson.decode(raw)
    if user.googleSubject and user.googleSubject ~= ARGV[2] then return {'conflict'} end
    if user.passwordHash ~= ARGV[5] or user.email ~= ARGV[8] then return {'changed'} end
    user.googleSubject = ARGV[2]
    user.googleLinkedAt = ARGV[7]
    raw = cjson.encode(user)
    redis.call('SET', userKey, raw)
    redis.call('SET', KEYS[1], owner)
    redis.call('DEL', KEYS[6])
    return {'linked', raw}
  end
  if ARGV[4] ~= '' then return {'changed'} end
  if redis.call('EXISTS', KEYS[3]) == 1 or redis.call('EXISTS', KEYS[4]) == 1 then return {'collision'} end
  local user = cjson.decode(ARGV[6])
  redis.call('SET', KEYS[1], user.id)
  redis.call('SET', KEYS[2], user.id)
  redis.call('SET', KEYS[3], user.id)
  redis.call('SET', KEYS[4], ARGV[6])
  redis.call('SADD', KEYS[5], user.email)
  if ARGV[3] ~= '' then redis.call('DEL', KEYS[6]) end
  return {'created', ARGV[6]}
`;

export async function commitGoogleAccount(identity, { pendingId, pending, passwordHash } = {}, options = {}) {
  storage();
  const targetUserId = pending?.record.targetUserId || '';
  if (targetUserId && !passwordHash) throw googleAuthError('Cần xác nhận tài khoản trước khi liên kết.', 403, 'LINK_CONFIRMATION_REQUIRED');
  if (!targetUserId && !identity.authoritativeEmail && !pending?.record.otp?.verified) {
    throw googleAuthError('Cần xác minh email trước khi tạo tài khoản.', 403, 'EMAIL_CONFIRMATION_REQUIRED');
  }
  const id = randomUUID();
  const username = `rv_${randomBytes(10).toString('hex')}`;
  const now = new Date().toISOString();
  const user = {
    id, username, usernameNormalized: username, email: identity.email,
    displayName: identity.name, googleSubject: identity.subject, googleLinkedAt: now,
    passwordHash: null, createdAt: now,
    emailMarketingConsent: { status: 'not_subscribed', source: 'google_signup', consentedAt: null }
  };
  const result = await redisCommand(['EVAL', COMMIT_SCRIPT, 6,
    subjectKey(identity.subject), accounts.emailKey(identity.email), accounts.usernameKey(username),
    accounts.userKey(id), `${ACCOUNT_PREFIX}:emails`, key('pending', pendingId || 'none'),
    ACCOUNT_PREFIX, identity.subject, pending?.raw || '', targetUserId, passwordHash || '',
    JSON.stringify(user), now, identity.email
  ], options);
  if (['created', 'linked', 'existing'].includes(result?.[0])) {
    return { user: accounts.publicUser(JSON.parse(result[1])), created: result[0] === 'created' };
  }
  const errors = {
    used: [401, 'GOOGLE_REQUEST_USED'], changed: [409, 'GOOGLE_REQUEST_CHANGED'],
    link_required: [409, 'LINK_CONFIRMATION_REQUIRED'], conflict: [409, 'GOOGLE_ACCOUNT_CONFLICT'],
    busy: [409, 'ACCOUNT_BUSY'], collision: [409, 'ACCOUNT_BUSY']
  };
  const [status, code] = errors[result?.[0]] || [503, 'ACCOUNT_STORAGE_UNAVAILABLE'];
  throw googleAuthError('Chưa thể hoàn tất đăng nhập. Vui lòng đăng nhập Google lại.', status, code);
}

export const googleAuthStoreInternals = { TTL, digest, key, subjectKey, COMMIT_SCRIPT };
