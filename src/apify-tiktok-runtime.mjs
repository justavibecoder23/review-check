export const TIKTOK_DEFAULT_ACTOR_ID = 'mqQyDGEWtrrSMXjaf';
export const TIKTOK_TEMPORARY_ACTOR_ID = 'H2sFHG9D8SOFlHlaR';
export const TIKTOK_DEFAULT_USAGE_MICRO_USD_PER_REVIEW = 800;
export const TIKTOK_TEMPORARY_USAGE_MICRO_USD_PER_REVIEW = 3_000;
export const TIKTOK_TEMPORARY_STARTUP_FEE_MICRO_USD = 5_000;

function integer(value, fallback, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function enabled(value) {
  return ['true', '1', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

export function resolveTikTokRuntimeConfig(productId, options = {}) {
  if (!/^\d{8,25}$/.test(String(productId || ''))) throw new Error('Mã sản phẩm TikTok Shop không hợp lệ.');
  const env = options.env || process.env;
  const useTemporaryActor = options.useTemporaryActor === undefined
    ? enabled(env.TIKTOK_USE_TEMPORARY_ACTOR)
    : Boolean(options.useTemporaryActor);
  const region = String(options.region || env.APIFY_TIKTOK_TEMPORARY_REGION || 'VN').trim().toUpperCase();

  if (useTemporaryActor) {
    return Object.freeze({
      actorId: String(options.actorId || env.APIFY_TIKTOK_TEMPORARY_ACTOR_ID || TIKTOK_TEMPORARY_ACTOR_ID),
      adapter: 'vistics',
      strategy: 'single-unfiltered',
      samplingStrategy: 'most-recent-100',
      distributionMode: 'observed-sample',
      methodVersion: 'v4.2-unstratified-time-biased',
      pricingVersion: 'vistics-pay-per-event-2026-09',
      randomized: false,
      region,
      reviewLimit: 100,
      reviewCostMicroUsd: integer(env.TIKTOK_TEMPORARY_USAGE_MICRO_USD_PER_REVIEW, TIKTOK_TEMPORARY_USAGE_MICRO_USD_PER_REVIEW, 1),
      startupFeeMicroUsd: integer(env.TIKTOK_TEMPORARY_STARTUP_FEE_MICRO_USD, TIKTOK_TEMPORARY_STARTUP_FEE_MICRO_USD, 0),
      temporary: true
    });
  }

  return Object.freeze({
    actorId: String(options.actorId || env.APIFY_TIKTOK_ACTOR_ID || TIKTOK_DEFAULT_ACTOR_ID),
    adapter: 'web-wanderer',
    strategy: 'parallel-star-filters',
    samplingStrategy: 'parallel-star-filters',
    distributionMode: 'excluded-controlled-sample',
    methodVersion: 'v4.2-stratified',
    pricingVersion: 'web-wanderer-2026-08',
    randomized: false,
    region: 'VN',
    reviewLimit: 100,
    reviewCostMicroUsd: integer(env.TIKTOK_DEFAULT_USAGE_MICRO_USD_PER_REVIEW, TIKTOK_DEFAULT_USAGE_MICRO_USD_PER_REVIEW, 1),
    startupFeeMicroUsd: integer(env.TIKTOK_DEFAULT_STARTUP_FEE_MICRO_USD, 0, 0),
    temporary: false
  });
}

export function classifyApifyFailure(statusCode, error = null) {
  const status = Number(statusCode) || null;
  if (status === 402) return 'billing_exhausted';
  if (status === 401) return 'invalid_auth';
  if (status === 403) return 'actor_access_denied';
  if (status === 429) return 'temporary_throttle';
  if (status && status >= 500) return 'upstream_service_error';
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || /timeout|timed out|hết thời gian/i.test(String(error?.message || ''))) {
    return 'timeout';
  }
  return 'unknown_error';
}
