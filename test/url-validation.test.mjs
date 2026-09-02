import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMarketplaceInput } from '../public/url-validation.js';

test('chấp nhận link sản phẩm Shopee và TikTok Shop dùng HTTPS', () => {
  assert.equal(validateMarketplaceInput('https://shopee.vn/product-i.123.456').platform, 'Shopee');
  assert.equal(validateMarketplaceInput('https://shop.tiktok.com/vn/pdp/example/17293847561029384').platform, 'TikTok Shop');
  assert.equal(validateMarketplaceInput('https://vt.tiktok.com/ZSExample/').platform, 'TikTok Shop');
});

test('tách đúng link từ nội dung chia sẻ của ứng dụng', () => {
  const shopee = validateMarketplaceInput('Sản phẩm đang giảm giá: https://s.shopee.vn/8Example. Mua ngay!');
  const tiktok = validateMarketplaceInput('Xem tại [TikTok Shop](https://shop.tiktok.com/vn/pdp/example/17293847561029384)');
  assert.equal(shopee.valid, true);
  assert.equal(tiktok.valid, true);
  assert.match(shopee.url, /^https:\/\/s\.shopee\.vn\//);
});

test('từ chối nội dung tùy ý, miền khác và kết nối không an toàn', () => {
  assert.equal(validateMarketplaceInput('đây không phải đường dẫn').valid, false);
  assert.equal(validateMarketplaceInput('https://example.com/product/123').valid, false);
  assert.equal(validateMarketplaceInput('http://shopee.vn/product-i.123.456').valid, false);
  assert.equal(validateMarketplaceInput('https://user:pass@shop.tiktok.com/vn/pdp/example/12345678').valid, false);
});
