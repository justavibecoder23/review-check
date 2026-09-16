const DISABLED_VALUES = new Set(['false', '0', 'off', 'no']);

const PLATFORM_CONFIG = Object.freeze({
  Shopee: {
    envKey: 'SHOPEE_REVIEW_ENABLED',
    label: 'Shopee'
  },
  'TikTok Shop': {
    envKey: 'TIKTOK_REVIEW_ENABLED',
    label: 'TikTok Shop'
  }
});

function configuredPlatform(platform) {
  return PLATFORM_CONFIG[String(platform || '').trim()] || null;
}

export function isPlatformReviewEnabled(platform, env = process.env) {
  const config = configuredPlatform(platform);
  if (!config) return true;
  const raw = env?.[config.envKey];
  if (raw == null || !String(raw).trim()) return true;
  return !DISABLED_VALUES.has(String(raw).trim().toLowerCase());
}

export function platformMaintenanceStatus(platform, env = process.env) {
  const config = configuredPlatform(platform);
  if (!config || isPlatformReviewEnabled(platform, env)) {
    return { enabled: true, platform: config?.label || String(platform || ''), envKey: config?.envKey || null };
  }
  return {
    enabled: false,
    platform: config.label,
    envKey: config.envKey,
    code: 'PLATFORM_MAINTENANCE',
    message: `Hệ thống lấy review ${config.label} đang bảo trì. Hiện chưa thể phân tích sản phẩm này. Vui lòng thử lại sau.`
  };
}

export function assertPlatformReviewEnabled(platform, env = process.env) {
  const status = platformMaintenanceStatus(platform, env);
  if (status.enabled) return status;
  const error = new Error(status.message);
  error.statusCode = 503;
  error.code = status.code;
  error.details = { platform: status.platform, retryable: true };
  throw error;
}
