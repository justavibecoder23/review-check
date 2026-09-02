import { answerWebsiteQuestion } from '../src/site-chatbot.mjs';

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'Phương thức không được hỗ trợ.' });
  }

  try {
    const body = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : (request.body || {});
    const result = await answerWebsiteQuestion(body.messages);
    return response.status(200).json(result);
  } catch (error) {
    return response.status(error?.statusCode || 500).json({
      error: error?.message || 'Có lỗi khi xử lý câu hỏi.'
    });
  }
}
