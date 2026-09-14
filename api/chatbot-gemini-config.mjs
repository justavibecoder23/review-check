import {
  assertChatbotGeminiAdmin,
  readChatbotGeminiAdminStatus,
  updateChatbotGeminiAdminPool
} from '../src/chatbot-gemini-pool.mjs';

export default async function handler(request, response) {
  response.setHeader('cache-control', 'no-store');
  if (!['GET', 'PUT'].includes(request.method)) {
    response.setHeader('Allow', 'GET, PUT');
    return response.status(405).json({ error: 'Phương thức không được hỗ trợ.' });
  }
  try {
    assertChatbotGeminiAdmin(request.headers.authorization);
    if (request.method === 'GET') {
      return response.status(200).json(await readChatbotGeminiAdminStatus());
    }
    const body = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : (request.body || {});
    const pool = await updateChatbotGeminiAdminPool(body);
    return response.status(200).json({ updated: true, pool });
  } catch (error) {
    return response.status(error?.statusCode || 500).json({
      error: error?.message || 'Không cập nhật được Gemini pool của chatbot.'
    });
  }
}
