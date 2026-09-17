export function parseRequestBody(request) {
  if (typeof request.body === 'string') {
    try {
      return JSON.parse(request.body || '{}');
    } catch {
      const error = new Error('Dữ liệu JSON không hợp lệ.');
      error.statusCode = 400;
      error.code = 'INVALID_JSON';
      throw error;
    }
  }
  return request.body && typeof request.body === 'object' ? request.body : {};
}

export function firstQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

export function sendAdminJson(response, status, payload) {
  response.setHeader('Cache-Control', 'private, no-store, max-age=0');
  response.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  return response.status(status).json(payload);
}

export function assertAdminSameOrigin(request) {
  const origin = String(request.headers?.origin || '').trim();
  const host = String(request.headers?.['x-forwarded-host'] || request.headers?.host || '')
    .split(',')[0]
    .trim();
  if (!origin || !host) return;
  try {
    if (new URL(origin).host !== host) throw new Error('origin mismatch');
  } catch {
    const error = new Error('Yêu cầu không hợp lệ.');
    error.statusCode = 403;
    error.code = 'INVALID_ORIGIN';
    throw error;
  }
}

export function adminErrorPayload(error, fallback = 'Không thể xử lý bài viết lúc này.') {
  return {
    error: error?.message || fallback,
    ...(error?.code ? { code: error.code } : {}),
    ...(error?.details ? { details: error.details } : {})
  };
}
