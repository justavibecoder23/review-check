import { timingSafeEqual } from 'node:crypto';
import { getApifyCredentialPoolStatus, saveApifyCredentialPool } from './apify-credential-store.mjs';

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && leftBuffer.length > 0 && timingSafeEqual(leftBuffer, rightBuffer);
}

export function assertApifyAdmin(authorizationHeader) {
  const configured = String(process.env.APIFY_ADMIN_KEY || '');
  const supplied = String(authorizationHeader || '').replace(/^Bearer\s+/i, '');
  if (!configured || !safeEqual(supplied, configured)) {
    const error = new Error('Không có quyền quản trị cấu hình Apify.');
    error.statusCode = 401;
    throw error;
  }
}

export async function readApifyAdminStatus(options = {}) {
  return { pool: await getApifyCredentialPoolStatus(options) };
}

export async function updateApifyAdminPool(body, options = {}) {
  return saveApifyCredentialPool({
    groups: body?.groups,
    maxUsesPerKey: body?.maxUsesPerKey,
    mode: body?.mode || 'replace'
  }, options);
}
