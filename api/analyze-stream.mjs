import { analyzeProductUrl } from '../src/analyze.mjs';
import { clientDisconnectSignal, openSse } from '../src/sse.mjs';
import { attachResultChatContext, scheduleResultChatContext } from '../src/result-chat-background.mjs';

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'Phương thức không được hỗ trợ.' });
  }

  let body;
  try {
    body = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : (request.body || {});
  } catch {
    return response.status(400).json({ error: 'Nội dung gửi lên không hợp lệ.' });
  }

  const stream = openSse(response);
  const signal = clientDisconnectSignal(request, response);
  const heartbeat = setInterval(() => stream.send('heartbeat', { at: Date.now() }), 15_000);
  stream.send('ready', { message: 'Đã mở luồng cập nhật tiến độ.' });

  try {
    const result = await analyzeProductUrl(body.url, {
      onProgress: (progress) => stream.send('progress', progress),
      onProductMeta: (product) => stream.send('product_meta', product),
      onReviewsSample: (sample) => stream.send('reviews_sample', sample),
      onLayer1Stats: (stats) => stream.send('layer1_stats', stats),
      onLayer2Progress: (state) => stream.send('layer2_progress', state),
      signal
    });
    const preparedContext = attachResultChatContext(result);
    stream.send('result', result);
    console.log(JSON.stringify({ level: 'info', event: 'analysis_result_sent', resultId: result.chatContext?.resultId || null }));
    scheduleResultChatContext(preparedContext);
  } catch (error) {
    console.error('[analyze-stream] Analysis error:', {
      message: error?.message,
      code: error?.code,
      statusCode: error?.statusCode,
      details: error?.details,
      available: error?.available,
      diagnostics: error?.diagnostics
    });
    stream.send('error', {
      error: error?.message || 'Có lỗi khi phân tích sản phẩm.',
      statusCode: error?.statusCode || 500,
      ...(error?.code ? { code: error.code } : {}),
      ...(error?.details ? { details: error.details } : {})
    });
  } finally {
    clearInterval(heartbeat);
    stream.close();
  }
}

