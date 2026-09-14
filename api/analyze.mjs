import { analyzeProductUrl } from '../src/analyze.mjs';
import { clientDisconnectSignal } from '../src/sse.mjs';
import { attachResultChatContext, scheduleResultChatContext } from '../src/result-chat-background.mjs';

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'Phương thức không được hỗ trợ.' });
  }

  try {
    const body = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : (request.body || {});
    const result = await analyzeProductUrl(body.url, { signal: clientDisconnectSignal(request, response) });
    const preparedContext = attachResultChatContext(result);
    const sent = response.status(200).json(result);
    console.log(JSON.stringify({ level: 'info', event: 'analysis_result_sent', resultId: result.chatContext?.resultId || null }));
    scheduleResultChatContext(preparedContext);
    return sent;
  } catch (error) {
    return response.status(error?.statusCode || 500).json({
      error: error?.message || 'Có lỗi khi phân tích sản phẩm.',
      ...(error?.code ? { code: error.code } : {}),
      ...(error?.details ? { details: error.details } : {})
    });
  }
}

