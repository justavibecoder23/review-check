import { currentAccount } from '../api/auth.mjs';
import { guestQuotaConfig, guestQuotaStatus, reserveGuestAnalysis } from './guest-analysis-quota.mjs';

export async function analysisAccessStatus(request, response) {
  const user = await currentAccount(request);
  if (user) return { remainingGuestQuota: null, guestQuotaLimit: guestQuotaConfig.limit };
  return guestQuotaStatus(request, response);
}

export async function beginAnalysisAccess(request, response, url) {
  const user = await currentAccount(request);
  if (user) {
    return { remainingGuestQuota: null, confirm: async () => null, refund: async () => {} };
  }
  return reserveGuestAnalysis(request, response, url);
}

export function analysisErrorPayload(error) {
  return {
    error: error?.message || 'Có lỗi khi phân tích sản phẩm.',
    statusCode: error?.statusCode || 500,
    ...(error?.code ? { code: error.code } : {}),
    ...(error?.details ? { details: error.details } : {}),
    ...(Number.isFinite(error?.remainingGuestQuota) ? { remainingGuestQuota: error.remainingGuestQuota } : {}),
    ...(error?.code?.startsWith('GUEST_') ? { guestQuotaLimit: guestQuotaConfig.limit } : {})
  };
}
