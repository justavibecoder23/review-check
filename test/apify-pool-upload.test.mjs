import test from 'node:test';
import assert from 'node:assert/strict';

import { uploadApifyPool } from '../src/apify-pool-upload.mjs';

test('push pool lên API bằng PUT và Bearer admin key', async () => {
  let request;
  const payload = { mode: 'append', maxUsesPerKey: 10, groups: [], pendingCredentials: [{ token: 'secret' }] };
  const pool = await uploadApifyPool(payload, {
    endpoint: 'https://example.test/api/apify-config',
    adminKey: 'admin-secret',
    fetchImpl: async (url, init) => {
      request = { url, init };
      return {
        ok: true,
        async json() { return { updated: true, pool: { totals: { groups: 2 } } }; }
      };
    }
  });
  assert.equal(request.url, 'https://example.test/api/apify-config');
  assert.equal(request.init.method, 'PUT');
  assert.equal(request.init.headers.authorization, 'Bearer admin-secret');
  assert.deepEqual(JSON.parse(request.init.body), payload);
  assert.equal(pool.totals.groups, 2);
});

test('không coi là thành công nếu API từ chối admin key', async () => {
  await assert.rejects(() => uploadApifyPool({ mode: 'replace' }, {
    endpoint: 'https://example.test/api/apify-config',
    adminKey: 'wrong',
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      async json() { return { error: 'Không có quyền quản trị cấu hình Apify.' }; }
    })
  }), /Không có quyền/);
});
