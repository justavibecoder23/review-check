import test from 'node:test';
import assert from 'node:assert/strict';

import { buildApifyPoolFile, normalizeApifyTokens } from '../src/apify-pool-file.mjs';

test('tự chia danh sách key thành nhiều nhóm 5★ đến 1★', () => {
  const tokens = Array.from({ length: 15 }, (_, index) => `apify-key-${index + 1}`);
  const pool = buildApifyPoolFile(tokens);
  assert.equal(pool.mode, 'replace');
  assert.equal(pool.maxUsesPerKey, 10);
  assert.equal(pool.groups.length, 3);
  assert.equal(pool.groups[0].label, 'group-01');
  assert.deepEqual(pool.groups[0].credentials.map((item) => item.star), [5, 4, 3, 2, 1]);
  assert.equal(pool.groups[2].credentials[4].token, 'apify-key-15');
});

test('loại dòng trống và khoảng trắng quanh key', () => {
  assert.deepEqual(normalizeApifyTokens([' key-1 ', '', '  ', 'key-2']), ['key-1', 'key-2']);
});

test('từ chối số lượng key không chia hết cho 5', () => {
  assert.throws(() => buildApifyPoolFile(['1', '2', '3']), /chia hết cho 5/);
});

test('từ chối API key trùng', () => {
  assert.throws(() => buildApifyPoolFile(['same', '2', '3', '4', 'same']), /bị trùng/);
});
