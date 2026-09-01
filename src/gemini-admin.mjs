import { timingSafeEqual } from 'node:crypto';
import { getGeminiCredentialPoolStatus, saveGeminiCredentialPool } from './gemini-credential-store.mjs';

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && leftBuffer.length > 0 && timingSafeEqual(leftBuffer, rightBuffer);
}

export function assertGeminiAdmin(authorizationHeader) {
  const configured = String(process.env.GEMINI_ADMIN_KEY || process.env.APIFY_ADMIN_KEY || '');
  const supplied = String(authorizationHeader || '').replace(/^Bearer\s+/i, '');
  if (!configured || !safeEqual(supplied, configured)) {
    const error = new Error('Không có quyền quản trị cấu hình Gemini.');
    error.statusCode = 401;
    throw error;
  }
}

export async function readGeminiAdminStatus(options = {}) {
  return { pool: await getGeminiCredentialPoolStatus(options) };
}

export async function updateGeminiAdminPool(body, options = {}) {
  return saveGeminiCredentialPool({
    credentials: body?.credentials,
    mode: body?.mode || 'append'
  }, options);
}
