import { analyzeProductUrl } from '../src/analyze.mjs';
import { clientDisconnectSignal, openSse } from '../src/sse.mjs';
import { attachResultChatContext, scheduleResultChatContext } from '../src/result-chat-background.mjs';
import { analysisErrorPayload, beginAnalysisAccess } from '../src/analysis-access.mjs';
import { guestQuotaConfig } from '../src/guest-analysis-quota.mjs';

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

  response.setHeader('Cache-Control', 'no-store');
  let access;
  let accessError;
  try {
    access = await beginAnalysisAccess(request, response, body.url);
  } catch (error) {
    accessError = error;
  }

  const stream = openSse(response);
  if (accessError) {
    stream.send('error', analysisErrorPayload(accessError));
    stream.close();
    return;
  }
  const signal = clientDisconnectSignal(request, response);
  const heartbeat = setInterval(() => stream.send('heartbeat', { at: Date.now() }), 15_000);
  stream.send('ready', { message: 'Đã mở luồng cập nhật tiến độ.', remainingGuestQuota: access.remainingGuestQuota, guestQuotaLimit: guestQuotaConfig.limit });

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
    const remainingGuestQuota = await access.confirm(result);
    stream.send('result', { ...result, remainingGuestQuota, guestQuotaLimit: guestQuotaConfig.limit });
    console.log(JSON.stringify({ level: 'info', event: 'analysis_result_sent', resultId: result.chatContext?.resultId || null }));
    scheduleResultChatContext(preparedContext);
  } catch (error) {
    await access.refund().catch(() => {});
    console.error('[analyze-stream] Analysis error:', {
      message: error?.message,
      code: error?.code,
      statusCode: error?.statusCode,
      details: error?.details,
      available: error?.available,
      diagnostics: error?.diagnostics
    });
    stream.send('error', analysisErrorPayload(error));
  } finally {
    clearInterval(heartbeat);
    stream.close();
  }
}

