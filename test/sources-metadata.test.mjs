import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractProductPageMeta,
  fetchProductPageMetaCandidates,
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
