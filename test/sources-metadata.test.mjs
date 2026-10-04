import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractProductPageMeta,
  fetchProductPageMetaCandidates,
  getReviews,
  mergeProductMetadata,
  normaliseProductMeta
} from '../src/sources.mjs';

const SHOP_ID = '796123153';
const ITEM_ID = '25219635609';
const PRODUCT_IMAGE_ID = 'vn-11134207-820l4-mf7txt5sv4egb1';
const PRODUCT_IMAGE_URL = `https://down-vn.img.susercontent.com/file/${PRODUCT_IMAGE_ID}`;

function shopeeHtml() {
  return `<html><head><script type="text/mfe-initial-data">${JSON.stringify({
    initialState: {
      DOMAIN_PDP: {
        data: {
          PDP_BFF_DATA: {
            cachedMap: {
              [`${SHOP_ID}/${ITEM_ID}`]: {
                item: {
                  item_id: Number(ITEM_ID),
                  shop_id: Number(SHOP_ID),
                  title: 'Khăn Giấy Rút Treo Tường Bông Sen Vàng 1152 Tờ',
                  image: PRODUCT_IMAGE_ID
                }
              }
            }
          }
        }
      }
    }
  })}</script></head></html>`;
}

function htmlResponse(html) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null },
    text: async () => html
  };
}

test('đọc đúng ảnh sản phẩm Shopee từ MFE data theo shopId và itemId', () => {
  const meta = extractProductPageMeta(shopeeHtml(), `https://shopee.vn/product/${SHOP_ID}/${ITEM_ID}`, {
    expectedShopId: SHOP_ID,
    expectedItemId: ITEM_ID
  });
  assert.equal(meta.image, PRODUCT_IMAGE_URL);
});

test('metadata URL được đọc tuần tự và dừng khi đã có đủ ảnh sản phẩm', async () => {
  const calls = [];
  const meta = await fetchProductPageMetaCandidates([
    `https://shopee.vn/product/${SHOP_ID}/${ITEM_ID}`,
    `https://shopee.vn/product-i.${SHOP_ID}.${ITEM_ID}`
  ], {
    expectedShopId: SHOP_ID,
    expectedItemId: ITEM_ID,
    fetchImpl: async (url) => {
      calls.push(url);
      return htmlResponse(shopeeHtml());
    }
  });

  assert.equal(meta.image, PRODUCT_IMAGE_URL);
  assert.equal(calls.length, 1);
});

test('Shopee vẫn dùng ảnh trang sản phẩm khi API metadata lỗi', async () => {
  const diagnostics = [];
  const metadataEvents = [];
  const background = [];
  const result = await getReviews(`https://shopee.vn/product-i.${SHOP_ID}.${ITEM_ID}`, {
    fetchShopeePublicImpl: async () => ({ status: 'empty' }),
    fetchShopeeDetailImpl: async () => ({ status: 'failed' }),
    onBackgroundWork: (work) => background.push(work),
    onProductMeta: (metadata) => metadataEvents.push(metadata),
    onMetadataDiagnostic: (entry) => diagnostics.push(entry),
    fetchImpl: async (url) => String(url).includes('/api/v4/item/get')
      ? { ok: false, status: 403, headers: { get: () => null } }
      : htmlResponse(shopeeHtml()),
    collectShopeeReviewsImpl: async () => ({
      reviews: [{ id: 'review-1', rating: 5, text: 'Đánh giá thật' }],
      productMetaSource: {},
      collection: { strategy: 'parallel-star-filters', targetMaximum: 100 }
    })
  });
  assert.equal(result.reviews.length, 1);
  await Promise.all(background);
  assert.ok(metadataEvents.some((metadata) => metadata.image === PRODUCT_IMAGE_URL));
  assert.ok(diagnostics.some((entry) => entry.source === 'shopee_item_api' && entry.status === 403));
  assert.ok(diagnostics.every((entry) => entry.traceId && entry.productId === ITEM_ID));
});

test('Shopee chỉ dùng fallback ảnh được đặt tên rõ là ảnh sản phẩm', () => {
  const unsafe = normaliseProductMeta({
    image: 'https://example.com/comment.jpg',
    thumbnail: 'https://example.com/comment-thumb.jpg'
  });
  assert.equal(unsafe.image, undefined);

  const trusted = normaliseProductMeta({ productImage: PRODUCT_IMAGE_URL });
  assert.equal(trusted.image, PRODUCT_IMAGE_URL);
  assert.equal(mergeProductMetadata({}, trusted, 'Shopee').image, PRODUCT_IMAGE_URL);
});

test('Shopee trả review trước nguồn công khai chậm và vẫn phát ảnh tên khi tác vụ nền hoàn tất', async () => {
  const background = [];
  const events = [];
  let resolveMetadata;
  const detail = new Promise((resolve) => { resolveMetadata = resolve; });
  const result = await getReviews(`https://shopee.vn/product/${SHOP_ID}/${ITEM_ID}`, {
    fetchShopeePublicImpl: () => detail,
    fetchShopeeDetailImpl: () => { throw new Error('Public metadata must skip paid Actor'); },
    onBackgroundWork: (work) => background.push(work),
    onProductMeta: (metadata) => events.push(metadata),
    collectShopeeReviewsImpl: async () => ({
      reviews: [{ id: 'review-fast', rating: 5, text: 'Sản phẩm tốt' }],
      productMetaSource: {}, collection: { strategy: 'parallel-star-filters' }
    })
  });
  assert.equal(result.reviews[0].id, 'review-fast');
  assert.equal(events.some((event) => event.image === PRODUCT_IMAGE_URL), false);
  resolveMetadata({ status: 'resolved', metadata: { title: 'Sản phẩm kiểm thử', image: PRODUCT_IMAGE_URL } });
  await Promise.all(background);
  assert.ok(events.some((event) => event.image === PRODUCT_IMAGE_URL
    && event.title === 'Sản phẩm kiểm thử' && event.shopId === SHOP_ID && event.itemId === ITEM_ID));
});

test('public metadata reaches progress and final result without paid Actor and preserves pasted URL', async () => {
  const background = [];
  const events = [];
  let paidCalls = 0;
  const original = `https://shopee.vn/example-i.${SHOP_ID}.${ITEM_ID}?extraParams=%7B%22display_model_id%22%3A123%7D`;
  const result = await getReviews(original, {
    onBackgroundWork: (work) => background.push(work), onProductMeta: (metadata) => events.push(metadata),
    getShopeeProductMetadataImpl: async () => null,
    setShopeeProductMetadataImpl: async () => ({ saved: true }),
    fetchShopeePublicImpl: async (_url, ids) => {
      assert.equal(ids.shopId, SHOP_ID); assert.equal(ids.itemId, ITEM_ID);
      return { status: 'resolved', metadata: { title: 'Tên đúng listing', image: PRODUCT_IMAGE_URL } };
    },
    fetchShopeeDetailImpl: async () => { paidCalls++; return { status: 'failed' }; },
    fetchImpl: async () => { throw new Error('No Shopee page/API request expected'); },
    collectShopeeReviewsImpl: async () => {
      await Promise.all(background);
      return { reviews: [{ id: 'review', rating: 5, text: 'Sản phẩm tốt' }], collection: { strategy: 'parallel-star-filters' } };
    }
  });
  assert.equal(result.product.title, 'Tên đúng listing');
  assert.equal(result.product.image, PRODUCT_IMAGE_URL);
  assert.equal(result.product.url, original);
  assert.equal(paidCalls, 0);
  assert.ok(events.some((event) => event.title === result.product.title && event.image === PRODUCT_IMAGE_URL));
});

test('cached reviews with empty metadata still hydrate in background without running review Actor', async () => {
  const background = [];
  const events = [];
  let resolvePublic;
  const pending = new Promise((resolve) => { resolvePublic = resolve; });
  const result = await getReviews(`https://shopee.vn/product/${SHOP_ID}/${ITEM_ID}`, {
    onBackgroundWork: (work) => background.push(work), onProductMeta: (metadata) => events.push(metadata),
    getShopeeProductMetadataImpl: async () => null, setShopeeProductMetadataImpl: async () => ({ saved: true }),
    getCachedShopeeDatasetImpl: async () => ({ dataset: { product: { platform: 'Shopee', shopId: SHOP_ID, itemId: ITEM_ID },
      reviews: [{ id: 'cached-review', rating: 5, text: 'Review có cache' }], source: {} }, validation: { ageMs: 500 } }),
    fetchShopeePublicImpl: () => pending,
    collectShopeeReviewsImpl: () => { throw new Error('Must reuse reviews'); },
    fetchShopeeDetailImpl: () => { throw new Error('Must not pay for metadata'); }
  });
  assert.equal(result.source.cache.hit, true);
  assert.equal(result.product.image, undefined);
  assert.equal(background.length, 1);
  resolvePublic({ status: 'resolved', metadata: { title: 'Tên bổ sung', image: PRODUCT_IMAGE_URL } });
  await Promise.all(background);
  assert.ok(events.some((event) => event.title === 'Tên bổ sung' && event.image === PRODUCT_IMAGE_URL));
});

test('cached review result merges complete metadata overlay without requesting an external source', async () => {
  const background = [];
  const result = await getReviews(`https://shopee.vn/product/${SHOP_ID}/${ITEM_ID}`, {
    onBackgroundWork: (work) => background.push(work),
    getShopeeProductMetadataImpl: async () => ({ title: 'Tên trong D1', image: PRODUCT_IMAGE_URL }),
    setShopeeProductMetadataImpl: async () => ({ saved: true }),
    getCachedShopeeDatasetImpl: async () => ({ dataset: { product: { platform: 'Shopee', shopId: SHOP_ID, itemId: ITEM_ID },
      reviews: [{ rating: 5, text: 'Review' }], source: {} }, validation: { ageMs: 1 } }),
    fetchShopeePublicImpl: () => { throw new Error('Cache must skip external metadata'); }
  });
  await Promise.all(background);
  assert.equal(result.product.title, 'Tên trong D1');
  assert.equal(result.product.image, PRODUCT_IMAGE_URL);
});

test('metadata actor giữ category path để xác định ngành hàng', () => {
  const metadata = normaliseProductMeta({
    productName: 'Kẹo me cay',
    categories: [{ name: 'Thực phẩm' }, { display_name: 'Đồ ăn vặt' }]
  });
  assert.deepEqual(metadata.categoryPath, ['Thực phẩm', 'Đồ ăn vặt']);
  assert.deepEqual(
    mergeProductMetadata({ category: 'Thực phẩm' }, { categoryPath: metadata.categoryPath }, 'TikTok Shop').categoryPath,
    ['Thực phẩm', 'Đồ ăn vặt']
  );
});

test('metadata chung đọc được product main image dạng object của TikTok', () => {
  assert.deepEqual(normaliseProductMeta({
    product_title: 'Dép xỏ ngón nữ hè',
    product_main_image: { url_list: ['https://p16-oec-sg.ibyteimg.com/tos/product-main.webp'] }
  }), {
    title: 'Dép xỏ ngón nữ hè',
    image: 'https://p16-oec-sg.ibyteimg.com/tos/product-main.webp'
  });
});

test('TikTok dùng metadata cấp sản phẩm từ Actor khi trang sản phẩm bị chặn', async () => {
  const productId = '1732344645376247746';
  const actorImage = 'https://p16-oec-sg.ibyteimg.com/tos/product-cover.webp';
  const metadataEvents = [];
  const result = await getReviews(`https://shop.tiktok.com/vn/pdp/op-lung-iphone-tpu/${productId}`, {
    env: { TIKTOK_RECENT_RAW_CACHE: 'false' },
    onProductMeta: (metadata) => metadataEvents.push(metadata),
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      headers: { get: () => null }
    }),
    collectTikTokReviewsImpl: async () => ({
      reviews: Array.from({ length: 20 }, (_, index) => ({
        id: `review-${index}`,
        rating: 5,
        text: `Nội dung đánh giá ${index}`
      })),
      productMeta: {
        title: 'Ốp lưng iPhone TPU từ Actor',
        image: actorImage
      },
      collection: { targetMaximum: 100, strategy: 'single-unfiltered' },
      warnings: []
    })
  });

  assert.equal(result.product.title, 'Ốp lưng iPhone TPU từ Actor');
  assert.equal(result.product.image, actorImage);
  assert.ok(metadataEvents.length >= 2);
  assert.equal(metadataEvents.at(0).image, undefined);
  assert.equal(metadataEvents.at(-1).image, actorImage);
  assert.equal(metadataEvents.at(-1).productId, productId);
});

test('TikTok không để security check từ trang ghi đè metadata Actor', async () => {
  const productId = '1732344645376247746';
  const actorImage = 'https://p16-oec-sg.ibyteimg.com/tos/product-main.webp';
  const result = await getReviews(`https://shop.tiktok.com/vn/pdp/dep-xo-ngon/${productId}`, {
    env: { TIKTOK_RECENT_RAW_CACHE: 'false' },
    fetchImpl: async () => htmlResponse('<title>Security Check</title><meta property="og:title" content="Security Check">'),
    collectTikTokReviewsImpl: async () => ({
      reviews: Array.from({ length: 20 }, (_, index) => ({ id: `review-${index}`, rating: 5, text: `Review ${index}` })),
      productMeta: { title: 'Dép xỏ ngón nữ hè', image: actorImage },
      collection: { targetMaximum: 100, strategy: 'single-unfiltered' },
      warnings: []
    })
  });

  assert.equal(result.product.title, 'Dép xỏ ngón nữ hè');
  assert.equal(result.product.image, actorImage);
});
