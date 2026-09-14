import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildResultChatContext,
  createResultAccessToken,
  loadResultChatContext,
  saveResultChatContext,
  verifyResultAccessToken
} from '../src/result-chat-context.mjs';
import { answerWebsiteQuestion } from '../src/site-chatbot.mjs';
import {
  CHATBOT_GEMINI_HEALTH_KEY,
  CHATBOT_GEMINI_POOL_KEY
} from '../src/chatbot-gemini-pool.mjs';
import { GEMINI_HEALTH_KEY } from '../src/gemini-health.mjs';
import { GEMINI_POOL_KEY } from '../src/gemini-credential-store.mjs';

const sampleResult = {
  product: { platform: 'TikTok Shop', title: 'Kẹo me cay', productId: '1732868593255220985', category: 'Thực phẩm' },
  stats: { scanned: 100, included: 92, excluded: 8, lowRatings: 4 },
  trust: {
    score: 83,
    label: 'Mức tin cậy rất cao',
    summary: 'Tập review có độ tin cậy cao.',
    pros: [{ label: 'Vị dễ ăn' }],
    cons: [{ label: 'Một số gói quá cay' }],
    drivers: []
  },
  verdict: 'Có một số phản hồi về độ cay.',
  issues: [{ id: 'mui-vi', label: 'Mùi / vị', count: 3 }],
  reviews: [
    { rating: 5, text: 'Vị me rõ, dễ ăn và đóng gói tốt.', included: true },
    { rating: 2, text: 'Gói này cay hơn mô tả.', included: true },
    { rating: 5, text: 'Tốt', included: false, exclusionReason: 'Khen chung chung, ít thông tin kiểm chứng' }
  ]
};

function withContextEnv(run) {
  const before = {
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
    secret: process.env.RESULT_CONTEXT_SIGNING_SECRET,
    chatbot: process.env.CHATBOT_GEMINI_API_KEY
  };
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
  process.env.RESULT_CONTEXT_SIGNING_SECRET = 'test-signing-secret-with-enough-entropy';
  process.env.CHATBOT_GEMINI_API_KEY = 'chatbot-test-key';
  return Promise.resolve(run()).finally(() => {
    for (const [name, value] of Object.entries({
      UPSTASH_REDIS_REST_URL: before.url,
      UPSTASH_REDIS_REST_TOKEN: before.token,
      RESULT_CONTEXT_SIGNING_SECRET: before.secret,
      CHATBOT_GEMINI_API_KEY: before.chatbot
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

test('result context chỉ giữ dữ liệu cần thiết và gắn mã review đối chiếu', () => {
  const context = buildResultChatContext(sampleResult, { resultId: 'result-1', now: new Date('2026-09-14T00:00:00Z') });
  assert.equal(context.resultId, 'result-1');
  assert.equal(context.product.category, 'Thực phẩm');
  assert.deepEqual(context.reviews.map((review) => review.ref), ['R001', 'R002', 'R003']);
  assert.equal(context.reviews[2].included, false);
  assert.equal(context.stats.included, 92);
});

test('token result bị khóa theo ID và thời hạn', () => withContextEnv(async () => {
  const nowMs = Date.parse('2026-09-14T00:00:00Z');
  const token = createResultAccessToken('result-1', { nowMs });
  assert.equal(verifyResultAccessToken('result-1', token, { nowMs: nowMs + 1000 }), true);
  assert.equal(verifyResultAccessToken('result-2', token, { nowMs: nowMs + 1000 }), false);
  assert.equal(verifyResultAccessToken('result-1', token, { nowMs: nowMs + 6 * 24 * 60 * 60 * 1000 }), false);
}));

test('context được lưu Redis có TTL rồi đọc lại bằng token', () => withContextEnv(async () => {
  const values = new Map();
  const redisFetchImpl = async (_url, init) => {
    const command = JSON.parse(init.body);
    if (command[0] === 'SET') {
      values.set(command[1], command[2]);
      assert.equal(command[3], 'EX');
      return new Response(JSON.stringify({ result: 'OK' }));
    }
    if (command[0] === 'GET') return new Response(JSON.stringify({ result: values.get(command[1]) || null }));
    throw new Error(`Redis command không mong đợi: ${command[0]}`);
  };
  const saved = await saveResultChatContext(sampleResult, {
    resultId: 'result-saved',
    now: new Date('2026-09-14T00:00:00Z'),
    redisFetchImpl
  });
  assert.equal(saved.available, true);
  const loaded = await loadResultChatContext(saved.resultId, saved.accessToken, {
    nowMs: Date.parse('2026-09-14T00:01:00Z'),
    redisFetchImpl
  });
  assert.equal(loaded.product.title, 'Kẹo me cay');
  assert.equal(loaded.trust.score, 83);
}));

test('chatbot diễn giải result nhưng không cho citation ngoài context', () => withContextEnv(async () => {
  const context = buildResultChatContext(sampleResult, { resultId: 'result-ai' });
  const response = await answerWebsiteQuestion([{ role: 'user', content: 'Nhược điểm của sản phẩm này là gì?' }], {
    resultContext: context,
    redisFetchImpl: async (_url, init) => {
      const command = JSON.parse(init.body);
      if (command[0] === 'HMGET') return new Response(JSON.stringify({ result: command.slice(2).map(() => null) }));
      if (command[0] === 'EVAL') return new Response(JSON.stringify({ result: JSON.stringify({ ok: true, state: {} }) }));
      throw new Error(`Redis command không mong đợi: ${command[0]}`);
    },
    fetchImpl: async (_url, init) => {
      const payload = JSON.parse(init.body);
      assert.match(payload.systemInstruction.parts[0].text, /Kẹo me cay/);
      assert.match(payload.systemInstruction.parts[0].text, /không tính lại TrustScore/i);
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          supported: true,
          answer: 'Một số người thấy sản phẩm cay hơn mô tả.',
          citations: ['R002', 'R999']
        }) }] } }]
      }));
    }
  });
  assert.equal(response.contextType, 'result');
  assert.deepEqual(response.citations, ['R002']);
}));

test('pool và health chatbot tách khỏi Layer 1/2', () => {
  assert.notEqual(CHATBOT_GEMINI_POOL_KEY, GEMINI_POOL_KEY);
  assert.notEqual(CHATBOT_GEMINI_HEALTH_KEY, GEMINI_HEALTH_KEY);
});
