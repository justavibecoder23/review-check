import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeApiPath } from '../src/server-route.mjs';

test('server nhận đúng API path sau hai lớp Vercel rewrite', () => {
  assert.equal(normalizeApiPath('/public/api/analyze-stream.mjs'), '/api/analyze-stream');
  assert.equal(normalizeApiPath('/public/api/analyze.mjs'), '/api/analyze');
  assert.equal(normalizeApiPath('/public/api/chat'), '/api/chat');
});

test('server vẫn nhận API path sạch khi chạy local', () => {
  assert.equal(normalizeApiPath('/api/analyze-stream'), '/api/analyze-stream');
});

test('Vercel dùng các serverless handler riêng thay vì root custom server', async () => {
  const root = new URL('../', import.meta.url);
  const config = JSON.parse(await readFile(new URL('vercel.json', root), 'utf8'));
  const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(config.framework, null);
  assert.equal(packageJson.scripts.start, undefined);
  assert.equal(config.functions['api/analyze-stream.mjs'].maxDuration, 180);
  assert.equal(config.functions['api/chat.mjs'].maxDuration, 30);
  assert.equal(typeof (await import('../api/chat.mjs')).default, 'function');
});
