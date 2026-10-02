import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchShopeeDetailActorMetadata, normalizeShopeeDetailActorItem, shopeeDetailEnabled } from '../src/shopee-detail-metadata.mjs';

test('Actor chi tiết bật mặc định và có công tắc tắt độc lập', () => {
  assert.equal(shopeeDetailEnabled({}), true);
  assert.equal(shopeeDetailEnabled({ SHOPEE_DETAIL_ACTOR_ENABLED: 'true' }), true);
  assert.equal(shopeeDetailEnabled({ SHOPEE_DETAIL_ACTOR_ENABLED: 'false' }), false);
});

test('chỉ nhận name và ảnh bìa từ item đúng shopId:itemId, không nhận ảnh người mua', () => {
  const item = {
    shopId: '123', itemId: '456', name: 'Tai nghe Shopee',
    image: 'vn-11134207-productcover-example',
    reviews: [{ images: ['buyer-review-photo'] }]
  };
  assert.deepEqual(normalizeShopeeDetailActorItem(item, '123', '456'), {
    title: 'Tai nghe Shopee',
    image: 'https://down-vn.img.susercontent.com/file/vn-11134207-productcover-example'
  });
  assert.equal(normalizeShopeeDetailActorItem(item, '123', '999'), null);
  assert.deepEqual(normalizeShopeeDetailActorItem({
    shopId: '123', itemId: '456', images: ['https://example.com/buyer.jpg']
  }, '123', '456'), null);
});

test('Actor chi tiết dùng một run cho hai request cùng ID và chốt chi phí thực tế', async () => {
  const oldUrl = process.env.UPSTASH_REDIS_REST_URL;
  const oldToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test';
  const values = new Map();
  const redisFetchImpl = async (_url, init) => {
    const command = JSON.parse(init.body);
    let result = null;
    if (command[0] === 'GET') result = values.get(command[1]) || null;
    if (command[0] === 'SET') {
      if (!command.includes('NX') || !values.has(command[1])) {
        values.set(command[1], command[2]); result = 'OK';
      }
    }
    if (command[0] === 'EVAL') {
      if (values.get(command[3]) === command[4]) { values.delete(command[3]); result = 1; }
    }
    return { ok: true, async json() { return { result }; } };
  };
  let starts = 0;
  let startUrl = '';
  let finalized = null;
  const fetchImpl = async (url) => {
    if (String(url).includes('/runs?')) {
      starts += 1;
      startUrl = String(url);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true, status: 201, async json() { return { data: {
        id: 'run-detail', status: 'SUCCEEDED', defaultDatasetId: 'dataset-1', usageTotalUsd: 0.012
      } }; } };
    }
    return { ok: true, status: 200, async json() { return [{
      shopId: '123', itemId: '456', name: 'Tên chính xác', image: 'vn-11134207-product-cover-123'
    }]; } };
  };
  const options = {
    env: { SHOPEE_DETAIL_ACTOR_ENABLED: 'true', SHOPEE_DETAIL_ACTOR_TIMEOUT_MS: '5000' },
    redisFetchImpl, fetchImpl,
    reserveImpl: async () => ({ credential: { id: 'credential-1', token: 'test-token',
      reservationId: 'reservation-1', accountCycleId: 'account:cycle' } }),
    finalizeImpl: async (_credential, result) => { finalized = result; }
  };
  try {
    const [first, second] = await Promise.all([
      fetchShopeeDetailActorMetadata('https://shopee.vn/product-i.123.456', options),
      fetchShopeeDetailActorMetadata('https://shopee.vn/product-i.123.456', options)
    ]);
    assert.equal(starts, 1);
    assert.equal(first.status, 'resolved');
    assert.equal(second.status, 'pending');
    assert.equal(first.metadata.title, 'Tên chính xác');
    assert.equal(new URL(startUrl).searchParams.get('maxTotalChargeUsd'), '0.05');
    assert.equal(finalized.actualCostMicroUsd, 12_000);
    assert.equal(finalized.actorStarted, true);
  } finally {
    if (oldUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = oldUrl;
    if (oldToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = oldToken;
  }
});

test('timeout mơ hồ khi bắt đầu Actor không tạo run thứ hai cho cùng sản phẩm', async () => {
  const oldUrl = process.env.UPSTASH_REDIS_REST_URL;
  const oldToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test';
  const values = new Map();
  const redisFetchImpl = async (_url, init) => {
    const command = JSON.parse(init.body);
    let result = null;
    if (command[0] === 'GET') result = values.get(command[1]) || null;
    if (command[0] === 'SET' && (!command.includes('NX') || !values.has(command[1]))) {
      values.set(command[1], command[2]); result = 'OK';
    }
    if (command[0] === 'EVAL' && values.get(command[3]) === command[4]) {
      values.delete(command[3]); result = 1;
    }
    return { ok: true, async json() { return { result }; } };
  };
  let starts = 0;
  let finalized;
  const options = {
    redisFetchImpl,
    fetchImpl: async () => { starts += 1; throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); },
    reserveImpl: async () => ({ credential: { id: 'credential-1', token: 'test-token',
      reservationId: 'reservation-1', accountCycleId: 'account:cycle' } }),
    finalizeImpl: async (_credential, result) => { finalized = result; }
  };
  try {
    const first = await fetchShopeeDetailActorMetadata('https://shopee.vn/product-i.123.456', options);
    const second = await fetchShopeeDetailActorMetadata('https://shopee.vn/product-i.123.456', options);
    assert.equal(first.status, 'timeout');
    assert.equal(second.status, 'pending');
    assert.equal(starts, 1);
    assert.equal(finalized.failureClass, 'timeout');
  } finally {
    if (oldUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = oldUrl;
    if (oldToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = oldToken;
  }
});

test('run thất bại đi vào cooldown để làm mới trang không tiêu thêm Apify', async () => {
  const oldUrl = process.env.UPSTASH_REDIS_REST_URL;
  const oldToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test';
  const values = new Map();
  const redisFetchImpl = async (_url, init) => {
    const command = JSON.parse(init.body);
    let result = null;
    if (command[0] === 'GET') result = values.get(command[1]) || null;
    if (command[0] === 'SET') {
      if (!command.includes('NX') || !values.has(command[1])) {
        values.set(command[1], command[2]); result = 'OK';
      }
    }
    if (command[0] === 'EVAL' && values.get(command[3]) === command[4]) {
      values.delete(command[3]); result = 1;
    }
    return { ok: true, async json() { return { result }; } };
  };
  let starts = 0;
  const options = {
    redisFetchImpl,
    fetchImpl: async () => { starts += 1; return { ok: false, status: 403 }; },
    reserveImpl: async () => ({ credential: { id: 'credential-1', token: 'test-token',
      reservationId: 'reservation-1', accountCycleId: 'account:cycle' } }),
    finalizeImpl: async () => ({ ok: true })
  };
  try {
    const first = await fetchShopeeDetailActorMetadata('https://shopee.vn/product-i.123.456', options);
    const second = await fetchShopeeDetailActorMetadata('https://shopee.vn/product-i.123.456', options);
    assert.equal(first.status, 'failed');
    assert.equal(second.status, 'cooldown');
    assert.equal(starts, 1);
  } finally {
    if (oldUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = oldUrl;
    if (oldToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = oldToken;
  }
});
