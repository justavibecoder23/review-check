import { analyzeProductUrl } from '../src/analyze.mjs';
import { clientDisconnectSignal } from '../src/sse.mjs';
import { attachResultChatContext, scheduleResultChatContext } from '../src/result-chat-background.mjs';
import { analysisAccessStatus, analysisErrorPayload, beginAnalysisAccess } from '../src/analysis-access.mjs';
import { guestQuotaConfig } from '../src/guest-analysis-quota.mjs';

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method === 'GET') {
    try {
      return response.status(200).json(await analysisAccessStatus(request, response));
    } catch (error) {
      return response.status(error?.statusCode || 503).json(analysisErrorPayload(error));
    }
  }
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'GET, POST');
    return response.status(405).json({ error: 'Phương thức không được hỗ trợ.' });
  }

  let access;
  try {
    const body = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : (request.body || {});
    access = await beginAnalysisAccess(request, response, body.url);
    const result = await analyzeProductUrl(body.url, { signal: clientDisconnectSignal(request, response) });
    const preparedContext = attachResultChatContext(result);
    const remainingGuestQuota = await access.confirm(result);
    const sent = response.status(200).json({ ...result, remainingGuestQuota, guestQuotaLimit: guestQuotaConfig.limit });
    console.log(JSON.stringify({ level: 'info', event: 'analysis_result_sent', resultId: result.chatContext?.resultId || null }));
    scheduleResultChatContext(preparedContext);
    return sent;
  } catch (error) {
    await access?.refund().catch(() => {});
    return response.status(error?.statusCode || 500).json(analysisErrorPayload(error));
  }
}

