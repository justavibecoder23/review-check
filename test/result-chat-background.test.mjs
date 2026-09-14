import test from 'node:test';
import assert from 'node:assert/strict';
import { attachResultChatContext, scheduleResultChatContext } from '../src/result-chat-background.mjs';

const result = {
  product: { platform: 'Shopee', title: 'Sản phẩm thử', itemId: '123' },
  stats: { scanned: 20, included: 18, excluded: 2 },
  trust: { score: 80, pros: [], cons: [], drivers: [] },
  reviews: [{ rating: 5, text: 'Sản phẩm dùng ổn định.', included: true }]
};

test('lưu context được giao cho waitUntil và không chặn lúc gắn result', async () => {
  const before = {
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
    secret: process.env.RESULT_CONTEXT_SIGNING_SECRET
  };
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  process.env.RESULT_CONTEXT_SIGNING_SECRET = 'secret-with-enough-entropy';
  try {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const output = structuredClone(result);
    const prepared = attachResultChatContext(output, {
      resultId: 'background-1',
      redisFetchImpl: async () => {
        await gate;
        return new Response(JSON.stringify({ result: 'OK' }));
      }
    });
    assert.equal(output.chatContext.status, 'preparing');
    let background;
    assert.equal(scheduleResultChatContext(prepared, {
      redisFetchImpl: async () => {
        await gate;
        return new Response(JSON.stringify({ result: 'OK' }));
      },
      waitUntilImpl: (promise) => { background = promise; }
    }), true);
    assert.ok(background instanceof Promise);
    release();
    assert.equal((await background).status, 'ready');
  } finally {
    for (const [name, value] of Object.entries({
      UPSTASH_REDIS_REST_URL: before.url,
      UPSTASH_REDIS_REST_TOKEN: before.token,
      RESULT_CONTEXT_SIGNING_SECRET: before.secret
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
