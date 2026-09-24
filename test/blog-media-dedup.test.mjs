import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { saveBlogMedia } from '../src/blog-media-store.mjs';
import {
  MEDIA_SCRIPTS, acquireMedia, finalizeMedia, mediaKeys, releaseMedia,
  renewMedia
} from '../src/blog-media-dedup.mjs';
import { reportBlogMediaOrphans } from '../tools/report-blog-media-orphans.mjs';

function memoryRedis() {
  const values = new Map();
  const expires = new Map();
  const events = [];
  let failFinalResponse = false;
  function current(key) {
    if (expires.has(key) && expires.get(key) <= Date.now()) {
      values.delete(key); expires.delete(key);
    }
    return values.get(key) ?? null;
  }
  async function command(parts) {
    const [name, ...args] = parts;
    if (name === 'GET') return current(args[0]);
    if (name !== 'EVAL') throw new Error(`unexpected ${name}`);
    const [script, count, ...rest] = args;
    const keys = rest.slice(0, Number(count));
    const argv = rest.slice(Number(count));
    if (script === MEDIA_SCRIPTS.audit) { events.push(JSON.parse(argv[0])); return events.length; }
    if (script === MEDIA_SCRIPTS.acquire) {
      if (current(keys[0])) return ['READY'];
      if (current(keys[1])) return ['BUSY'];
      const fence = String(Number(current(keys[2]) || 0) + 1);
      values.set(keys[2], fence);
      values.set(keys[1], `${argv[0]}:${fence}`);
      expires.set(keys[1], Date.now() + Number(argv[1]));
      return ['ACQUIRED', fence];
    }
    if (script === MEDIA_SCRIPTS.renew) {
      if (current(keys[0]) !== argv[0]) return 0;
      expires.set(keys[0], Date.now() + Number(argv[1]));
      return 1;
    }
    if (script === MEDIA_SCRIPTS.finalize) {
      if (current(keys[1]) !== argv[0] || current(keys[2]) !== argv[1]) return 0;
      if (current(keys[0])) return 2;
      values.set(keys[0], argv[2]);
      values.delete(keys[1]); expires.delete(keys[1]);
      if (failFinalResponse) { failFinalResponse = false; throw new Error('REST response timed out'); }
      return 1;
    }
    if (script === MEDIA_SCRIPTS.release) {
      if (current(keys[0]) !== argv[0]) return 0;
      values.delete(keys[0]); expires.delete(keys[0]);
      return 1;
    }
    throw new Error('unknown Lua script');
  }
  return { values, expires, events, command, setFinalTimeout() { failFinalResponse = true; } };
}

function mediaInput(buffer, alt = 'Ảnh thử') {
  return { fileName: 'Ảnh blog.png', contentType: 'image/png', data: buffer.toString('base64'), alt };
}

async function testImage() {
  return sharp({ create: { width: 1800, height: 1000, channels: 3, background: '#ff8523' } }).png().toBuffer();
}

test('Lua khóa mapping, lock và fence theo cùng hash tag; công bố và nhả trong một script', () => {
  const keys = mediaKeys('abc123');
  assert.ok(Object.values(keys).every((key) => key.endsWith('{abc123}')));
  assert.match(MEDIA_SCRIPTS.finalize, /redis\.call\('SET', KEYS\[1\], ARGV\[3\]\)[\s\S]*redis\.call\('DEL', KEYS\[2\]\)/);
  assert.match(MEDIA_SCRIPTS.acquire, /redis\.call\('INCR', KEYS\[3\]\)/);
  assert.ok(Object.values(MEDIA_SCRIPTS).every((script) => script.startsWith('#!lua flags=allow-key-locking')));
});

test('upload trùng bytes tái sử dụng mapping, giữ alt của lần dùng mới và không Put thêm', async () => {
  const redis = memoryRedis();
  const buffer = await testImage();
  const paths = [];
  const options = {
    redisCommandImpl: redis.command,
    randomUUIDImpl: () => 'owner-1',
    blobPutImpl: async (pathname) => {
      paths.push(pathname);
      return { url: `https://cdn.example.com/${pathname}`, pathname };
    }
  };
  const first = await saveBlogMedia(mediaInput(buffer, 'Alt đầu'), {}, options);
  const second = await saveBlogMedia(mediaInput(buffer, 'Alt khác'), {}, options);
  assert.equal(paths.length, 3);
  assert.ok(paths.every((pathname) => /blog\/assets\/v1\/[a-f0-9]{64}\/\d+w\.webp/.test(pathname)));
  assert.deepEqual(second.responsiveSources, first.responsiveSources);
  assert.equal(second.alt, 'Alt khác');
  assert.equal(redis.events.filter((event) => event.event === 'put_attempted').length, 3);
  assert.equal(redis.events.filter((event) => event.event === 'put_confirmed').length, 3);
  assert.equal(redis.events.filter((event) => event.event === 'dedup_hit').length, 1);
});

test('hai upload đồng thời cùng ảnh chỉ có một luồng Put; request chờ lấy lại mapping', async () => {
  const redis = memoryRedis();
  const buffer = await testImage();
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  let enteredFirst;
  const firstEntered = new Promise((resolve) => { enteredFirst = resolve; });
  let puts = 0;
  const options = {
    redisCommandImpl: redis.command,
    mediaWaitMs: 3_000,
    blobPutImpl: async (pathname) => {
      puts += 1;
      if (puts === 1) { enteredFirst(); await gate; }
      return { url: `https://cdn.example.com/${pathname}`, pathname };
    }
  };
  const first = saveBlogMedia(mediaInput(buffer), {}, options);
  await firstEntered;
  const second = saveBlogMedia(mediaInput(buffer), {}, options);
  releaseFirst();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(puts, 3);
  assert.equal(a.url, b.url);
});

test('request chờ quá hạn báo thử lại và không tự Put lần hai', async () => {
  const redis = memoryRedis();
  const buffer = await testImage();
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  let enteredFirst;
  const firstEntered = new Promise((resolve) => { enteredFirst = resolve; });
  let puts = 0;
  const options = {
    redisCommandImpl: redis.command,
    mediaWaitMs: 10,
    blobPutImpl: async (pathname) => {
      puts += 1;
      if (puts === 1) { enteredFirst(); await gate; }
      return { url: `https://cdn.example.com/${pathname}`, pathname };
    }
  };
  const first = saveBlogMedia(mediaInput(buffer), {}, options);
  await firstEntered;
  await assert.rejects(saveBlogMedia(mediaInput(buffer), {}, options),
    (error) => error.code === 'BLOG_MEDIA_RETRY');
  releaseFirst();
  await first;
  assert.equal(puts, 3);
});

test('fence tăng theo hash; owner cũ không thể gia hạn, công bố hoặc nhả lock mới', async () => {
  const redis = memoryRedis();
  const options = { redisCommandImpl: redis.command, randomUUIDImpl: () => 'old-owner' };
  const first = await acquireMedia('a'.repeat(64), options);
  assert.equal(first.fence, '1');
  redis.expires.set(mediaKeys(first.hash).lock, Date.now() - 1);
  const second = await acquireMedia(first.hash, { ...options, randomUUIDImpl: () => 'new-owner' });
  assert.equal(second.fence, '2');
  assert.equal(await renewMedia(first, options), false);
  assert.equal(await releaseMedia(first, options), 0);
  await assert.rejects(finalizeMedia(first, { id: 'x', responsiveSources: [{ url: 'x', pathname: 'x' }] }, options), /BLOG_MEDIA_LEASE_LOST/);
  assert.equal(redis.values.get(mediaKeys(first.hash).lock), second.lockValue);
  await releaseMedia(second, options);
  assert.equal(redis.values.get(mediaKeys(first.hash).fence), '2');
});

test('timeout phản hồi sau EVAL finalize được xác nhận từ mapping, không Put lần hai', async () => {
  const redis = memoryRedis();
  const lease = await acquireMedia('b'.repeat(64), { redisCommandImpl: redis.command, randomUUIDImpl: () => 'owner' });
  const manifest = { id: 'image', responsiveSources: [{ url: 'https://cdn.example.com/x', pathname: 'x' }] };
  redis.setFinalTimeout();
  const saved = await finalizeMedia(lease, manifest, { redisCommandImpl: redis.command });
  assert.equal(saved.fence, '1');
  assert.equal(redis.values.get(mediaKeys(lease.hash).lock), undefined);
});

test('Put timeout chỉ dùng HEAD cùng pathname; không tạo Put thứ hai', async () => {
  const redis = memoryRedis();
  const buffer = await testImage();
  const attempted = [];
  const heads = [];
  const asset = await saveBlogMedia(mediaInput(buffer), {}, {
    redisCommandImpl: redis.command,
    blobPutImpl: async (pathname, data) => {
      attempted.push({ pathname, size: data.length });
      throw new Error('request timed out');
    },
    blobHeadImpl: async (pathname) => {
      heads.push(pathname);
      const original = attempted.at(-1);
      return { pathname, url: `https://cdn.example.com/${pathname}`, size: original.size, contentType: 'image/webp' };
    }
  });
  assert.equal(attempted.length, 3);
  assert.deepEqual(heads, attempted.map((item) => item.pathname));
  assert.equal(asset.responsiveSources.length, 3);
});

test('HEAD không xác nhận sau Put timeout thì dừng, không Put lại và không công bố mapping', async () => {
  const redis = memoryRedis();
  const buffer = await testImage();
  let puts = 0;
  await assert.rejects(saveBlogMedia(mediaInput(buffer), {}, {
    redisCommandImpl: redis.command,
    blobPutImpl: async () => { puts += 1; throw new Error('request timed out'); },
    blobHeadImpl: async () => { const error = new Error('not found'); error.name = 'BlobNotFoundError'; throw error; }
  }), (error) => error.code === 'BLOG_MEDIA_UPLOAD_FAILED');
  assert.equal(puts, 1);
  assert.equal([...redis.values.keys()].filter((key) => key.startsWith('blog-media:dedup:')).length, 0);
  assert.equal([...redis.values.keys()].filter((key) => key.startsWith('blog-media:lock:')).length, 0);
});

test('retry sau upload dở dùng HEAD cho biến thể đã có và chỉ Put phần còn thiếu', async () => {
  const redis = memoryRedis();
  const buffer = await testImage();
  const objects = new Map();
  let failSecond = true;
  let puts = 0;
  const options = {
    redisCommandImpl: redis.command,
    blobPutImpl: async (pathname, data) => {
      puts += 1;
      if (puts === 2 && failSecond) { failSecond = false; throw new Error('temporary network failure'); }
      if (objects.has(pathname)) throw new Error('blob already exists');
      const object = { pathname, url: `https://cdn.example.com/${pathname}`, size: data.length, contentType: 'image/webp' };
      objects.set(pathname, object);
      return object;
    },
    blobHeadImpl: async (pathname) => {
      if (objects.has(pathname)) return objects.get(pathname);
      const error = new Error('not found'); error.name = 'BlobNotFoundError'; throw error;
    }
  };
  await assert.rejects(saveBlogMedia(mediaInput(buffer), {}, options),
    (error) => error.code === 'BLOG_MEDIA_UPLOAD_FAILED');
  const asset = await saveBlogMedia(mediaInput(buffer), {}, options);
  assert.equal(asset.responsiveSources.length, 3);
  assert.equal(puts, 4); // two first attempt, only two missing variants on retry
  assert.equal(redis.events.filter((event) => event.event === 'head_reused').length, 1);
});

test('profile hai kích thước chỉ áp dụng khi bật riêng cho upload mới', async () => {
  const redis = memoryRedis();
  const buffer = await testImage();
  const asset = await saveBlogMedia(mediaInput(buffer), {}, {
    widthProfile: 'two', redisCommandImpl: redis.command,
    blobPutImpl: async (pathname) => ({ url: `https://cdn.example.com/${pathname}`, pathname })
  });
  assert.deepEqual(asset.responsiveSources.map((source) => source.width), [800, 1600]);
  assert.equal(redis.events.filter((event) => event.event === 'put_attempted').length, 2);
});

test('báo cáo orphan chỉ đọc, xét mọi revision kể cả ảnh của bản nháp', async () => {
  const prefix = 'blog/assets/v1/hash/';
  const old = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();
  const report = await reportBlogMediaOrphans({
    blobToken: 'public-token',
    listPostsImpl: async () => [{ id: 'post-1' }],
    redisCommandImpl: async () => ['1', '2'],
    getPostImpl: async (_id, { revision }) => ({ post: {
      heroImage: { url: `https://cdn.example.com/${prefix}${revision}w.webp` }
    } }),
    blobListImpl: async () => ({ blobs: [1, 2, 3].map((number) => ({
      pathname: `${prefix}${number}w.webp`,
      url: `https://cdn.example.com/${prefix}${number}w.webp`,
      uploadedAt: old,
      size: 100
    })), hasMore: false })
  });
  assert.equal(report.scannedRevisions, 2);
  assert.deepEqual(report.candidates.map((item) => item.pathname), [`${prefix}3w.webp`]);
  assert.equal(report.deletionPerformed, false);
  assert.equal(report.listCalls, 1);
});
