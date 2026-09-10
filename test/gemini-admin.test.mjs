import test from 'node:test';
import assert from 'node:assert/strict';
import {
  geminiAdminAvailabilityStatus,
  geminiAdminRouteStatus,
  summarizeGeminiAdminRoutes
} from '../src/gemini-admin.mjs';

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

test('admin tách availability khỏi sức khỏe và hiệu năng', () => {
  assert.equal(geminiAdminAvailabilityStatus({ ...base, degraded: true }), 'available');
  assert.equal(geminiAdminAvailabilityStatus({ ...base, inFlight: 1 }), 'busy');
  assert.equal(geminiAdminAvailabilityStatus({ ...base, cooldown: true }), 'cooldown');
  assert.equal(geminiAdminAvailabilityStatus({ ...base, minuteLimited: true }), 'rate_limited');
  assert.equal(geminiAdminAvailabilityStatus({ ...base, dailyLimited: true }), 'used');
});

test('admin tổng hợp độc lập availability, health và performance', () => {
  const totals = summarizeGeminiAdminRoutes([
    { availabilityStatus: 'available', healthStatus: 'healthy', performanceTier: 'fast' },
    { availabilityStatus: 'available', healthStatus: 'healthy', performanceTier: 'slow' },
    { availabilityStatus: 'busy', healthStatus: 'degraded', performanceTier: 'normal' },
    { availabilityStatus: 'cooldown', healthStatus: 'degraded', performanceTier: 'unknown' },
    { availabilityStatus: 'used', healthStatus: 'healthy', performanceTier: 'unknown' }
  ]);
  assert.deepEqual(totals, {
    healthy: 3,
    degraded: 2,
    available: 2,
    fast: 1,
    normal: 1,
    slow: 1,
    unknown: 2,
    inFlight: 1,
    cooldown: 1,
    rateLimited: 0,
    busy: 1,
    pending: 1,
    used: 1
  });
});
