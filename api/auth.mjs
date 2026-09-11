import {
  authenticateAccount,
  assertRegistrationAvailable,
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
import {
  createEmailVerification,
  deleteEmailVerification,
  verifyEmailCode
} from '../src/email-verification.mjs';
import { sendEmailVerificationCode } from '../src/email-verification-mail.mjs';

const COOKIE_NAME = 'realview_session';

function parseBody(request) {
  if (typeof request.body === 'string') return JSON.parse(request.body || '{}');
  return request.body || {};
}

function readSessionToken(request) {
  const cookie = String(request.headers?.cookie || '');
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : '';
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
  if (!origin || !host) return;
  try {
    if (new URL(origin).host !== host) {
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

async function enforceRateLimit(request, action) {
  const strict = ['register', 'request_registration_verification', 'request_password_reset'].includes(action);
  const windowSeconds = strict ? 60 * 60 : 15 * 60;
  const limit = strict ? 5 : 20;
  const forwarded = String(request.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const identity = forwarded || String(request.socket?.remoteAddress || 'local');
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  const key = `realview:account:v1:rate:${action}:${digest}`;
  const count = Number(await redisCommand(['INCR', key]));
  if (count === 1) await redisCommand(['EXPIRE', key, windowSeconds]);
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

export async function currentAccount(request) {
  const token = readSessionToken(request);
  if (!token) return null;
  try {
    return await getAccountFromSession(token);
  } catch (error) {
    if (error?.code === 'ACCOUNT_STORAGE_UNAVAILABLE') throw error;
    return null;
  }
}

export default async function handler(request, response) {
  try {
    if (request.method === 'GET') {
      return send(response, 200, { user: await currentAccount(request) });
    }
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'GET, POST');
      return send(response, 405, { error: 'Phương thức không được hỗ trợ.' });
    }

    assertSameOrigin(request);
    const body = parseBody(request);
    if (body.action === 'logout') {
      const token = readSessionToken(request);
      await deleteAccountSession(token);
      response.setHeader('Set-Cookie', sessionCookie(request, '', 0));
      return send(response, 200, { user: null });
    }

    if (body.action === 'request_password_reset') {
      await enforceRateLimit(request, body.action);
      const reset = await createPasswordReset(body.email);
      if (reset.user && reset.code) {
        await sendPasswordResetEmail(reset.user, reset.code).catch(() => ({ delivered: false }));
      }
      return send(response, 200, {
        resetId: reset.requestId,
        expiresIn: reset.expiresIn,
        message: 'Nếu email đã đăng ký với RealView, mã xác minh sẽ được gửi trong ít phút.'
      });
    }

    if (body.action === 'request_registration_verification') {
      await enforceRateLimit(request, body.action);
      const registration = await assertRegistrationAvailable(body);
      const verification = await createEmailVerification({
        purpose: 'registration',
        email: registration.normalizedEmail,
        context: registrationContext(registration)
      });
      const delivery = await sendEmailVerificationCode(
        registration.normalizedEmail,
        verification.code,
        'registration'
      ).catch(() => ({ delivered: false, reason: 'delivery_failed' }));
      if (!delivery.delivered) {
        await deleteEmailVerification(verification.requestId).catch(() => {});
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
      await enforceRateLimit(request, body.action);
      const user = await resetAccountPassword(body);
      const session = await createAccountSession(user);
      response.setHeader('Set-Cookie', sessionCookie(request, session.token, session.expiresIn));
      return send(response, 200, { user, message: 'Mật khẩu đã được cập nhật.' });
    }

    if (!['register', 'login'].includes(body.action)) {
      return send(response, 400, { error: 'Yêu cầu tài khoản không hợp lệ.' });
    }

    await enforceRateLimit(request, body.action);
    const isRegistration = body.action === 'register';
    if (isRegistration) {
      const registration = await assertRegistrationAvailable(body);
      await verifyEmailCode({
        requestId: body.verificationId,
        code: body.code,
        purpose: 'registration',
        email: registration.normalizedEmail,
        context: registrationContext(registration)
      });
    }
    const user = isRegistration
      ? await registerAccount(body)
      : await authenticateAccount(body);
    const session = await createAccountSession(user);
    response.setHeader('Set-Cookie', sessionCookie(request, session.token, session.expiresIn));
    const welcomeEmail = isRegistration
      ? await sendWelcomeEmail(user).catch(() => ({ delivered: false, reason: 'delivery_failed' }))
      : null;
    return send(response, isRegistration ? 201 : 200, {
      user,
      ...(isRegistration ? { welcomeEmailDelivered: welcomeEmail.delivered } : {})
    });
  } catch (error) {
    return send(response, error?.statusCode || 500, {
      error: error?.message || 'Không thể xử lý tài khoản lúc này.',
      ...(error?.code ? { code: error.code } : {})
    });
  }
}

export { readSessionToken };

