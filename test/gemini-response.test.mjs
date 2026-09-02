import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GEMINI_ATTEMPT_TIMEOUT_MS,
  GEMINI_MODEL,
  geminiHttpError,
  geminiModelChain,
  geminiThinkingConfig,
  requestGeminiWithFallback
} from '../src/gemini-response.mjs';

function response(status, error = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return status >= 400 ? { error } : {}; }
  };
}

function credentials(count = 3) {
  return Array.from({ length: count }, (_, index) => ({
    id: `key-${index + 1}`,
    apiKey: `secret-${index + 1}`,
    exhaustedModels: []
  }));
}

function selectedKey(init) {
  return init.headers['x-goog-api-key'];
}

function pacificDay(nowMs = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(nowMs));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

test('router chỉ sử dụng Gemini 3.5 Flash Lite dù đầu vào yêu cầu model khác', async () => {
  assert.deepEqual(geminiModelChain('gemini-3.5-flash', 'gemini-3.6-flash'), [GEMINI_MODEL]);
  const models = [];
  await assert.rejects(() => requestGeminiWithFallback({
    listCredentialsImpl: async () => credentials(),
    fetchImpl: async (url) => {
      models.push(decodeURIComponent(url).match(/models\/(.+):generateContent/)[1]);
      return response(429, { status: 'RESOURCE_EXHAUSTED', message: 'minute quota' });
    },
    buildRequest: () => ({ method: 'POST' })
  }), /HTTP 429/);
  assert.deepEqual(models, [GEMINI_MODEL, GEMINI_MODEL, GEMINI_MODEL]);
});

test('Flash Lite dùng thinking minimal và timeout mỗi attempt tối đa 10 giây', () => {
  assert.equal(GEMINI_ATTEMPT_TIMEOUT_MS, 10_000);
  assert.deepEqual(geminiThinkingConfig('minimal', GEMINI_MODEL), { thinkingLevel: 'minimal' });
});

test('nhận diện quota ngày cả khi Gemini chỉ ghi trong error message', async () => {
  const error = await geminiHttpError(response(429, {
    status: 'RESOURCE_EXHAUSTED',
    message: 'Quota exceeded for requests per day'
  }));
  assert.equal(error.quotaExhausted, true);
  assert.equal(error.quotaScope, 'day');
});

test('mọi lỗi của key đầu tiên chuyển ngay sang key khác', async () => {
  const requests = [];
  const result = await requestGeminiWithFallback({
    listCredentialsImpl: async () => credentials(2),
    markModelExhaustedImpl: async () => {},
    fetchImpl: async (_url, init) => {
      requests.push(selectedKey(init));
      return selectedKey(init) === 'secret-2'
        ? response(200)
        : response(401, { status: 'UNAUTHENTICATED', message: 'Invalid key' });
    },
    buildRequest: (_model, apiKey) => ({ headers: { 'x-goog-api-key': apiKey } })
  });
  assert.equal(result.credentialId, 'key-2');
  assert.deepEqual(requests, ['secret-1', 'secret-2']);
});

test('HTTP 200 có JSON sai schema phải retry bằng key khác và không ghi success giả', async () => {
  const requests = [];
  const finishes = [];
  const result = await requestGeminiWithFallback({
    listCredentialsImpl: async () => credentials(2),
    fetchImpl: async (_url, init) => {
      requests.push(selectedKey(init));
      return {
        ok: true,
        status: 200,
        async json() { return { valid: selectedKey(init) === 'secret-2' }; }
      };
    },
    finishRouteImpl: async (_routeId, outcome) => {
      finishes.push(outcome);
      return {};
    },
    validateResponse: async (candidate) => {
      const body = await candidate.json();
      if (!body.valid) throw new Error('sai schema');
      return body;
    },
    buildRequest: (_model, apiKey) => ({ headers: { 'x-goog-api-key': apiKey } })
  });
  assert.equal(result.credentialId, 'key-2');
  assert.deepEqual(result.value, { valid: true });
  assert.deepEqual(requests, ['secret-1', 'secret-2']);
  assert.deepEqual(finishes.map((item) => item.ok), [false, true]);
});

test('reservation nguyên tử từ chối route quá tải trước khi gọi Gemini', async () => {
  const requests = [];
  const result = await requestGeminiWithFallback({
    listCredentialsImpl: async () => credentials(2),
    beginRouteImpl: async (routeId) => routeId.startsWith('key-1:')
      ? { ok: false, code: 'RPM_LIMIT', state: {} }
      : { ok: true, state: {} },
    fetchImpl: async (_url, init) => {
      requests.push(selectedKey(init));
      return response(200);
    },
    buildRequest: (_model, apiKey) => ({ headers: { 'x-goog-api-key': apiKey } })
  });
  assert.equal(result.credentialId, 'key-2');
  assert.deepEqual(requests, ['secret-2']);
});

test('ưu tiên API key có bộ đếm ngày thấp nhất', async () => {
  const result = await requestGeminiWithFallback({
    listCredentialsImpl: async () => credentials(),
    getHealthSnapshotImpl: async () => ({
      [`key-1:${GEMINI_MODEL}`]: { day: pacificDay(), dayRequests: 20 },
      [`key-2:${GEMINI_MODEL}`]: { day: pacificDay(), dayRequests: 3 },
      [`key-3:${GEMINI_MODEL}`]: { day: pacificDay(), dayRequests: 7 }
    }),
    fetchImpl: async () => response(200),
    buildRequest: () => ({ method: 'POST' })
  });
  assert.equal(result.credentialId, 'key-2');
});

test('timeout chuyển ngay sang Flash Lite của key dự phòng', async () => {
  const requests = [];
  const result = await requestGeminiWithFallback({
    listCredentialsImpl: async () => credentials(2),
    fetchImpl: async (_url, init) => {
      requests.push(selectedKey(init));
      if (selectedKey(init) === 'secret-2') return response(200);
      throw Object.assign(new Error('timeout'), { name: 'AbortError' });
    },
    buildRequest: (_model, apiKey) => ({ headers: { 'x-goog-api-key': apiKey } })
  });
  assert.deepEqual(requests, ['secret-1', 'secret-2']);
  assert.deepEqual(result.attemptedModels, [GEMINI_MODEL, GEMINI_MODEL]);
});

test('client hủy request thì dừng ngay và không tiêu hao key dự phòng', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(() => requestGeminiWithFallback({
    listCredentialsImpl: async () => credentials(3),
    fetchImpl: async () => {
      calls += 1;
      controller.abort();
      throw Object.assign(new Error('client disconnected'), { name: 'AbortError' });
    },
    buildRequest: () => ({ signal: controller.signal })
  }), /client disconnected|không phản hồi/);
  assert.equal(calls, 1);
});

test('dừng ở lần đầu cộng tối đa hai retry trên ba API key khác nhau', async () => {
  let calls = 0;
  const startedAt = Date.now();
  await assert.rejects(() => requestGeminiWithFallback({
    listCredentialsImpl: async () => credentials(4),
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
  }), /không phản hồi/);
  assert.equal(calls, 3);
  assert.ok(Date.now() - startedAt < 500);
});

test('route pending không được gọi và router chọn key khỏe tiếp theo', async () => {
  const nowMs = Date.now();
  const requests = [];
  const result = await requestGeminiWithFallback({
    listCredentialsImpl: async () => credentials(2),
    getHealthSnapshotImpl: async () => ({
      [`key-1:${GEMINI_MODEL}`]: { cooldownUntilMs: nowMs + 60_000 },
      [`key-2:${GEMINI_MODEL}`]: { day: pacificDay(nowMs), dayRequests: 8 }
    }),
    fetchImpl: async (_url, init) => {
      requests.push(selectedKey(init));
      return response(200);
    },
    buildRequest: (_model, apiKey) => ({ headers: { 'x-goog-api-key': apiKey } })
  });
  assert.equal(result.credentialId, 'key-2');
  assert.deepEqual(requests, ['secret-2']);
});

test('chạm RPD 500 đưa key vào used và bỏ qua key đó', async () => {
  const marked = [];
  const result = await requestGeminiWithFallback({
    listCredentialsImpl: async () => credentials(2),
    getHealthSnapshotImpl: async () => ({
      [`key-1:${GEMINI_MODEL}`]: { day: pacificDay(), dayRequests: 500 },
      [`key-2:${GEMINI_MODEL}`]: { day: pacificDay(), dayRequests: 12 }
    }),
    markModelExhaustedImpl: async (credential, model) => marked.push(`${credential.id}:${model}`),
    fetchImpl: async () => response(200),
    buildRequest: () => ({ method: 'POST' })
  });
  assert.equal(result.credentialId, 'key-2');
  assert.deepEqual(marked, [`key-1:${GEMINI_MODEL}`]);
});

test('các batch song song trong cùng pipeline dùng các key khác nhau', async () => {
  const routeContext = { busyRouteIds: new Set(), failedRouteIds: new Set() };
  const keys = [];
  const makeRequest = () => requestGeminiWithFallback({
    listCredentialsImpl: async () => credentials(2),
    getHealthSnapshotImpl: async () => ({}),
    beginRouteImpl: async () => new Promise((resolve) => setTimeout(resolve, 5)),
    finishRouteImpl: async () => ({}),
    maxRetries: 0,
    routeContext,
    fetchImpl: async (_url, init) => {
      keys.push(selectedKey(init));
      return response(200);
    },
    buildRequest: (_model, apiKey) => ({ headers: { 'x-goog-api-key': apiKey } })
  });
  await Promise.all([makeRequest(), makeRequest()]);
  assert.deepEqual(new Set(keys), new Set(['secret-1', 'secret-2']));
});

test('deadline chung rút ngắn attempt thay vì cộng thêm thời gian retry', async () => {
  let calls = 0;
  const startedAt = Date.now();
  await assert.rejects(() => requestGeminiWithFallback({
    listCredentialsImpl: async () => credentials(),
    deadlineAt: Date.now() + 30,
    attemptTimeoutMs: 1_000,
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
  }), /timeout|ngân sách thời gian/);
  assert.ok(calls <= 2);
  assert.ok(Date.now() - startedAt < 100);
});
