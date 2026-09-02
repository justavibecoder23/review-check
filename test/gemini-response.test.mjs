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

test('Layer 2 không retry nối tiếp sau timeout và khóa route lỗi cho bước diễn giải', async () => {
  const credentials = [{ id: 'key-1', apiKey: 'secret-1', exhaustedModels: [] }];
  const routeContext = { busyRouteIds: new Set(), failedRouteIds: new Set() };
  const attempted = [];
  await assert.rejects(() => requestGeminiWithFallback({
    listCredentialsImpl: async () => credentials,
    retryOnTimeout: false,
    routeContext,
    fetchImpl: async (url) => {
      attempted.push(decodeURIComponent(url).match(/models\/(.+):generateContent/)[1]);
      throw Object.assign(new Error('timeout'), { name: 'AbortError' });
    },
    buildRequest: () => ({ method: 'POST' })
  }), /timeout/);
  assert.deepEqual(attempted, ['gemini-3.5-flash']);
  assert.ok(routeContext.failedRouteIds.has('key-1:gemini-3.5-flash'));

  const result = await requestGeminiWithFallback({
    listCredentialsImpl: async () => credentials,
    maxRetries: 0,
    routeContext,
    fetchImpl: async () => ({ ok: true, status: 200 }),
    buildRequest: () => ({ method: 'POST' })
  });
  assert.equal(result.model, 'gemini-3.6-flash');
});

test('các batch song song trong cùng pipeline được phân sang route khác nhau', async () => {
  const credentials = [{ id: 'key-1', apiKey: 'secret-1', exhaustedModels: [] }];
  const routeContext = { busyRouteIds: new Set(), failedRouteIds: new Set() };
  const requestedModels = [];
  const makeRequest = () => requestGeminiWithFallback({
    listCredentialsImpl: async () => credentials,
    getHealthSnapshotImpl: async () => ({}),
    beginRouteImpl: async () => new Promise((resolve) => setTimeout(resolve, 5)),
    finishRouteImpl: async () => ({}),
    maxRetries: 0,
    routeContext,
    fetchImpl: async (url) => {
      requestedModels.push(decodeURIComponent(url).match(/models\/(.+):generateContent/)[1]);
      return { ok: true, status: 200 };
    },
    buildRequest: () => ({ method: 'POST' })
  });
  await Promise.all([makeRequest(), makeRequest()]);
  assert.deepEqual(new Set(requestedModels), new Set(['gemini-3.5-flash', 'gemini-3.6-flash']));
});

test('deadline chung rút ngắn attempt thay vì cho mỗi tầng thêm 10 giây', async () => {
  let calls = 0;
  const startedAt = Date.now();
  await assert.rejects(() => requestGeminiWithFallback({
    apiKey: 'test-key',
    deadlineAt: Date.now() + 30,
    attemptTimeoutMs: 1_000,
    retryOnTimeout: false,
    fetchImpl: async (_url, init) => {
      calls += 1;
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(resolve, 500);
        init.signal.addEventListener('abort', () => {
          clearTimeout(timeout);
          reject(Object.assign(new Error('timeout'), { name: 'AbortError' }));
        });
      });
    },
    buildRequest: () => ({ method: 'POST' })
  }), /timeout/);
  assert.equal(calls, 1);
  assert.ok(Date.now() - startedAt < 100);
});
