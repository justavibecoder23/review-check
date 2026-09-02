import test from 'node:test';
import assert from 'node:assert/strict';
import { GEMINI_MODEL_LIMITS, GEMINI_TIMEOUT_COOLDOWN_MS, geminiRoutePressure, geminiRouteScore } from '../src/gemini-health.mjs';

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

test('health router dùng đúng RPM, TPM và RPD của bốn model', () => {
  assert.deepEqual(GEMINI_MODEL_LIMITS, {
    'gemini-3.5-flash': { rpm: 5, tpm: 250_000, rpd: 20 },
    'gemini-3.6-flash': { rpm: 5, tpm: 250_000, rpd: 20 },
    'gemini-3.7-flash': { rpm: 5, tpm: 250_000, rpd: 20 },
    'gemini-3.5-flash-lite': { rpm: 15, tpm: 250_000, rpd: 500 }
  });
  assert.equal(GEMINI_TIMEOUT_COOLDOWN_MS, 120_000);
});

test('3.5 Flash tăng mạnh áp lực khi chạm giới hạn 5 RPM', () => {
  const nowMs = Date.now();
  const fourRequests = Array.from({ length: 4 }, (_, index) => ({ at: nowMs - index * 1_000, ok: true }));
  const fiveRequests = [...fourRequests, { at: nowMs - 4_000, ok: true }];
  const nearLimit = geminiRoutePressure({ events: fourRequests }, 'gemini-3.5-flash', nowMs).value;
  const atLimit = geminiRoutePressure({ events: fiveRequests }, 'gemini-3.5-flash', nowMs).value;
  assert.ok(atLimit > nearLimit * 5);
});

test('Flash Lite dùng sức chứa 15 RPM và theo dõi TPM', () => {
  const nowMs = Date.now();
  const dayParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(nowMs));
  const dayValues = Object.fromEntries(dayParts.map((part) => [part.type, part.value]));
  const day = `${dayValues.year}-${dayValues.month}-${dayValues.day}`;
  const events = Array.from({ length: 7 }, (_, index) => ({
    at: nowMs - index * 1_000, ok: true, tokens: 10_000
  }));
  const pressure = geminiRoutePressure({ events, day, dayRequests: 78 }, 'gemini-3.5-flash-lite', nowMs);
  assert.equal(pressure.recentRequests, 7);
  assert.equal(pressure.recentTokens, 70_000);
  assert.equal(pressure.dayRequests, 78);
  assert.ok(pressure.value > 0 && pressure.value < 1);
});
