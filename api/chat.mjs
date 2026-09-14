import { answerWebsiteQuestion } from '../src/site-chatbot.mjs';
import { createHash } from 'node:crypto';
import { generateId } from 'ai';
import { isRedisConfigured, redisCommand } from '../src/redis-rest.mjs';
import {
  loadResultChatContext,
  persistChatGeneration,
  buildResultChatContext
} from '../src/result-chat-context.mjs';
import { currentAccount } from './auth.mjs';
import { getAccountHistoryItem } from '../src/account-store.mjs';

function chatError(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code });
}

async function resolveChatContexts(request, body) {
  const context = body.context || null;
  if (!context && body.resultId) {
    return [await loadResultChatContext(body.resultId, body.resultAccessToken)];
  }
  if (!context) return [];
  if (context.type === 'current_result') {
    return [await loadResultChatContext(context.resultId, context.accessToken)];
  }
  if (!['history_item', 'history_comparison'].includes(context.type)) {
    throw chatError('Phạm vi hỏi đáp không hợp lệ.', 400, 'INVALID_CHAT_CONTEXT');
  }
  const user = await currentAccount(request);
  if (!user) throw chatError('Vui lòng đăng nhập để hỏi về lịch sử phân tích.', 401, 'AUTH_REQUIRED');
  const ids = context.type === 'history_comparison'
    ? (Array.isArray(context.historyItemIds) ? context.historyItemIds : [])
    : [context.historyItemId];
  const normalizedIds = [...new Set(ids.map((id) => String(id || '').slice(0, 160)).filter(Boolean))];
  if (!normalizedIds.length || normalizedIds.length > 3) {
    throw chatError('Chỉ có thể hỏi về tối đa 3 sản phẩm trong lịch sử.', 400, 'INVALID_HISTORY_SELECTION');
  }
  const items = await Promise.all(normalizedIds.map((id) => getAccountHistoryItem(user.id, id)));
  if (items.some((item) => !item?.fullReport)) {
    throw chatError('Không tìm thấy sản phẩm này trong lịch sử của bạn.', 404, 'HISTORY_ITEM_NOT_FOUND');
  }
  return items.map((item, index) => buildResultChatContext(item.fullReport, {
    resultId: `history:${item.id}`,
    now: item.analyzedAt,
    refPrefix: normalizedIds.length > 1 ? `P${index + 1}-R` : 'R'
  }));
}

async function enforceChatRateLimit(request) {
  if (!isRedisConfigured()) return;
  const forwarded = String(request.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const identity = forwarded || String(request.socket?.remoteAddress || 'local');
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  const key = `realview:chatbot:rate:v1:${digest}`;
  const count = Number(await redisCommand([
    'EVAL',
    "local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return count",
    '1', key, '300'
  ], { timeoutMs: 700 }));
  if (count > 30) {
    const error = new Error('Bạn đã gửi quá nhiều câu hỏi. Vui lòng đợi ít phút rồi thử lại.');
    error.statusCode = 429;
    throw error;
  }
}

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'Phương thức không được hỗ trợ.' });
  }

  let generationId = null;
  let generationStartedAt = null;
  let generationResultId = null;
  let generationQuestion = '';
  try {
    const body = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : (request.body || {});
    await enforceChatRateLimit(request).catch((error) => {
      if (error?.statusCode === 429) throw error;
    });
    generationId = generateId();
    const resultContexts = await resolveChatContexts(request, body);
    const resultContext = resultContexts[0] || null;
    const latestQuestion = Array.isArray(body.messages)
      ? String(body.messages.filter((message) => message?.role === 'user').at(-1)?.content || '').slice(0, 500)
      : '';
    const startedAt = new Date().toISOString();
    generationStartedAt = startedAt;
    generationResultId = resultContext?.resultId || null;
    generationQuestion = latestQuestion;
    await persistChatGeneration({
      id: generationId,
      status: 'pending',
      resultId: resultContext?.resultId || null,
      question: latestQuestion,
      createdAt: startedAt
    });
    const result = await answerWebsiteQuestion(body.messages, { resultContext, resultContexts });
    await persistChatGeneration({
      id: generationId,
      status: 'complete',
      resultId: resultContext?.resultId || null,
      question: latestQuestion,
      answer: result.answer,
      engine: result.engine,
      model: result.model || null,
      citations: result.citations || [],
      createdAt: startedAt,
      completedAt: new Date().toISOString()
    });
    return response.status(200).json({ ...result, generationId });
  } catch (error) {
    if (generationId) {
      await persistChatGeneration({
        id: generationId,
        status: 'error',
        resultId: generationResultId,
        question: generationQuestion,
        errorCode: error?.code || 'CHAT_ERROR',
        createdAt: generationStartedAt,
        completedAt: new Date().toISOString()
      }).catch(() => false);
    }
    return response.status(error?.statusCode || 500).json({
      error: error?.message || 'Có lỗi khi xử lý câu hỏi.',
      ...(error?.code ? { code: error.code } : {})
    });
  }
}
