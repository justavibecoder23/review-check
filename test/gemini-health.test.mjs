import test from 'node:test';
import assert from 'node:assert/strict';
import { geminiRoutePressure, geminiRouteScore } from '../src/gemini-health.mjs';

test('route đang cooldown không được chọn trước route khỏe', () => {
  const nowMs = Date.now();
  const cooling = geminiRouteScore({ cooldownUntilMs: nowMs + 30_000 }, 'gemini-3.5-flash', nowMs);
  const healthy = geminiRouteScore({ events: [], inFlight: 0 }, 'gemini-3.5-flash', nowMs);
  assert.equal(cooling, Number.POSITIVE_INFINITY);
  assert.ok(healthy < cooling);
});

test('health router tăng áp lực theo tải gần đây, độ trễ và request đang chạy', () => {
  const nowMs = Date.now();
  const quiet = geminiRoutePressure({ events: [], ewmaLatencyMs: 500, inFlight: 0 }, 'gemini-3.5-flash', nowMs);
  const busy = geminiRoutePressure({
    events: Array.from({ length: 8 }, (_, index) => ({ at: nowMs - index * 1_000, ok: index > 1 })),
    ewmaLatencyMs: 8_000,
    inFlight: 2,
    lastStartedAtMs: nowMs
  }, 'gemini-3.5-flash', nowMs);
  assert.ok(busy.value > quiet.value);
  assert.equal(busy.recentRequests, 8);
  assert.equal(busy.inFlight, 2);
});

test('health router bỏ dữ liệu tải cũ khỏi cửa sổ một phút', () => {
  const nowMs = Date.now();
  const pressure = geminiRoutePressure({
    events: [{ at: nowMs - 90_000, ok: false }, { at: nowMs - 2_000, ok: true }]
  }, 'gemini-3.5-flash', nowMs);
  assert.equal(pressure.recentRequests, 1);
});

test('3.5 Flash bắt đầu chuyển route khi chạm giới hạn 5 RPM đã xác nhận', () => {
  const nowMs = Date.now();
  const fourRequests = Array.from({ length: 4 }, (_, index) => ({ at: nowMs - index * 1_000, ok: true }));
  const fiveRequests = [...fourRequests, { at: nowMs - 4_000, ok: true }];
  assert.equal(geminiRoutePressure({ events: fourRequests }, 'gemini-3.5-flash', nowMs).value, 0);
  assert.ok(geminiRoutePressure({ events: fiveRequests }, 'gemini-3.5-flash', nowMs).value > 0);
});
