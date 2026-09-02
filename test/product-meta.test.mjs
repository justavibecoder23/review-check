import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractProductPageMeta,
  extractShopeeProductApiMeta,
  fetchProductPageMeta,
  productMetadataUrls
} from '../src/sources.mjs';

test('đọc tên và ảnh sản phẩm từ Open Graph dù thứ tự thuộc tính khác nhau', () => {
  const metadata = extractProductPageMeta(`
    <!doctype html>
    <html><head>
      <meta content="https://cdn.example.com/product-500.jpg" property="og:image">
      <meta content="Hộp 500g Đậu Hà Lan &amp; Tỏi Ớt" property="og:title">
    </head></html>
  `, 'https://shop.tiktok.com/vn/pdp/example/17293847561029384');
  assert.deepEqual(metadata, {
    title: 'Hộp 500g Đậu Hà Lan & Tỏi Ớt',
    image: 'https://cdn.example.com/product-500.jpg'
  });
});

test('dùng Product JSON-LD làm phương án dự phòng cho ảnh sản phẩm', () => {
  const metadata = extractProductPageMeta(`
    <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Product","name":"Sản phẩm thử nghiệm","image":["/images/product.webp"]}
    </script>
  `, 'https://shopee.vn/product-i.123.456');
  assert.deepEqual(metadata, {
    title: 'Sản phẩm thử nghiệm',
    image: 'https://shopee.vn/images/product.webp'
  });
});

test('không đưa URL ảnh không an toàn vào kết quả', () => {
  const metadata = extractProductPageMeta(
    '<meta property="og:title" content="Sản phẩm"><meta property="og:image" content="javascript:alert(1)">',
    'https://shopee.vn/product-i.123.456'
  );
  assert.deepEqual(metadata, { title: 'Sản phẩm' });
});

test('ưu tiên ảnh gallery sản phẩm khi Open Graph chỉ là logo chung', () => {
  const metadata = extractProductPageMeta(`
    <title>Kính đổi màu tự động</title>
    <meta property="og:image" content="https://shop.tiktok.com/assets/logo.png">
    <img
      src="https://p16-oec-sg.ibyteimg.com/tos-alisg-i-aphluv4xwc-sg/product~tplv-resize-webp%3A800%3A800.webp"
      alt="Kính đổi màu tự động 0"
      width="800"
      height="800"
    >
  `, 'https://shop-vn.tiktok.com/pdp/1731159356089795879');

  assert.equal(
    metadata.image,
    'https://p16-oec-sg.ibyteimg.com/tos-alisg-i-aphluv4xwc-sg/product~tplv-resize-webp%3A800%3A800.webp'
  );
});

test('tạo thêm URL TikTok Shop SEO từ đúng product id', () => {
  assert.deepEqual(
    productMetadataUrls('https://shop.tiktok.com/vn/pdp/kinh-doi-mau/1731159356089795879', {
      platform: 'TikTok Shop',
      productId: '1731159356089795879'
    }),
    [
      'https://shop.tiktok.com/vn/pdp/kinh-doi-mau/1731159356089795879',
      'https://shop-vn.tiktok.com/pdp/1731159356089795879',
      'https://shop.tiktok.com/view/product/1731159356089795879'
    ]
  );
});

test('đổi mã ảnh Shopee thành URL CDN hiển thị được', () => {
  assert.deepEqual(
    extractShopeeProductApiMeta({
      data: {
        item: {
          name: 'Sản phẩm Shopee',
          image: 'vn-11134207-7ras8-exampleimagehash'
        }
      }
    }),
    {
      title: 'Sản phẩm Shopee',
      image: 'https://down-vn.img.susercontent.com/file/vn-11134207-7ras8-exampleimagehash'
    }
  );
});

test('yêu cầu metadata TikTok bằng chế độ preview để nhận ảnh Open Graph', async () => {
  let requestedUserAgent = '';
  const metadata = await fetchProductPageMeta(
    'https://shop.tiktok.com/vn/pdp/example/1731159356089795879',
    {
      fetchImpl: async (_url, options) => {
        requestedUserAgent = options.headers['user-agent'];
        return {
          ok: true,
          status: 200,
          headers: {
            get(name) {
              return name === 'content-type' ? 'text/html; charset=utf-8' : null;
            }
          },
          body: null,
          async text() {
            return '<meta property="og:title" content="Sản phẩm TikTok"><meta property="og:image" content="https://p16-oec-sg.ibyteimg.com/tos/product.webp">';
          }
        };
      }
    }
  );

  assert.equal(requestedUserAgent, 'Twitterbot/1.0');
  assert.deepEqual(metadata, {
    title: 'Sản phẩm TikTok',
    image: 'https://p16-oec-sg.ibyteimg.com/tos/product.webp'
  });
});
