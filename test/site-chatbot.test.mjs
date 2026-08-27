import test from 'node:test';
import assert from 'node:assert/strict';
import {
  answerWebsiteQuestion,
  knowledgeBase,
  OUT_OF_SCOPE_REPLY,
  retrieveKnowledge,
  siteKnowledge
} from '../src/site-chatbot.mjs';

test('kho kiến thức chứa các nội dung cốt lõi của website', () => {
  assert.equal(knowledgeBase.length, 90);
  assert.equal(new Set(knowledgeBase.map((entry) => entry.id)).size, 90);
  assert.match(siteKnowledge, /TrustScore/);
  assert.match(siteKnowledge, /Shopee/);
  assert.match(siteKnowledge, /reviewcheckteam@gmail\.com/);
  assert.match(siteKnowledge, /không kết luận một review là giả hoặc thật/i);
  assert.match(siteKnowledge, /không lưu trữ liên kết sản phẩm hoặc dữ liệu cá nhân/i);
});

test('bộ tìm kiếm chọn đúng dữ liệu liên quan và ưu tiên thông tin website hiện tại', () => {
  const trustScoreMatches = retrieveKnowledge('Vì sao TrustScore của sản phẩm có thể thấp?');
  assert.equal(trustScoreMatches[0].id, 'trustscore_008');

  const platformMatches = retrieveKnowledge('RealView hỗ trợ nền tảng nào?');
  assert.equal(platformMatches[0].id, 'about_003');
  assert.match(platformMatches[0].answer, /chỉ hỗ trợ liên kết sản phẩm Shopee/i);
  assert.match(platformMatches[0].answer, /chưa hỗ trợ TikTok Shop/i);
});

test('chatbot dùng Gemini ở backend và chấp nhận câu hỏi thuộc phạm vi', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-only-key';
  let receivedKey;
  try {
    const result = await answerWebsiteQuestion([{ role: 'user', content: 'TrustScore là gì?' }], {
      fetchImpl: async (_url, options) => {
        receivedKey = options.headers['x-goog-api-key'];
        return {
          ok: true,
          async json() {
            return { candidates: [{ content: { parts: [{ text: JSON.stringify({ supported: true, answer: 'TrustScore là điểm trên thang 100.' }) }] } }] };
          }
        };
      }
    });
    assert.equal(receivedKey, 'test-only-key');
    assert.equal(result.engine, 'gemini');
    assert.equal(result.answer, 'TrustScore là điểm trên thang 100.');
  } finally {
    if (previousKey) process.env.GEMINI_API_KEY = previousKey;
    else delete process.env.GEMINI_API_KEY;
  }
});

test('chatbot từ chối câu hỏi ngoài kho kiến thức', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-only-key';
  try {
    const result = await answerWebsiteQuestion([{ role: 'user', content: 'Nên mua điện thoại nào?' }], {
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return { candidates: [{ content: { parts: [{ text: JSON.stringify({ supported: false, answer: 'Không hỗ trợ.' }) }] } }] };
        }
      })
    });
    assert.equal(result.answer, OUT_OF_SCOPE_REPLY);
  } finally {
    if (previousKey) process.env.GEMINI_API_KEY = previousKey;
    else delete process.env.GEMINI_API_KEY;
  }
});

test('chatbot quy tắc không tư vấn sản phẩm khi Gemini chưa được cấu hình', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const result = await answerWebsiteQuestion([{ role: 'user', content: 'Nên mua điện thoại nào?' }]);
    assert.equal(result.engine, 'rules');
    assert.equal(result.answer, OUT_OF_SCOPE_REPLY);
  } finally {
    if (previousKey) process.env.GEMINI_API_KEY = previousKey;
  }
});

test('chatbot có câu trả lời dự phòng khi Gemini chưa được cấu hình', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const result = await answerWebsiteQuestion([{ role: 'user', content: 'Cách dùng RealView?' }]);
    assert.equal(result.engine, 'rules');
    assert.match(result.answer, /dán liên kết sản phẩm Shopee/i);
    assert.match(result.answer, /15–45 giây/);
  } finally {
    if (previousKey) process.env.GEMINI_API_KEY = previousKey;
  }
});

