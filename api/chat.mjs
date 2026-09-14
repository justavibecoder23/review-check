import { answerWebsiteQuestion } from '../src/site-chatbot.mjs';
import { createHash } from 'node:crypto';
import { generateId } from 'ai';
import { isRedisConfigured, redisCommand } from '../src/redis-rest.mjs';
import {
  loadResultChatContext,
  persistChatGeneration
} from '../src/result-chat-context.mjs';

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
    const resultContext = body.resultId
      ? await loadResultChatContext(body.resultId, body.resultAccessToken)
      : null;
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
    const result = await answerWebsiteQuestion(body.messages, { resultContext });
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
      error: error?.message || 'Có lỗi khi xử lý câu hỏi.'
    });
  }
}
