import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyApifyFailure,
  resolveTikTokRuntimeConfig,
  TIKTOK_DEFAULT_ACTOR_ID,
  TIKTOK_TEMPORARY_ACTOR_ID
} from '../src/apify-tiktok-runtime.mjs';
import {
  calculateApifyCycleBudget,
  calculateTikTokCostCapacity,
  normalizeApifyUsageSnapshot
} from '../src/apify-credential-store.mjs';

test('runtime chỉ chuyển toàn bộ actor bằng cờ true hoặc false', () => {
  const productId = '1729384756102938475';
  assert.equal(resolveTikTokRuntimeConfig(productId, { env: {} }).actorId, TIKTOK_DEFAULT_ACTOR_ID);
  assert.equal(resolveTikTokRuntimeConfig(productId, { env: { TIKTOK_USE_TEMPORARY_ACTOR: 'false' } }).actorId, TIKTOK_DEFAULT_ACTOR_ID);
  assert.equal(resolveTikTokRuntimeConfig(productId, { env: { TIKTOK_USE_TEMPORARY_ACTOR: 'true' } }).actorId, TIKTOK_TEMPORARY_ACTOR_ID);
});

test('runtime tạm thời đóng băng actor, schema, biểu phí và metadata mẫu', () => {
  const runtime = resolveTikTokRuntimeConfig('1729384756102938475', { useTemporaryActor: true, env: {} });
  assert.equal(Object.isFrozen(runtime), true);
  assert.equal(runtime.adapter, 'vistics');
  assert.equal(runtime.reviewCostMicroUsd, 3000);
  assert.equal(runtime.startupFeeMicroUsd, 5000);
  assert.equal(runtime.samplingStrategy, 'most-recent-100');
  assert.equal(runtime.distributionMode, 'observed-sample');
});

test('sổ cái tính đúng trần 1.377 review', () => {
  const capacity = calculateTikTokCostCapacity({
    budgetMicroUsd: 5_000_000,
    shopeeReservedMicroUsd: 798_000,
    reviewCostMicroUsd: 3_000,
    startupFeeMicroUsd: 5_000
  });
  assert.equal(capacity.availableMicroUsd, 4_202_000);
  // One reservation can afford 1,399 items; repeated 100-item runs have a
  // startup fee each, therefore the production allocator caps every run at 100.
  assert.equal(capacity.affordableReviews, 1399);
  const thirteenFullRuns = 13 * (5_000 + 100 * 3_000);
  const finalRunCapacity = Math.floor((capacity.availableMicroUsd - thirteenFullRuns - 5_000) / 3_000);
  assert.equal(13 * 100 + finalRunCapacity, 1377);
});

test('chu kỳ sổ cái lấy theo billing cycle riêng do Apify trả về', () => {
  const snapshot = normalizeApifyUsageSnapshot({
    usageCycle: {
      startAt: '2026-09-14T00:00:00.000Z',
      endAt: '2026-10-13T23:59:59.999Z'
    },
    totalUsageCreditsUsdAfterVolumeDiscount: 1.234567
  }, 'credential-1', 'account-1');
  assert.equal(snapshot.accountCycleId, 'account-1:2026-09-14T00:00:00.000Z');
  assert.equal(snapshot.cycleEndAt, '2026-10-13T23:59:59.999Z');
  assert.equal(snapshot.observedSpentMicroUsd, 1_234_567);
});

test('Shopee đủ 10 lượt thì giải phóng bảo lưu nhưng vẫn giữ chi phí cycle hiện tại', () => {
  const budget = calculateApifyCycleBudget({
    observedSpentMicroUsd: 900_000,
    locallyTrackedSpentMicroUsd: 850_000,
    shopeeLifetimeUsed: 10
  });
  assert.equal(budget.remainingShopeeUses, 0);
  assert.equal(budget.shopeeReservedMicroUsd, 0);
  assert.equal(budget.spentMicroUsd, 900_000);
  assert.equal(budget.availableMicroUsd, 4_100_000);
});

test('lượt Shopee đang chạy thay thế đúng một phần bảo lưu trọn đời', () => {
  const budget = calculateApifyCycleBudget({ shopeeLifetimeUsed: 8, shopeeLifetimeReserved: 1, reservedMicroUsd: 79_800 });
  assert.equal(budget.remainingShopeeUses, 1);
  assert.equal(budget.shopeeReservedMicroUsd, 79_800);
  assert.equal(budget.committedMicroUsd, 159_600);
});

test('phân loại 402, 403 và 429 thành ba trạng thái khác nhau', () => {
  assert.equal(classifyApifyFailure(402), 'billing_exhausted');
  assert.equal(classifyApifyFailure(403), 'actor_access_denied');
  assert.equal(classifyApifyFailure(429), 'temporary_throttle');
  assert.equal(classifyApifyFailure(503), 'upstream_service_error');
});
