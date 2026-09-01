import test from 'node:test';
import assert from 'node:assert/strict';
import { requestGeminiWithFallback } from '../src/gemini-response.mjs';

function quotaResponse() {
  return {
    ok: false,
    status: 429,
    async json() {
      return { error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } };
    }
  };
}

test('Gemini tự chuyển 3.5 sang 3.6 rồi 3.7 khi từng model hết quota', async () => {
  const requestedModels = [];
  const { model, attemptedModels } = await requestGeminiWithFallback({
    primaryModel: 'gemini-3.5-flash',
    fetchImpl: async (url) => {
      const requestedModel = decodeURIComponent(url).match(/models\/(.+):generateContent/)[1];
      requestedModels.push(requestedModel);
      return requestedModel === 'gemini-3.7-flash' ? { ok: true } : quotaResponse();
    },
    buildRequest: () => ({ method: 'POST' })
  });
  assert.equal(model, 'gemini-3.7-flash');
  assert.deepEqual(requestedModels, ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash']);
  assert.deepEqual(attemptedModels, requestedModels);
});

test('Gemini không đổi model khi lỗi không phải hết quota', async () => {
  const requestedModels = [];
  await assert.rejects(() => requestGeminiWithFallback({
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
