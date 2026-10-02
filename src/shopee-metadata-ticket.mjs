import { createHmac, timingSafeEqual } from 'node:crypto';

const TICKET_TTL_MS = 10 * 60_000;

function secret(env = process.env) {
  return String(env.RESULT_CONTEXT_SIGNING_SECRET || '').trim();
}

function sign(payload, key) {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

export function createShopeeMetadataTicket(shopId, itemId, options = {}) {
  const key = secret(options.env);
  if (!key || !/^\d+$/.test(String(shopId)) || !/^\d+$/.test(String(itemId))) return '';
  const expiresAt = Number(options.now || Date.now()) + TICKET_TTL_MS;
  const payload = `v1.${shopId}.${itemId}.${expiresAt}`;
  return `${payload}.${sign(payload, key)}`;
}

export function verifyShopeeMetadataTicket(ticket, shopId, itemId, options = {}) {
  const key = secret(options.env);
  if (!key || typeof ticket !== 'string' || ticket.length > 240) return false;
  const match = /^(v1\.\d+\.\d+\.(\d+))\.([A-Za-z0-9_-]+)$/.exec(ticket);
  if (!match) return false;
  const fields = match[1].split('.');
  const expiresAt = Number(match[2]);
  const now = Number(options.now || Date.now());
  if (fields[1] !== String(shopId) || fields[2] !== String(itemId)
    || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + TICKET_TTL_MS) return false;
  const expected = Buffer.from(sign(match[1], key));
  const supplied = Buffer.from(match[3]);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
