import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGeminiPoolFile, normalizeGeminiApiKeys } from '../src/gemini-pool-file.mjs';

test('Gemini pool nhận mọi số lượng key và tự bỏ key trùng', () => {
  const pool = buildGeminiPoolFile([' key-one ', 'key-two', 'key-one'], { mode: 'append' });
  assert.equal(pool.mode, 'append');
  assert.deepEqual(pool.credentials.map((item) => item.apiKey), ['key-one', 'key-two']);
});

test('normalize Gemini key bỏ dòng trống', () => {
  assert.deepEqual(normalizeGeminiApiKeys([' key-one ', '', '  ', 'key-two']), ['key-one', 'key-two']);
});
