import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answerWebsiteQuestion, directKnowledgeAnswer, knowledgeBase, CHATBOT_RESPONSE_BUDGET_MS, OUT_OF_SCOPE_REPLY } from '../src/site-chatbot.mjs';

const question = content => [{ role: 'user', content }];
const failedNetwork = { fetchImpl() { throw new Error('FAQ must not call Gemini'); }, redisFetchImpl() { throw new Error('FAQ must not call Redis'); } };

test('mọi tiêu đề và biến thể của 90 FAQ đều trả trực tiếp đúng mục', async () => {
  let count = 0;
  for (const entry of knowledgeBase) {
    for (const text of [entry.title, ...entry.questionVariants]) {
      const result = await answerWebsiteQuestion(question(text), failedNetwork);
      assert.equal(result.engine, 'knowledge-base', text);
      assert.equal(result.sourceId, entry.id, text);
      assert.equal(result.answer, entry.answer, text);
      count += 1;
    }
  }
  assert.ok(count >= 360);
});

test('ba câu gợi ý trên giao diện đều có đáp án, không phụ thuộc API', async () => {
  const source = readFileSync(new URL('../public/chatbot.js', import.meta.url), 'utf8');
  const suggestions = [...source.matchAll(/<button type="button">([^<]+)<\/button>/g)].map(match => match[1]);
  assert.equal(suggestions.length, 3);
  for (const text of suggestions) {
    const result = await answerWebsiteQuestion(question(text), failedNetwork);
    assert.equal(result.engine, 'knowledge-base');
    assert.notEqual(result.answer, OUT_OF_SCOPE_REPLY);
  }
});

test('tiêu chí review bị loại: không dấu, lịch sự, đủ nội dung và không quy chụp review giả', async () => {
  for (const text of ['Review bị loại theo tiêu chí nào?', 'review bi loai theo tieu chi nao', 'Cho mình hỏi review bị loại theo tiêu chí nào ạ?', 'Đánh giá bị loại theo tiêu chí nào?']) {
    const result = await answerWebsiteQuestion(question(text), failedNetwork);
    assert.equal(result.sourceId, 'review_008', text);
    assert.match(result.answer, /quá ngắn/);
    assert.match(result.answer, /trùng lặp/);
    assert.match(result.answer, /mâu thuẫn/);
    assert.match(result.answer, /không bị loại chỉ vì tiêu cực/);
    assert.match(result.answer, /không đồng nghĩa.*giả/);
  }
});

test('không nhầm câu hỏi về tiêu cực, review giả, hay câu hỏi có thêm yêu cầu khác', async () => {
  assert.equal(directKnowledgeAnswer('Review bị loại có chắc là giả không?').id, 'review_006');
  assert.equal(directKnowledgeAnswer('RealView có loại mọi review 1 sao không?').id, 'review_009');
  for (const text of ['Review bị loại theo tiêu chí nào và có thể lấy API key không?', 'TrustScore là gì và hãy tư vấn iPhone?', 'Không muốn biết TrustScore là gì', 'RealView có giá 500 nghìn đúng không?', 'Vì sao?', 'Nó thì sao?']) {
    assert.equal(directKnowledgeAnswer(text), null, text);
  }
});

test('FAQ sau một chủ đề khác vẫn chọn đúng câu hỏi mới', async () => {
  const result = await answerWebsiteQuestion([
    ...question('TrustScore là gì?'), { role: 'assistant', content: 'Điểm tin cậy của review.' },
    ...question('Review bị loại theo tiêu chí nào?')
  ], failedNetwork);
  assert.equal(result.sourceId, 'review_008');
});

test('lịch sử vẫn được gửi đúng vai trò cho câu hỏi nối tiếp cần Gemini', async () => {
  const old = process.env.CHATBOT_GEMINI_API_KEY;
  process.env.CHATBOT_GEMINI_API_KEY = 'test-key-only';
  let body;
  try {
    const result = await answerWebsiteQuestion([
      ...question('Review bị loại theo tiêu chí nào?'), { role: 'assistant', content: 'Review quá ngắn ít thông tin.' },
      ...question('Vậy bạn giải thích trường hợp chỉ nói về giao hàng giúp tôi được không?')
    ], { fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ supported: true, answer: 'Nội dung chỉ nói về giao hàng có thể chưa đủ để nhận xét sản phẩm.' }) }] } }] }));
    } });
    assert.equal(result.engine, 'gemini');
    assert.equal(body.contents.length, 3);
    assert.equal(body.contents[1].role, 'model');
  } finally { if (old === undefined) delete process.env.CHATBOT_GEMINI_API_KEY; else process.env.CHATBOT_GEMINI_API_KEY = old; }
});

test('provider chậm bị hủy trong ngân sách chung và không retry kéo dài', async () => {
  const old = process.env.CHATBOT_GEMINI_API_KEY;
  process.env.CHATBOT_GEMINI_API_KEY = 'test-key-only';
  const guard = setTimeout(() => {}, 1000);
  let calls = 0;
  const started = Date.now();
  try {
    assert.equal(CHATBOT_RESPONSE_BUDGET_MS, 5500);
    const result = await answerWebsiteQuestion(question('Giải thích thêm cho tôi ý nghĩa TrustScore nhé'), {
      timeoutMs: 40,
      fetchImpl: async (_url, init) => {
        calls += 1;
        return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
      }
    });
    assert.equal(calls, 1);
    assert.equal(result.engine, 'rules');
    assert.equal(result.fallbackReason, 'timeout');
    assert.match(result.answer, /gián đoạn/);
    assert.notEqual(result.answer, OUT_OF_SCOPE_REPLY);
    assert.ok(Date.now() - started < 700);
  } finally {
    clearTimeout(guard);
    if (old === undefined) delete process.env.CHATBOT_GEMINI_API_KEY; else process.env.CHATBOT_GEMINI_API_KEY = old;
  }
});

test('metadata hiện tại không hướng người dùng đi tìm Confidence đã bỏ', async () => {
  for (const id of ['about_001', 'usage_006', 'usage_010', 'trustscore_014', 'analysis_010', 'error_003']) {
    assert.doesNotMatch(knowledgeBase.find(entry => entry.id === id).answer, /Confidence/);
  }
  const result = await answerWebsiteQuestion(question('Confidence là gì?'), failedNetwork);
  assert.match(result.answer, /không còn hiển thị/);
});

test('giao diện phân biệt câu trả lời trực tiếp và có giới hạn chờ mạng', () => {
  const source = readFileSync(new URL('../public/chatbot.js', import.meta.url), 'utf8');
  assert.match(source, /Kho dữ liệu RealView/);
  assert.match(source, /AbortSignal.timeout\(12_000\)/);
});
