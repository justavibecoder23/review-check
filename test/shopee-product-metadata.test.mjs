import test from 'node:test';
import assert from 'node:assert/strict';
import { getShopeeProductTitle, resolveShopeeProductUrl } from '../src/shopee-url.mjs';
import { fetchShopeeProductDetails, normalizeShopeeProductDetails } from '../src/shopee-product-metadata.mjs';
import { getReviews, hydrateShopeeProductMetadata } from '../src/sources.mjs';

const shopId = '364598436', itemId = '3395107842';
const title = 'Áo Giữ Nhiệt Nam Dài Tay Vải Thun Lạnh Co Giãn 4 Chiều Thoải Mái Giữ Ấm Tốt VESCA N';
const originalUrl = `https://shopee.vn/${encodeURIComponent(title.replaceAll(' ', '-'))}-i.${shopId}.${itemId}?extraParams=%7B%7D`;
const image = 'https://down-vn.img.susercontent.com/file/vn-11134207-vescaproductcover';
const blocked = async () => ({ ok: false, status: 403 });
const json = (value) => ({ ok: true, status: 200, json: async () => value });

test('link áo VESCA giữ tên từ slug và không coi product-i là tên', () => {
  assert.equal(getShopeeProductTitle(originalUrl), title);
  assert.equal(getShopeeProductTitle(`https://shopee.vn/product-i.${shopId}.${itemId}`), '');
  assert.equal(getShopeeProductTitle(`https://other.test/ao-i.${shopId}.${itemId}`), '');
});

test('Bioderma và RIEM tiếp tục review khi actor ảnh chưa hoàn tất', async () => {
  for (const url of [
    'https://shopee.vn/Dung-dich-tay-trang-Bioderma-Sebium-H2O-500ml-i.233692311.4819028193',
    'https://shopee.vn/Cay-Cha-Lung-Combo-3-Mon-RIEM-i.430886634.25851626185'
  ]) {
    let finishImage, retained, collected = false;
    const events = [];
    const result = await getReviews(url, {
      metadataWaitMs: 1, fetchImpl: blocked,
      scheduleMetadataBackground: (pending) => { retained = pending; },
      onProductMeta: (product) => events.push({ product, collected }),
      fetchShopeeProductDetailsImpl: async () => new Promise((resolve) => { finishImage = resolve; }),
      collectShopeeReviewsImpl: async () => {
        collected = true;
        return { reviews: [{ rating: 5, text: 'Sản phẩm hữu ích' }] };
      }
    });
    assert.equal(collected, true);
    assert.ok(events[0].product.title);
    assert.equal(events[0].collected, false, 'title must appear before waiting on review/metadata providers');
    assert.equal(result.product.image, undefined);
    assert.ok(retained, 'optional actor is retained as background work');
    finishImage({ title: result.product.title, image });
    await retained;
    assert.equal(events.at(-1).product.image, image);
  }
});

test('Shopee bị chặn vẫn lấy đúng ảnh/tên từ product detail fallback', async () => {
  const resolved = await resolveShopeeProductUrl(originalUrl);
  const metadata = await hydrateShopeeProductMetadata(resolved, {}, {
    fetchImpl: blocked,
    fetchShopeeProductDetailsImpl: async (product) => {
      assert.equal(product.itemId, itemId);
      assert.equal(product.shopId, shopId);
      return { itemId, shopId, name: title, image };
    }
  });
  assert.equal(metadata.image, image);
  assert.equal(metadata.title, title);
  const partial = await hydrateShopeeProductMetadata(resolved, {}, {
    fetchImpl: blocked, fetchShopeeProductDetailsImpl: async () => ({})
  });
  assert.equal(partial.title, title);
  assert.equal(partial.image, undefined);
});

test('lỗi actor ảnh có chẩn đoán an toàn và không che mất tên sản phẩm', async () => {
  const diagnostics = [];
  const result = await hydrateShopeeProductMetadata(await resolveShopeeProductUrl(originalUrl), {}, {
    fetchImpl: blocked,
    fetchShopeeProductDetailsImpl: async () => { throw new DOMException('Actor timeout', 'TimeoutError'); },
    onMetadataDiagnostic: (value) => diagnostics.push(value)
  });
  assert.equal(result.title, title);
  assert.equal(result.image, undefined);
  assert.deepEqual(result.metadataStatus, { status: 'unavailable', reason: 'timeout' });
  assert.ok(diagnostics.some((entry) => entry.source === 'product-detail-actor' && entry.reason === 'timeout'));
});

test('product detail actor chỉ lấy một sản phẩm, không review, có trần chi phí và quyết toán', async () => {
  let reservation, settlement, calls = 0;
  const result = await fetchShopeeProductDetails(await resolveShopeeProductUrl(originalUrl), {
    reserveCounterpartImpl: async (input) => { reservation = input; return { credential: { token: 'fixture' } }; },
    finalizeCounterpartImpl: async (_credential, usage) => { settlement = usage; },
    fetchImpl: async (url, init) => {
      calls++;
      if (url.includes('/runs?')) {
        assert.match(url, /maxTotalChargeUsd=0\.025/);
        const input = JSON.parse(init.body);
        assert.equal(input.startUrls.length, 1);
        assert.equal(input.includeReviews, false);
        return json({ data: { id: 'run', status: 'SUCCEEDED', defaultDatasetId: 'dataset', usageTotalUsd: 0.00499 } });
      }
      assert.match(url, /limit=1/);
      return json([{ itemId, shopId, name: title, image }]);
    }
  });
  assert.equal(calls, 2);
  assert.equal(result.image, image);
  assert.equal(reservation.plannedCostMicroUsd, 25000);
  assert.equal(settlement.actualCostMicroUsd, 4990);
});

test('không chấp nhận ảnh sản phẩm khác hoặc ảnh từ host lạ', () => {
  assert.deepEqual(normalizeShopeeProductDetails(shopId, itemId, { shopId, itemId: '999', image }, { requireIdentity: true }), {});
  assert.deepEqual(normalizeShopeeProductDetails(shopId, itemId, { image }, { requireIdentity: true }), {});
  assert.equal(normalizeShopeeProductDetails(shopId, itemId, { shopId, itemId, image: 'https://example.test/buyer.jpg' }).image, undefined);
});

test('ảnh productImage từ dataset được giữ sau khi gộp metadata live', async () => {
  const result = await getReviews(originalUrl, {
    fetchImpl: blocked, fetchShopeeProductDetailsImpl: async () => ({}),
    collectShopeeReviewsImpl: async () => ({
      reviews: [{ rating: 5, text: 'Vải thoải mái' }],
      productMetaSource: { productName: title, productImage: image }
    })
  });
  assert.equal(result.product.image, image);
  assert.equal(result.product.title, title);
});

test('cache review thiếu metadata được bổ sung ảnh mà không chạy lại actor review', async (context) => {
  const oldUrl = process.env.UPSTASH_REDIS_REST_URL, oldToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test';
  context.after(() => {
    if (oldUrl == null) delete process.env.UPSTASH_REDIS_REST_URL; else process.env.UPSTASH_REDIS_REST_URL = oldUrl;
    if (oldToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN; else process.env.UPSTASH_REDIS_REST_TOKEN = oldToken;
  });
  const dataset = {
    schemaVersion: '1.0.0', datasetKind: 'raw-reviews', runId: 'fixture', createdAt: '2026-10-01T00:00:00Z',
    product: { platform: 'Shopee', shopId, itemId },
    source: { collection: { strategy: 'parallel-star-filters', ratingStrata: [1,2,3,4,5], targetMaximum: 100 } },
    reviews: [1,2,3,4,5].map((rating) => ({ rating, text: 'Vải thoải mái' }))
  };
  const values = new Map([[`realview:cache:product:shopee:${itemId}`, JSON.stringify({ version: 1, platform: 'Shopee', itemId, rawPath: 'review-datasets/fixture/reviews.raw.json', createdAt: dataset.createdAt })]]);
  const execute = (cmd) => {
    if (cmd[0] === 'GET') return values.get(cmd[1]) ?? null;
    if (cmd[0] === 'SET') { values.set(cmd[1], cmd[2]); return 'OK'; }
    if (cmd[0] === 'INCR') return 1;
    return null;
  };
  let metadataCalls = 0;
  const options = {
    now: new Date('2026-10-01T01:00:00Z'), fetchImpl: blocked,
    redisFetchImpl: async (url, init) => { const cmd = JSON.parse(init.body); return json(url.endsWith('/multi-exec') ? cmd.map((c) => ({ result: execute(c) })) : { result: execute(cmd) }); },
    blobGetImpl: async () => ({ statusCode: 200, stream: new Response(JSON.stringify(dataset)).body }),
    collectShopeeReviewsImpl: async () => { throw new Error('Must reuse cached reviews'); },
    fetchShopeeProductDetailsImpl: async () => { metadataCalls++; return { title, image }; }
  };
  const first = await getReviews(originalUrl, options);
  const second = await getReviews(originalUrl, options);
  assert.equal(first.source.type, 'cached');
  assert.equal(first.product.image, image);
  assert.equal(second.product.image, image);
  assert.equal(metadataCalls, 1);
});
