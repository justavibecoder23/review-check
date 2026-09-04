import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { answerWebsiteQuestion, retrieveKnowledge, OUT_OF_SCOPE_REPLY } from '../src/site-chatbot.mjs';

const envNames = ['GEMINI_API_KEY', 'CHATBOT_GEMINI_API_KEY', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'GEMINI_API_KEY_VAULT_KEY'];
async function withEnv(values, run) {
  const before = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  for (const name of envNames) delete process.env[name];
  Object.assign(process.env, values);
  try { return await run(); }
  finally { for (const name of envNames) { if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name]; } }
}
const question = content => [{ role: 'user', content }];
const success = answer => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ supported: true, answer }) }] } }] }), { status: 200 });

test('câu gợi ý hoạt động chọn đúng quy trình, có dấu và không dấu', () => {
  for (const text of ['RealView hoạt động thế nào?', 'RealView hoạt động như thế nào?', 'realview hoat dong the nao', 'Cách dùng RealView?']) {
    assert.equal(retrieveKnowledge(text)[0].id, 'usage_001', text);
  }
});

test('không chọn câu trả lời chỉ vì trùng một từ chung', () => {
  assert.equal(retrieveKnowledge('Hoạt động núi lửa là gì?').length, 0);
});

test('khi không có key, câu hỏi quy trình không còn trả nhầm về rating', () => withEnv({}, async () => {
  const result = await answerWebsiteQuestion(question('RealView hoạt động thế nào?'), { fetchImpl: () => { throw new Error('Không được gọi mạng khi thiếu key'); } });
  assert.equal(result.engine, 'knowledge-base');
  assert.equal(result.sourceId, 'usage_001');
  assert.match(result.answer, /thu thập review công khai/);
  assert.doesNotMatch(result.answer, /^Không\. Rating/);
}));

test('key riêng chatbot được ưu tiên và không thay key/model của backend khác', () => withEnv({ GEMINI_API_KEY: 'analysis-test-key', CHATBOT_GEMINI_API_KEY: 'chatbot-test-key' }, async () => {
  const result = await answerWebsiteQuestion(question('Giải thích giúp tôi quy trình RealView thật dễ hiểu nhé'), {
    fetchImpl: async (url, init) => {
      assert.match(url, /gemini-3\.5-flash-lite:generateContent$/);
      assert.equal(init.headers['x-goog-api-key'], 'chatbot-test-key');
      assert.ok(!url.includes('chatbot-test-key'));
      return success('RealView thu thập và tổng hợp các review công khai.');
    }
  });
  assert.equal(result.engine, 'gemini');
  assert.equal(process.env.GEMINI_API_KEY, 'analysis-test-key');
  assert.doesNotMatch(JSON.stringify(result), /chatbot-test-key|analysis-test-key/);
}));

test('key chatbot lỗi thì chuyển đúng một lần sang key dự phòng trong pool', () => withEnv({
  CHATBOT_GEMINI_API_KEY: 'chatbot-primary-key',
  UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 'redis-test-token',
  GEMINI_API_KEY_VAULT_KEY: Buffer.alloc(32, 1).toString('base64')
}, async () => {
  const iv = Buffer.alloc(12, 9);
  const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 1), iv);
  const encrypted = Buffer.concat([cipher.update('chatbot-backup-key', 'utf8'), cipher.final()]);
  const credentials = [{
    id: 'backup-0', label: 'backup-0', iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), ciphertext: encrypted.toString('base64')
  }];
  const calls = [];
  const result = await answerWebsiteQuestion(question('Giải thích giúp tôi quy trình RealView thật dễ hiểu nhé'), {
    redisFetchImpl: async (url, init) => {
      const command = JSON.parse(init.body);
      if (url.endsWith('/multi-exec')) return new Response(JSON.stringify([{ result: JSON.stringify({ credentials }) }, { result: [] }]));
      if (command[0] === 'HMGET') return new Response(JSON.stringify({ result: command.slice(2).map(() => null) }));
      if (command[0] === 'EVAL') return new Response(JSON.stringify({ result: JSON.stringify({ ok: true, state: {} }) }));
      throw new Error('Unexpected Redis command');
    },
    fetchImpl: async (_url, init) => {
      const key = init.headers['x-goog-api-key'];
      calls.push(key);
      return key === 'chatbot-primary-key'
        ? new Response(JSON.stringify({ error: { message: 'temporary failure' } }), { status: 503 })
        : success('RealView thu thập và tổng hợp review công khai.');
    }
  });
  assert.deepEqual(calls, ['chatbot-primary-key', 'chatbot-backup-key']);
  assert.equal(result.engine, 'gemini');
  assert.doesNotMatch(JSON.stringify(result), /chatbot-(?:primary|backup)-key/);
}));

test('câu hỏi chủ đề mới không bị lịch sử rating lấn át', () => withEnv({ GEMINI_API_KEY: 'test-key' }, async () => {
  const messages = [...question('Rating cao có đồng nghĩa TrustScore cao không?'), { role: 'assistant', content: 'Hai chỉ số khác nhau.' }, ...question('Giải thích giúp tôi quy trình RealView thật dễ hiểu nhé')];
  const result = await answerWebsiteQuestion(messages, {
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.contents[1].role, 'model');
      assert.equal(body.contents.at(-1).parts[0].text, 'Giải thích giúp tôi quy trình RealView thật dễ hiểu nhé');
      assert.match(body.systemInstruction.parts[0].text, /\[usage_001\]/);
      assert.doesNotMatch(body.systemInstruction.parts[0].text, /\[trustscore_006\]/);
      return success('Bạn dán link, RealView thu thập và tổng hợp review.');
    }
  });
  assert.equal(result.engine, 'gemini');
}));

test('Gemini vẫn được đọc kho dữ liệu khi câu hỏi không khớp từ khóa', () => withEnv({ GEMINI_API_KEY: 'test-key' }, async () => {
  let calls = 0;
  const result = await answerWebsiteQuestion(question('Chào bạn!'), {
    fetchImpl: async (_url, init) => {
      calls += 1;
      assert.match(JSON.parse(init.body).systemInstruction.parts[0].text, /\[usage_001\]/);
      return success('Chào bạn, mình có thể hỗ trợ cách dùng RealView.');
    }
  });
  assert.equal(calls, 1);
  assert.equal(result.engine, 'gemini');
}));

test('Gemini có thể từ chối câu hỏi ngoài dữ liệu', () => withEnv({ GEMINI_API_KEY: 'test-key' }, async () => {
  const result = await answerWebsiteQuestion(question('Thời tiết hôm nay thế nào?'), {
    fetchImpl: async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"supported":false,"answer":""}' }] } }] }))
  });
  assert.equal(result.engine, 'gemini');
  assert.equal(result.answer, OUT_OF_SCOPE_REPLY);
}));

test('phân loại lỗi kết nối mà không trả khóa hoặc lỗi thô cho người dùng', () => withEnv({ GEMINI_API_KEY: 'private-test-key' }, async () => {
  for (const [status, expected] of [[403, 'authentication_failed'], [429, 'quota_exhausted'], [503, 'connection_failed']]) {
    const logs = [];
    const result = await answerWebsiteQuestion(question('Giải thích giúp tôi ý nghĩa TrustScore thật dễ hiểu nhé'), {
      logGeminiErrors: true, logger: { error: (...args) => logs.push(args) },
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'private-test-key provider detail' } }), { status })
    });
    assert.equal(result.engine, 'rules');
    assert.equal(result.fallbackReason, expected);
    assert.doesNotMatch(JSON.stringify({ result, logs }), /private-test-key|provider detail/);
  }
}));

test('câu hỏi mở vẫn dùng key trong pool với model Gemini hiện tại', () => withEnv({
  UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 'redis-test-token',
  GEMINI_API_KEY_VAULT_KEY: Buffer.alloc(32, 1).toString('base64')
}, async () => {
  const credentials = ['pool-key-one', 'pool-key-two'].map((key, index) => {
    const iv = Buffer.alloc(12, index + 1);
    const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 1), iv);
    const encrypted = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
    return { id: `pool-${index}`, label: `pool-${index}`, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: encrypted.toString('base64') };
  });
  const calls = [];
  const result = await answerWebsiteQuestion(question('Giải thích giúp tôi quy trình RealView thật dễ hiểu nhé'), {
    redisFetchImpl: async (url, init) => {
      const command = JSON.parse(init.body);
      if (url.endsWith('/multi-exec')) return new Response(JSON.stringify([{ result: JSON.stringify({ credentials }) }, { result: [] }]));
      if (command[0] === 'HMGET') return new Response(JSON.stringify({ result: [null, null] }));
      if (command[0] === 'EVAL') return new Response(JSON.stringify({ result: JSON.stringify({ ok: true, state: {} }) }));
      throw new Error('Unexpected Redis command');
    },
    fetchImpl: async (_url, init) => {
      calls.push(init.headers['x-goog-api-key']);
      return success('Bạn dán link sản phẩm, RealView sẽ tổng hợp review.');
    }
  });
  assert.deepEqual(calls, ['pool-key-one']);
  assert.equal(result.engine, 'gemini');
  assert.doesNotMatch(JSON.stringify(result), /pool-key/);
}));
