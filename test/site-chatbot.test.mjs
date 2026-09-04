import test from 'node:test';
import assert from 'node:assert/strict';
import {
  answerWebsiteQuestion,
  CHATBOT_GEMINI_MODEL,
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
  assert.match(platformMatches[0].answer, /Shopee và TikTok Shop/i);
  assert.doesNotMatch(siteKnowledge, /chưa hỗ trợ TikTok Shop/i);
});

test('chatbot dùng Gemini ở backend và chấp nhận câu hỏi thuộc phạm vi', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-only-key';
  let receivedKey;
  let requestPayload;
  let receivedUrl;
  try {
    const result = await answerWebsiteQuestion([{ role: 'user', content: 'Giải thích giúp tôi ý nghĩa TrustScore thật dễ hiểu nhé' }], {
      fetchImpl: async (_url, options) => {
        receivedUrl = _url;
        receivedKey = options.headers['x-goog-api-key'];
        requestPayload = JSON.parse(options.body);
        return {
          ok: true,
          async json() {
            return { candidates: [{ content: { parts: [{ text: JSON.stringify({ supported: true, answer: 'TrustScore là điểm trên thang 100.' }) }] } }] };
          }
        };
      }
    });
    assert.equal(receivedKey, 'test-only-key');
    assert.match(receivedUrl, /models\/gemini-3\.5-flash-lite:generateContent$/);
    assert.equal(result.model, CHATBOT_GEMINI_MODEL);
    assert.match(requestPayload.systemInstruction.parts[0].text, /Chỉ được dùng/);
    assert.equal(requestPayload.contents.at(-1).parts[0].text, 'Giải thích giúp tôi ý nghĩa TrustScore thật dễ hiểu nhé');
    assert.equal(requestPayload.generationConfig.temperature, undefined);
    assert.equal(requestPayload.generationConfig.thinkingConfig.thinkingLevel, 'minimal');
    assert.ok(requestPayload.generationConfig.maxOutputTokens >= 1024);
    assert.equal(result.engine, 'gemini');
    assert.equal(result.answer, 'TrustScore là điểm trên thang 100.');
  } finally {
    if (previousKey) process.env.GEMINI_API_KEY = previousKey;
    else delete process.env.GEMINI_API_KEY;
  }
});

test('chatbot log lỗi Gemini an toàn rồi fallback khi response bị cắt', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-only-key';
  const logged = [];
  try {
    const result = await answerWebsiteQuestion([{ role: 'user', content: 'Giải thích giúp tôi ý nghĩa TrustScore thật dễ hiểu nhé' }], {
      logGeminiErrors: true,
      logger: { error: (...args) => logged.push(args) },
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] };
        }
      })
    });
    assert.equal(result.engine, 'rules');
    assert.equal(logged.length, 1);
    assert.equal(logged[0][1].reason, 'invalid_response');
    assert.equal(result.fallbackReason, 'invalid_response');
    assert.doesNotMatch(JSON.stringify(logged), /test-only-key/);
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

test('FAQ trả lời trực tiếp ngay cả khi Gemini chưa được cấu hình', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const result = await answerWebsiteQuestion([{ role: 'user', content: 'Cách dùng RealView?' }]);
    assert.equal(result.engine, 'knowledge-base');
    assert.match(result.answer, /dán liên kết sản phẩm Shopee/i);
    assert.match(result.answer, /TikTok Shop/);
    assert.equal(result.sourceId, 'usage_001');
  } finally {
    if (previousKey) process.env.GEMINI_API_KEY = previousKey;
  }
});
