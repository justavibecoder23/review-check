import { createHash } from 'node:crypto';
import { googleAuthConfig, assertGoogleEnabled, googleAuthError, verifyGoogleCredential } from './google-identity.mjs';
import {
  beginGoogleLogin, readGoogleChallenge, consumeGoogleChallenge, resolveGoogleIdentity,
  createGooglePending, readGooglePending, verifyGoogleLinkPassword, createGoogleEmailCode,
  verifyGoogleEmailCode, commitGoogleAccount
} from './google-auth-store.mjs';
import { createAccountSession, deleteAccountSession, claimOfflineConsentNotice } from './account-store.mjs';
import { readSessionToken, sessionCookie } from '../api/auth.mjs';
import { redisCommand } from './redis-rest.mjs';
import { claimGuestHistory, discardGuestHistory } from './guest-analysis-quota.mjs';
import { sendEmailVerificationCode } from './email-verification-mail.mjs';
import { sendWelcomeEmail } from './welcome-email.mjs';

const BROWSER_COOKIE = 'realview_google_browser';

function readBrowser(request) {
  const match = String(request.headers?.cookie || '').match(/(?:^|;\s*)realview_google_browser=([a-zA-Z0-9_-]{43})(?:;|$)/);
  return match?.[1] || '';
}

function assertOrigin(request, env) {
  const origin = String(request.headers?.origin || '');
  const host = String(request.headers?.host || '').toLowerCase();
  const proto = env.VERCEL === '1' || request.headers?.['x-forwarded-proto'] === 'https' ? 'https:' : 'http:';
  try {
    const parsed = new URL(origin);
    const allowed = new Set([
      'https://www.realview.com.vn', 'https://realview.com.vn',
      ...String(env.GOOGLE_AUTH_ALLOWED_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean)
    ]);
    const local = env.VERCEL !== '1' && parsed.protocol === 'http:' && parsed.hostname === 'localhost';
    if (origin !== parsed.origin || parsed.host !== host || parsed.protocol !== proto
      || (!allowed.has(parsed.origin) && !local)
      || request.headers?.['sec-fetch-site'] === 'cross-site') throw new Error('origin');
  } catch {
    throw googleAuthError('Yêu cầu phải đến từ website RealView.', 403, 'INVALID_ORIGIN');
  }
}

function parseBody(request) {
  let body;
  try {
    const raw = typeof request.body === 'string' ? request.body : JSON.stringify(request.body || {});
    if (Buffer.byteLength(raw) > 20_000) throw googleAuthError('Yêu cầu quá lớn.', 413, 'BODY_TOO_LARGE');
    body = JSON.parse(raw);
  } catch (error) {
    if (error.code === 'BODY_TOO_LARGE') throw error;
    throw googleAuthError('Dữ liệu yêu cầu không hợp lệ.', 400, 'INVALID_BODY');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw googleAuthError('Dữ liệu yêu cầu không hợp lệ.', 400, 'INVALID_BODY');
  return body;
}

async function rateLimit(request, action, options) {
  const ip = String(request.headers?.['x-forwarded-for'] || request.socket?.remoteAddress || 'local').split(',')[0].trim();
  const hash = createHash('sha256').update(ip).digest('hex');
  const count = await redisCommand(['EVAL', `-- google:attempt
    local count = redis.call('INCR', KEYS[1])
    if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
    return count
  `, 1, `realview:google-auth:v1:rate:${action}:${hash}`, 900], options);
  const max = action === 'request_email_verification' ? 5 : 20;
  if (Number(count) > max) throw googleAuthError('Bạn đã thử quá nhiều lần. Vui lòng đợi rồi thử lại.', 429, 'RATE_LIMITED');
}

// Dependencies can be substituted by tests, never by request payloads.
export function createGoogleAuthHandler(options = {}) {
  return async function handler(request, response) {
    const env = options.env || process.env;
    const send = (status, payload) => {
      response.setHeader('Cache-Control', 'no-store');
      return response.status(status).json(payload);
    };
    try {
      if (request.method === 'GET') return send(200, googleAuthConfig(env));
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'GET, POST');
        return send(405, { error: 'Phương thức không được hỗ trợ.' });
      }
      const { clientId } = assertGoogleEnabled(env);
      assertOrigin(request, env);
      const body = parseBody(request);
      if (!['begin', 'authenticate', 'link_account', 'request_email_verification', 'verify_email'].includes(body.action)) {
        throw googleAuthError('Thao tác đăng nhập không hợp lệ.', 400, 'INVALID_GOOGLE_ACTION');
      }
      await rateLimit(request, body.action, options);
      const browser = readBrowser(request);
      if (body.action === 'begin') {
        const challenge = await beginGoogleLogin(browser, clientId, options);
        response.setHeader('Set-Cookie', sessionCookie(request, '', 0)
          .replace('realview_session=', `${BROWSER_COOKIE}=${challenge.browserToken}`)
          .replace('Max-Age=0', `Max-Age=${challenge.expiresIn}`));
        return send(200, { clientId, challengeId: challenge.challengeId, nonce: challenge.nonce, expiresIn: challenge.expiresIn });
      }

      let result;
      if (body.action === 'authenticate') {
        const challenge = await readGoogleChallenge(body.challengeId, browser, options);
        if (challenge.record.clientId !== clientId) throw googleAuthError('Cấu hình đã thay đổi. Vui lòng thử lại.', 401, 'INVALID_GOOGLE_REQUEST');
        const identity = await verifyGoogleCredential(body.credential, challenge.record.nonce, options);
        await consumeGoogleChallenge(body.challengeId, challenge.raw, options);
        const resolved = await resolveGoogleIdentity(identity, options);
        if (['link_required', 'email_required'].includes(resolved.kind)) {
          const pending = await createGooglePending(identity, resolved.targetUserId, browser, options);
          return send(200, { status: resolved.kind, ...pending });
        }
        result = resolved.kind === 'signed_in' ? resolved : await commitGoogleAccount(identity, {}, options);
      } else if (body.action === 'request_email_verification') {
        const code = await createGoogleEmailCode(body.pendingId, browser, options);
        const delivered = await (options.sendCode || sendEmailVerificationCode)(code.email, code.code, 'google_login', options)
          .catch(() => ({ delivered: false }));
        if (!delivered.delivered) throw googleAuthError('Chưa thể gửi mã xác minh. Vui lòng thử lại.', 503, 'EMAIL_DELIVERY_FAILED');
        return send(200, { status: 'email_code_sent', expiresIn: code.expiresIn });
      } else {
        const pending = body.action === 'verify_email'
          ? await verifyGoogleEmailCode(body.pendingId, browser, body.code, options)
          : await readGooglePending(body.pendingId, browser, options);
        const passwordHash = body.action === 'link_account'
          ? await verifyGoogleLinkPassword(body.pendingId, pending, body.password, options) : '';
        result = await commitGoogleAccount(pending.record.identity, { pendingId: body.pendingId, pending, passwordHash }, options);
      }

      const session = await createAccountSession(result.user, options);
      const oldSession = readSessionToken(request);
      if (oldSession) await deleteAccountSession(oldSession, options);
      response.setHeader('Set-Cookie', sessionCookie(request, session.token, session.expiresIn));
      let claimedGuestHistory = 0;
      if (result.created) {
        if (body.claimGuestHistory === true) {
          claimedGuestHistory = await (options.claimGuestHistory || claimGuestHistory)(request, response, result.user.id).catch(() => 0);
        } else {
          await (options.discardGuestHistory || discardGuestHistory)(request).catch(() => {});
        }
        // Welcome mail failure must not turn a valid sign-in into an error.
        await (options.sendWelcome || sendWelcomeEmail)({ ...result.user, username: result.user.displayName || result.user.username }).catch(() => {});
      }
      return send(result.created ? 201 : 200, {
        status: 'signed_in', user: result.user, created: result.created,
        claimedGuestHistory,
        showOfflineConsentNotice: !result.created ? await claimOfflineConsentNotice(result.user, options).catch(() => false) : false
      });
    } catch (error) {
      const status = error?.statusCode || 503;
      return send(status, {
        error: error?.statusCode ? error.message : 'Đăng nhập tạm thời không khả dụng. Vui lòng thử lại.',
        code: error?.code && error?.statusCode ? error.code : 'GOOGLE_AUTH_UNAVAILABLE'
      });
    }
  };
}

export default createGoogleAuthHandler();
export const googleAuthApiInternals = { assertOrigin, readBrowser, parseBody };
