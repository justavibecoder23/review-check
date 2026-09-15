import test from 'node:test';
import assert from 'node:assert/strict';
import {
  counterpartJobId,
  createCounterpartJob,
  publicCounterpartJob,
  readCounterpartJob,
  resumeCounterpartJob
} from '../src/counterpart-job-store.mjs';

function redisFake() {
  const values = new Map();
  return {
    async fetchImpl(url, init) {
      const command = JSON.parse(init.body);
      let result = null;
      if (command[0] === 'GET') result = values.get(command[1]) ?? null;
      if (command[0] === 'SET') {
        const nx = command.includes('NX');
        if (nx && values.has(command[1])) result = null;
        else {
          values.set(command[1], command[2]);
          result = 'OK';
        }
      }
      if (command[0] === 'DEL') result = values.delete(command[1]) ? 1 : 0;
      return { ok: true, async json() { return { result }; } };
    }
  };
}

test('counterpart job được tạo một lần, lưu trạng thái và lần sau đọc lại kết quả', async () => {
  const names = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  const redis = redisFake();
  const source = {
    platform: 'Shopee', title: 'Ốp iPhone 15', itemId: '2',
    url: 'https://shopee.vn/product/1/2', image: 'https://down-vn.img.susercontent.com/file/example'
  };
  let searches = 0;
  try {
    const created = await createCounterpartJob(source, {
      redisFetchImpl: redis.fetchImpl,
      findCounterpartImpl: async (_source, options) => {
        searches += 1;
        await options.onStage('image_matching', { candidates: 3 });
        return { status: 'ready', targetPlatform: 'TikTok Shop', candidate: { url: 'https://shop.tiktok.com/view/product/3', matchClass: 'exact' } };
      }
    });
    assert.equal(created.job.status, 'queued');
    assert.ok(created.background);
    await created.background;
    const completed = await readCounterpartJob(created.job.id, { redisFetchImpl: redis.fetchImpl });
    assert.equal(completed.status, 'ready');
    assert.equal(publicCounterpartJob(completed).candidate.matchClass, 'exact');

    const repeated = await createCounterpartJob(source, { redisFetchImpl: redis.fetchImpl });
    assert.equal(repeated.job.status, 'ready');
    assert.equal(repeated.background, null);
    assert.equal(searches, 1);
    const resumed = await resumeCounterpartJob(created.job.id, { redisFetchImpl: redis.fetchImpl });
    assert.equal(resumed.background, null);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('job id đổi khi ảnh listing đổi nhưng không đổi chỉ vì title được rút gọn', () => {
  const source = {
    platform: 'TikTok Shop', title: 'Tên đầy đủ', productId: '9',
    url: 'https://shop.tiktok.com/view/product/9', image: 'https://p16-oec-sg.ibyteimg.com/a.webp'
  };
  assert.equal(counterpartJobId(source), counterpartJobId({ ...source, title: 'Tên rút gọn' }));
  assert.notEqual(counterpartJobId(source), counterpartJobId({ ...source, image: 'https://p16-oec-sg.ibyteimg.com/b.webp' }));
});
