import test from 'node:test';
import assert from 'node:assert/strict';
import { geminiAdminRouteStatus } from '../src/gemini-admin.mjs';

const base = {
  dailyLimited: false,
  cooldown: false,
  minuteLimited: false,
  inFlight: 0,
  degraded: false
};

test('admin chỉ báo in_flight khi route thực sự đang xử lý request', () => {
  assert.equal(geminiAdminRouteStatus({ ...base, inFlight: 1 }), 'in_flight');
  assert.equal(geminiAdminRouteStatus({ ...base, degraded: true }), 'degraded');
});

test('admin phân biệt cooldown, rate limit và quota ngày', () => {
  assert.equal(geminiAdminRouteStatus({ ...base, cooldown: true }), 'cooldown');
  assert.equal(geminiAdminRouteStatus({ ...base, minuteLimited: true }), 'rate_limited');
  assert.equal(geminiAdminRouteStatus({ ...base, dailyLimited: true }), 'used');
});
