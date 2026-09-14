import { getResultChatContextStatus } from '../src/result-chat-context.mjs';

export default async function handler(request, response) {
  response.setHeader('cache-control', 'no-store');
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'Phương thức không được hỗ trợ.' });
  }

  try {
    const body = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : (request.body || {});
    const state = await getResultChatContextStatus(body.resultId, body.accessToken);
    return response.status(200).json(state);
  } catch (error) {
    return response.status(error?.statusCode || 503).json({
      status: error?.code === 'RESULT_CONTEXT_PREPARING' ? 'preparing' : 'unavailable',
      error: error?.message || 'Không kiểm tra được dữ liệu giải thích.',
      ...(error?.code ? { code: error.code } : {})
    });
  }
}
