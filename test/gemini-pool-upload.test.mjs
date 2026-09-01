import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadGeminiPool } from '../src/gemini-pool-upload.mjs';

test('push Gemini pool lên API quản trị bằng PUT', async () => {
  let request;
  const payload = { mode: 'append', credentials: [{ label: 'key-01', apiKey: 'secret' }] };
  const pool = await uploadGeminiPool(payload, {
    endpoint: 'https://example.test/api/gemini-config',
    adminKey: 'admin-secret',
    fetchImpl: async (url, init) => {
      request = { url, init };
      return { ok: true, async json() { return { updated: true, pool: { totals: { credentials: 2 } } }; } };
    }
  });
  assert.equal(request.url, 'https://example.test/api/gemini-config');
  assert.equal(request.init.headers.authorization, 'Bearer admin-secret');
  assert.deepEqual(JSON.parse(request.init.body), payload);
  assert.equal(pool.totals.credentials, 2);
});
