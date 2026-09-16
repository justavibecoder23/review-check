import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPlatformReviewEnabled,
  isPlatformReviewEnabled,
  platformMaintenanceStatus
} from '../src/platform-availability.mjs';
import { getReviews } from '../src/sources.mjs';

test('hai sàn bật mặc định để tương thích deployment cũ', () => {
  assert.equal(isPlatformReviewEnabled('Shopee', {}), true);
  assert.equal(isPlatformReviewEnabled('TikTok Shop', {}), true);
});

test('công tắc từng sàn độc lập và nhận các giá trị false phổ biến', () => {
  for (const value of ['false', ' FALSE ', '0', 'off', 'NO']) {
    assert.equal(isPlatformReviewEnabled('Shopee', { SHOPEE_REVIEW_ENABLED: value }), false);
  }
  assert.equal(isPlatformReviewEnabled('TikTok Shop', {
    SHOPEE_REVIEW_ENABLED: 'false',
    TIKTOK_REVIEW_ENABLED: 'true'
  }), true);
});

test('lỗi bảo trì có status, code và thông báo đúng sàn', () => {
  const status = platformMaintenanceStatus('TikTok Shop', { TIKTOK_REVIEW_ENABLED: 'false' });
  assert.equal(status.enabled, false);
  assert.match(status.message, /TikTok Shop đang bảo trì/);
  assert.throws(
    () => assertPlatformReviewEnabled('Shopee', { SHOPEE_REVIEW_ENABLED: 'off' }),
    (error) => error.statusCode === 503
      && error.code === 'PLATFORM_MAINTENANCE'
      && error.details.platform === 'Shopee'
      && error.details.retryable === true
  );
});

test('getReviews chặn trước resolve, cache, Redis và actor', async () => {
  let redisCalls = 0;
  await assert.rejects(
    getReviews('https://shopee.vn/san-pham-i.1.123', {
      env: { SHOPEE_REVIEW_ENABLED: 'false' },
      redisFetchImpl: async () => {
        redisCalls += 1;
        throw new Error('Redis không được gọi');
      }
    }),
    (error) => error.statusCode === 503 && error.code === 'PLATFORM_MAINTENANCE'
  );
  assert.equal(redisCalls, 0);
});
