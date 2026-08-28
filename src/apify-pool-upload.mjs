export const DEFAULT_APIFY_CONFIG_URL = 'https://review-check-beige.vercel.app/api/apify-config';

export async function uploadApifyPool(payload, options = {}) {
  const endpoint = String(options.endpoint || DEFAULT_APIFY_CONFIG_URL).trim();
  const adminKey = String(options.adminKey || '').trim();
  if (!/^https?:\/\//i.test(endpoint)) throw new Error('URL API cấu hình Apify không hợp lệ.');
  if (!adminKey) throw new Error('Chưa nhập APIFY_ADMIN_KEY.');

  const response = await (options.fetchImpl || fetch)(endpoint, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${adminKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(options.timeoutMs || 30_000)
  });
  let body;
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) throw new Error(body?.error || `API cấu hình trả về HTTP ${response.status}.`);
  if (!body?.updated || !body?.pool) throw new Error('API không xác nhận đã cập nhật Redis.');
  return body.pool;
}
