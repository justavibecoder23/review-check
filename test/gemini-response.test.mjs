import test from 'node:test';
import assert from 'node:assert/strict';
import { geminiThinkingConfig, requestGeminiWithFallback } from '../src/gemini-response.mjs';

function quotaResponse() {
  return {
    ok: false,
    status: 429,
    async json() {
      return { error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } };
    }
  };
}

test('Gemini tự chuyển 3.5 sang 3.6, 3.7 rồi 3.5 Flash-Lite khi từng model hết quota', async () => {
  const requestedModels = [];
  const { model, attemptedModels } = await requestGeminiWithFallback({
    apiKey: 'test-key',
    primaryModel: 'gemini-3.5-flash',
    fetchImpl: async (url) => {
      const requestedModel = decodeURIComponent(url).match(/models\/(.+):generateContent/)[1];
      requestedModels.push(requestedModel);
      return requestedModel === 'gemini-3.5-flash-lite' ? { ok: true } : quotaResponse();
    },
    buildRequest: () => ({ method: 'POST' })
  });
  assert.equal(model, 'gemini-3.5-flash-lite');
  assert.deepEqual(requestedModels, ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.5-flash-lite']);
  assert.deepEqual(attemptedModels, requestedModels);
});

test('Gemini 3.7 dùng thinking low còn các model khác giữ minimal', () => {
  assert.deepEqual(geminiThinkingConfig('minimal', 'gemini-3.7-flash'), { thinkingLevel: 'low' });
  assert.deepEqual(geminiThinkingConfig('minimal', 'gemini-3.5-flash-lite'), { thinkingLevel: 'minimal' });
});

test('Gemini không đổi model khi lỗi không phải hết quota', async () => {
  const requestedModels = [];
  await assert.rejects(() => requestGeminiWithFallback({
    apiKey: 'test-key',
    primaryModel: 'gemini-3.5-flash',
    fetchImpl: async (url) => {
      requestedModels.push(url);
      return {
        ok: false,
        status: 401,
        async json() { return { error: { status: 'UNAUTHENTICATED', message: 'Invalid key' } }; }
      };
    },
    buildRequest: () => ({ method: 'POST' })
  }), /HTTP 401/);
  assert.equal(requestedModels.length, 1);
});

test('Gemini dùng đủ bốn model trên một key rồi mới chuyển sang key tiếp theo', async () => {
  const credentials = [
    { id: 'key-1', apiKey: 'secret-1', exhaustedModels: [] },
    { id: 'key-2', apiKey: 'secret-2', exhaustedModels: [] }
  ];
  const marked = new Map();
  const requests = [];
  const result = await requestGeminiWithFallback({
    apiKey: 'bootstrap-key',
    reserveCredentialImpl: async () => {
      const credential = credentials.find((item) => (marked.get(item.id)?.size || 0) < 4);
      if (!credential) throw Object.assign(new Error('Hết pool'), { code: 'POOL_EXHAUSTED' });
      return { ...credential, exhaustedModels: [...(marked.get(credential.id) || [])] };
    },
    markModelExhaustedImpl: async (credential, model) => {
      if (!marked.has(credential.id)) marked.set(credential.id, new Set());
      marked.get(credential.id).add(model);
      return { used: marked.get(credential.id).size === 4 };
    },
    fetchImpl: async (url, init) => {
      const model = decodeURIComponent(url).match(/models\/(.+):generateContent/)[1];
      const key = init.headers['x-goog-api-key'];
      requests.push(`${key}:${model}`);
      if (key === 'secret-2' && model === 'gemini-3.5-flash') return { ok: true };
      return quotaResponse();
    },
    buildRequest: (_model, selectedApiKey) => ({ headers: { 'x-goog-api-key': selectedApiKey } })
  });
  assert.equal(result.credentialId, 'key-2');
  assert.deepEqual(requests, [
    'secret-1:gemini-3.5-flash',
    'secret-1:gemini-3.6-flash',
    'secret-1:gemini-3.7-flash',
    'secret-1:gemini-3.5-flash-lite',
    'secret-2:gemini-3.5-flash'
  ]);
});
