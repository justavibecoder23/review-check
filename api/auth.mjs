import {
  acceptEmailMarketingConsent,
  authenticateAccount,
  assertRegistrationAvailable,
  claimOfflineConsentNotice,
  createAccountSession,
  createPasswordReset,
  deleteAccountSession,
  getAccountFromSession,
  registerAccount,
  resetAccountPassword
} from '../src/account-store.mjs';
import { createHash } from 'node:crypto';
import { redisCommand } from '../src/redis-rest.mjs';
import { sendWelcomeEmail } from '../src/welcome-email.mjs';
import { sendPasswordResetEmail } from '../src/password-reset-email.mjs';
import { claimGuestHistory, discardGuestHistory } from '../src/guest-analysis-quota.mjs';
import {
  createEmailVerification,
  deleteEmailVerification,
  verifyEmailCode
} from '../src/email-verification.mjs';
import { sendEmailVerificationCode } from '../src/email-verification-mail.mjs';

const COOKIE_NAME = 'realview_session';

function parseBody(request) {
  try {
    const raw = typeof request.body === 'string' ? request.body : JSON.stringify(request.body || {});
    if (Buffer.byteLength(raw) > 20_000) throw new Error('invalid');
    const body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid');
    return body;
  } catch { throw Object.assign(new Error('Dữ liệu yêu cầu không hợp lệ.'), { statusCode: 400, code: 'INVALID_BODY' }); }
}

function readSessionToken(request) {
  const cookie = String(request.headers?.cookie || '');
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  try { return match ? decodeURIComponent(match[1]) : ''; } catch { return ''; }
}

function sessionCookie(request, token, maxAge) {
  const forwardedProto = String(request.headers?.['x-forwarded-proto'] || '').toLowerCase();
  const secure = forwardedProto === 'https' || process.env.VERCEL === '1';
  return [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : '',
    `Max-Age=${maxAge}`
  ].filter(Boolean).join('; ');
}

function send(response, status, payload) {
  response.setHeader('Cache-Control', 'no-store');
  return response.status(status).json(payload);
}

function assertSameOrigin(request) {
  const origin = String(request.headers?.origin || '');
  const host = String(request.headers?.['x-forwarded-host'] || request.headers?.host || '').split(',')[0].trim();
  try {
    const parsed = new URL(origin);
    const protocol = process.env.VERCEL === '1' || request.headers?.['x-forwarded-proto'] === 'https' ? 'https:' : 'http:';
    if (!host || parsed.host !== host || parsed.protocol !== protocol || origin !== parsed.origin || request.headers?.['sec-fetch-site'] === 'cross-site') {
      const error = new Error('Yêu cầu không hợp lệ.');
      error.statusCode = 403;
      error.code = 'INVALID_ORIGIN';
      throw error;
    }
  } catch (error) {
    if (error?.code === 'INVALID_ORIGIN') throw error;
    const invalid = new Error('Yêu cầu không hợp lệ.');
    invalid.statusCode = 403;
    invalid.code = 'INVALID_ORIGIN';
    throw invalid;
  }
}

async function enforceRateLimit(request, action, options = {}) {
  const strict = ['register', 'request_registration_verification', 'request_password_reset', 'request_password_change'].includes(action);
  const windowSeconds = strict ? 60 * 60 : 15 * 60;
  const limit = strict ? 5 : 20;
  const forwarded = String(request.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const identity = forwarded || String(request.socket?.remoteAddress || 'local');
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  const key = `realview:account:v1:rate:${action}:${digest}`;
  const count = Number(await redisCommand(['EVAL', `-- account:rate-limit
    local count = redis.call('INCR', KEYS[1])
    if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
    return count
  `, 1, key, windowSeconds], options));
  if (count > limit) {
    const error = new Error('Bạn đã thử quá nhiều lần. Vui lòng đợi một lúc rồi thử lại.');
    error.statusCode = 429;
    error.code = 'RATE_LIMITED';
    throw error;
  }
}

function registrationContext(value) {
  return JSON.stringify({
    username: String(value.normalizedUsername || ''),
    email: String(value.normalizedEmail || '')
  });
}

export async function currentAccount(request, options = {}) {
  const token = readSessionToken(request);
  if (!token) return null;
  try {
    return await getAccountFromSession(token, options);
  } catch (error) {
    if (error?.code === 'ACCOUNT_STORAGE_UNAVAILABLE') throw error;
    return null;
  }
}

// Dependency substitution is server/test-only, never accepted from a request.
export function createAccountAuthHandler(options = {}) {
  return async function handler(request, response) {
    try {
      if (request.method === 'GET') {
        return send(response, 200, { user: await currentAccount(request, options) });
      }
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'GET, POST');
        return send(response, 405, { error: 'Phương thức không được hỗ trợ.' });
      }

      assertSameOrigin(request);
      const body = parseBody(request);
      if (body.action === 'logout') {
        const token = readSessionToken(request);
        await deleteAccountSession(token, options);
        response.setHeader('Set-Cookie', sessionCookie(request, '', 0));
        return send(response, 200, { user: null });
      }

      if (body.action === 'consent_email_marketing') {
        await enforceRateLimit(request, body.action, options);
        const sessionUser = await currentAccount(request, options);
        if (!sessionUser) return send(response, 401, { error: 'Vui lòng đăng nhập để lưu lựa chọn này.' });
        const user = await acceptEmailMarketingConsent(sessionUser.id, options);
        return send(response, 200, { user });
      }

      if (['request_password_reset', 'request_password_change'].includes(body.action)) {
        await enforceRateLimit(request, body.action, options);
        const sessionUser = body.action === 'request_password_change' ? await currentAccount(request, options) : null;
        if (body.action === 'request_password_change' && !sessionUser) return send(response, 401, { error: 'Vui lòng đăng nhập lại để quản lý mật khẩu.' });
        const reset = await createPasswordReset(sessionUser ? sessionUser.email : body.email, options);
        if (reset.user && reset.code) {
          const delivery = await (options.sendReset || sendPasswordResetEmail)(reset.user, reset.code).catch(() => ({ delivered: false }));
          if (!delivery?.delivered) console.warn('[auth] Password verification mail was not delivered; check transactional-email configuration.');
        }
        return send(response, 200, {
          resetId: reset.requestId,
          expiresIn: reset.expiresIn,
          message: 'Nếu email đã đăng ký với RealView, mã xác minh sẽ được gửi trong ít phút.'
        });
      }

      if (body.action === 'request_registration_verification') {
        await enforceRateLimit(request, body.action, options);
        const registration = await assertRegistrationAvailable(body, options);
        const verification = await createEmailVerification({
          purpose: 'registration',
          email: registration.normalizedEmail,
          context: registrationContext(registration)
        }, options);
        const delivery = await (options.sendCode || sendEmailVerificationCode)(
          registration.normalizedEmail,
          verification.code,
          'registration'
        ).catch(() => ({ delivered: false, reason: 'delivery_failed' }));
        if (!delivery.delivered) {
          await deleteEmailVerification(verification.requestId, options).catch(() => {});
          const error = new Error('Chưa thể gửi mã xác minh đến email này. Vui lòng kiểm tra địa chỉ và thử lại.');
          error.statusCode = 503;
          error.code = 'EMAIL_DELIVERY_FAILED';
          throw error;
        }
        return send(response, 200, {
          verificationId: verification.requestId,
          expiresIn: verification.expiresIn,
          message: 'Mã xác minh 6 số đã được gửi đến email của bạn.'
        });
      }

      if (body.action === 'reset_password') {
        await enforceRateLimit(request, body.action, options);
        const user = await resetAccountPassword(body, options);
        await deleteAccountSession(readSessionToken(request), options);
        const session = await createAccountSession(user, options);
        response.setHeader('Set-Cookie', sessionCookie(request, session.token, session.expiresIn));
        return send(response, 200, { user, message: 'Mật khẩu đã được cập nhật.' });
      }

      if (!['register', 'login'].includes(body.action)) {
        return send(response, 400, { error: 'Yêu cầu tài khoản không hợp lệ.' });
      }

      await enforceRateLimit(request, body.action, options);
      const isRegistration = body.action === 'register';
      if (isRegistration) {
        const registration = await assertRegistrationAvailable(body, options);
        body.emailMarketingConsent = body.emailMarketingConsent === true;
        await verifyEmailCode({
          requestId: body.verificationId,
          code: body.code,
          purpose: 'registration',
          email: registration.normalizedEmail,
          context: registrationContext(registration)
        }, options);
      }
      const user = isRegistration
        ? await registerAccount(body, options)
        : await authenticateAccount(body, options);
      await deleteAccountSession(readSessionToken(request), options);
      const session = await createAccountSession(user, options);
      const showOfflineConsentNotice = !isRegistration
        ? await claimOfflineConsentNotice(user, options)
        : false;
      response.setHeader('Set-Cookie', sessionCookie(request, session.token, session.expiresIn));
      const claimedGuestHistory = isRegistration && body.claimGuestHistory === 'on'
        ? await (options.claimGuestHistory || claimGuestHistory)(request, response, user.id).catch((error) => {
          console.error('[auth] Guest history transfer failed:', error?.message);
          return 0;
        })
        : 0;
      if (isRegistration && body.claimGuestHistory !== 'on') {
        await (options.discardGuestHistory || discardGuestHistory)(request).catch((error) => {
          console.error('[auth] Unable to discard unclaimed guest history:', error?.message);
        });
      }
      const welcomeEmail = isRegistration
        ? await (options.sendWelcome || sendWelcomeEmail)(user).catch(() => ({ delivered: false, reason: 'delivery_failed' }))
        : null;
      return send(response, isRegistration ? 201 : 200, {
        user,
        ...(!isRegistration ? { showOfflineConsentNotice } : {}),
        ...(isRegistration ? { welcomeEmailDelivered: welcomeEmail.delivered, claimedGuestHistory } : {})
      });
    } catch (error) {
      return send(response, error?.statusCode || 500, {
        error: error?.statusCode ? error.message : 'Không thể xử lý tài khoản lúc này. Vui lòng thử lại.',
        ...(error?.code ? { code: error.code } : {})
      });
    }
  }
}

const accountAuthHandler = createAccountAuthHandler();

// Keep Google's public URL separate without deploying a thirteenth function
// on Vercel Hobby. The Google handler keeps its own origin/nonce/rate checks.
export default async function authEndpoint(request, response) {
  if (request.query?.authProvider === 'google') {
    const { default: googleAuthHandler } = await import('../src/google-auth-route.mjs');
    return googleAuthHandler(request, response);
  }
  return accountAuthHandler(request, response);
}

export { readSessionToken, sessionCookie };

