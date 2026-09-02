import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeApiPath } from '../src/server-route.mjs';

test('server nhận đúng API path sau hai lớp Vercel rewrite', () => {
  assert.equal(normalizeApiPath('/public/api/analyze-stream.mjs'), '/api/analyze-stream');
  assert.equal(normalizeApiPath('/public/api/analyze.mjs'), '/api/analyze');
  assert.equal(normalizeApiPath('/public/api/chat'), '/api/chat');
});

test('server vẫn nhận API path sạch khi chạy local', () => {
  assert.equal(normalizeApiPath('/api/analyze-stream'), '/api/analyze-stream');
});
