import test from 'node:test';
import assert from 'node:assert/strict';
import { createShopeeMetadataTicket, verifyShopeeMetadataTicket } from '../src/shopee-metadata-ticket.mjs';

const env = { RESULT_CONTEXT_SIGNING_SECRET: 'test-only-shopee-ticket-secret' };
const now = Date.parse('2026-09-30T10:00:00.000Z');

test('metadata ticket chỉ dùng cho đúng Shopee ID và hết hạn sau 10 phút', () => {
  const ticket = createShopeeMetadataTicket('123', '456', { env, now });
  assert.equal(verifyShopeeMetadataTicket(ticket, '123', '456', { env, now: now + 1_000 }), true);
  assert.equal(verifyShopeeMetadataTicket(ticket, '123', '457', { env, now: now + 1_000 }), false);
  assert.equal(verifyShopeeMetadataTicket(ticket, '123', '456', { env, now: now + 600_001 }), false);
  assert.equal(verifyShopeeMetadataTicket(`${ticket}x`, '123', '456', { env, now: now + 1_000 }), false);
  assert.equal(createShopeeMetadataTicket('123', '456', { env: {}, now }), '');
});
