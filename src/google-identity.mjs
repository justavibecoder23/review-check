import { OAuth2Client } from 'google-auth-library';

const client = new OAuth2Client({ transporterOptions: { timeout: 5_000, retry: false } });

export function googleAuthError(message, statusCode = 400, code = 'GOOGLE_AUTH_ERROR') {
  return Object.assign(new Error(message), { statusCode, code });
}

export function googleAuthConfig(env = process.env) {
  const clientId = String(env.GOOGLE_CLIENT_ID || '').trim();
  const enabled = !/^(false|0|off|no)$/i.test(String(env.GOOGLE_LOGIN_ENABLED || 'true'))
    && /^\d+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId);
  return { enabled, clientId: enabled ? clientId : null };
}

export function assertGoogleEnabled(env = process.env) {
  const config = googleAuthConfig(env);
  if (!config.enabled) throw googleAuthError('Đăng nhập Google chưa được bật.', 503, 'GOOGLE_LOGIN_DISABLED');
  return config;
}

export async function verifyGoogleCredential(credential, nonce, options = {}) {
  const { clientId } = assertGoogleEnabled(options.env);
  if (typeof credential !== 'string' || credential.length > 16_384 || credential.split('.').length !== 3) {
    throw googleAuthError('Thông tin đăng nhập Google không hợp lệ.', 401, 'INVALID_GOOGLE_TOKEN');
  }
  let payload;
  try {
    const ticket = await (options.client || client).verifyIdToken({ idToken: credential, audience: clientId });
    payload = ticket.getPayload();
  } catch {
    // Never return library errors: they may contain credentials or claims.
    throw googleAuthError('Không thể xác minh đăng nhập Google. Vui lòng thử lại.', 401, 'INVALID_GOOGLE_TOKEN');
  }
  const now = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (!payload || payload.aud !== clientId
    || !['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)
    || !Number.isFinite(payload.exp) || payload.exp <= now
    || !Number.isFinite(payload.iat) || payload.iat > now + 60
    || typeof payload.sub !== 'string' || !/^[a-zA-Z0-9_-]{1,255}$/.test(payload.sub)
    || typeof nonce !== 'string' || !nonce || payload.nonce !== nonce) {
    throw googleAuthError('Thông tin đăng nhập Google không hợp lệ hoặc đã hết hạn.', 401, 'INVALID_GOOGLE_TOKEN');
  }
  const email = String(payload.email || '').trim().toLowerCase();
  if (payload.email_verified !== true || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw googleAuthError('Tài khoản Google chưa có email đã xác minh.', 401, 'GOOGLE_EMAIL_UNVERIFIED');
  }
  return {
    subject: payload.sub,
    email,
    name: String(payload.name || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100),
    authoritativeEmail: email.endsWith('@gmail.com') || (typeof payload.hd === 'string' && Boolean(payload.hd))
  };
}
