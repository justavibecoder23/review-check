import test from 'node:test';
import assert from 'node:assert/strict';
import { GEMINI_ATTEMPT_TIMEOUT_MS, geminiThinkingConfig, requestGeminiWithFallback } from '../src/gemini-response.mjs';

function quotaResponse() {
  return {
    ok: false,
    status: 429,
    async json() {
      return { error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } };
    }
  };
}

test('Gemini dừng sau tối đa hai retry dù chuỗi còn model khác', async () => {
  const requestedModels = [];
  await assert.rejects(() => requestGeminiWithFallback({
    apiKey: 'test-key',
    primaryModel: 'gemini-3.5-flash',
    fetchImpl: async (url) => {
      const requestedModel = decodeURIComponent(url).match(/models\/(.+):generateContent/)[1];
      requestedModels.push(requestedModel);
      return quotaResponse();
    },
    buildRequest: () => ({ method: 'POST' })
  }), /HTTP 429/);
  assert.deepEqual(requestedModels, ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash']);
});

test('Gemini 3.7 dùng thinking low còn các model khác giữ minimal', () => {
  assert.equal(GEMINI_ATTEMPT_TIMEOUT_MS, 10_000);
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

test('Gemini retry model khác một lần rồi dùng API key dự phòng ở retry cuối', async () => {
  const credentials = [
    { id: 'key-1', apiKey: 'secret-1', exhaustedModels: [] },
    { id: 'key-2', apiKey: 'secret-2', exhaustedModels: [] }
  ];
  const requests = [];
  const result = await requestGeminiWithFallback({
    apiKey: 'bootstrap-key',
    listCredentialsImpl: async () => credentials,
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
    'secret-2:gemini-3.5-flash'
  ]);
  assert.equal(result.attempts, 3);
});

test('Gemini timeout thì retry model khác rồi chuyển sang API key dự phòng', async () => {
  const credentials = [
    { id: 'key-1', apiKey: 'secret-1', exhaustedModels: [] },
    { id: 'key-2', apiKey: 'secret-2', exhaustedModels: [] }
  ];
  const requests = [];
  const result = await requestGeminiWithFallback({
    primaryModel: 'gemini-3.5-flash',
    listCredentialsImpl: async () => credentials,
    fetchImpl: async (url, init) => {
      const model = decodeURIComponent(url).match(/models\/(.+):generateContent/)[1];
      const key = init.headers['x-goog-api-key'];
      requests.push(`${key}:${model}`);
      if (key === 'secret-2') return { ok: true };
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'AbortError' });
    },
    buildRequest: (_model, selectedApiKey) => ({ headers: { 'x-goog-api-key': selectedApiKey } })
  });
  assert.equal(result.credentialId, 'key-2');
  assert.deepEqual(requests, [
    'secret-1:gemini-3.5-flash',
    'secret-1:gemini-3.6-flash',
    'secret-2:gemini-3.5-flash'
  ]);
  assert.deepEqual(result.attemptedCredentialIds, ['key-1', 'key-2']);
});

test('timeout được áp cho từng attempt và vẫn dừng ở hai retry', async () => {
  let calls = 0;
  const startedAt = Date.now();
  await assert.rejects(() => requestGeminiWithFallback({
    apiKey: 'test-key',
    attemptTimeoutMs: 20,
    fetchImpl: async (_url, init) => {
      calls += 1;
      await new Promise((resolve, reject) => {
        const guard = setTimeout(resolve, 1_000);
        init.signal.addEventListener('abort', () => {
          clearTimeout(guard);
          reject(init.signal.reason);
        }, { once: true });
      });
    },
    buildRequest: () => ({ method: 'POST' })
  }), /tạm thời không phản hồi/);
  assert.equal(calls, 3);
  assert.ok(Date.now() - startedAt < 500);
});
