import test from 'node:test';
import assert from 'node:assert/strict';
import { readLayer2Cache, writeLayer2Cache } from '../src/layer2-cache.mjs';

test('cache Layer 2 lưu theo nội dung và gắn lại ID của lần phân tích mới', async () => {
  const previousUrl = process.env.UPSTASH_REDIS_REST_URL;
  const previousToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  const values = new Map();
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith('/multi-exec')) {
      for (const command of body) values.set(command[1], command[2]);
      return { ok: true, async json() { return body.map(() => ({ result: 'OK' })); } };
    }
    return {
      ok: true,
      async json() { return { result: body.slice(1).map((key) => values.get(key) || null) }; }
    };
  };
  const original = [{
    review: { rating: 5, text: 'Êm chân và dễ điều chỉnh', verified: true },
    layer1: { id: 'r0001' }
  }];
  const label = { id: 'r0001', decision: 'confirm', relevance: 'on_topic' };
  try {
    await writeLayer2Cache(original, [label], { title: 'Miếng lót giày' }, { fetchImpl });
    const next = [{ ...original[0], layer1: { id: 'r0042' } }];
    const cached = await readLayer2Cache(next, { title: 'Miếng lót giày' }, { fetchImpl });
    assert.deepEqual(cached.get('r0042'), { ...label, id: 'r0042' });
  } finally {
    if (previousUrl) process.env.UPSTASH_REDIS_REST_URL = previousUrl;
    else delete process.env.UPSTASH_REDIS_REST_URL;
    if (previousToken) process.env.UPSTASH_REDIS_REST_TOKEN = previousToken;
    else delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
});
