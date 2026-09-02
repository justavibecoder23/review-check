import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractProductPageMeta,
  extractShopeeProductApiMeta,
  fetchProductPageMeta,
  mergeProductMetadata,
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

test('đọc ảnh sản phẩm từ preload khi TikTok không trả Open Graph', () => {
  const metadata = extractProductPageMeta(`
    <title>Kính chống tia UV</title>
    <link rel="preload" fetchPriority="high" as="image"
      href="https://p16-oec-sg.ibyteimg.com/tos/product-cover~tplv-crop-webp:800:800.webp?x=1&amp;y=2">
  `, 'https://shop.tiktok.com/vn/pdp/kinh-chong-tia-uv/1731695277744555051');

  assert.equal(
    metadata.image,
    'https://p16-oec-sg.ibyteimg.com/tos/product-cover~tplv-crop-webp:800:800.webp?x=1&y=2'
  );
});

test('từ chối metadata TikTok nếu redirect sang product id khác', async () => {
  const metadata = await fetchProductPageMeta(
    'https://shop.tiktok.com/vn/pdp/san-pham/1731159356089795879',
    {
      expectedProductId: '1731159356089795879',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => 'text/html; charset=utf-8' },
        body: null,
        async text() {
          return '<meta property="og:image" content="https://p16-oec-sg.ibyteimg.com/tos/wrong.webp">';
        }
      })
    }
  );
  assert.equal(metadata.image, 'https://p16-oec-sg.ibyteimg.com/tos/wrong.webp');

  const redirected = await fetchProductPageMeta(
    'https://shop.tiktok.com/vn/pdp/san-pham/1731159356089795879',
    {
      expectedProductId: '1731159356089795879',
      fetchImpl: async (url) => {
        if (String(url).includes('1731159356089795879')) {
          return {
            ok: false,
            status: 302,
            headers: { get: (name) => name === 'location' ? 'https://shop.tiktok.com/vn/pdp/san-pham-khac/1731695277744555051' : null }
          };
        }
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'text/html; charset=utf-8' },
          body: null,
          async text() {
            return '<meta property="og:image" content="https://p16-oec-sg.ibyteimg.com/tos/wrong-product.webp">';
          }
        };
      }
    }
  );
  assert.deepEqual(redirected, {});
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

test('chỉ dùng URL TikTok đã xác nhận đúng product id', () => {
  assert.deepEqual(
    productMetadataUrls('https://shop.tiktok.com/vn/pdp/kinh-doi-mau/1731159356089795879', {
      platform: 'TikTok Shop',
      productId: '1731159356089795879'
    }),
    ['https://shop.tiktok.com/vn/pdp/kinh-doi-mau/1731159356089795879']
  );
  assert.deepEqual(
    productMetadataUrls('https://shop.tiktok.com/vn/pdp/san-pham-khac/1730000000000000000', {
      platform: 'TikTok Shop',
      productId: '1731159356089795879'
    }),
    []
  );
});

test('ảnh sản phẩm Shopee không bao giờ bị ảnh review ghi đè', () => {
  assert.deepEqual(
    mergeProductMetadata(
      { title: 'Trang Shopee', image: 'https://down-vn.img.susercontent.com/file/product-cover' },
      { title: 'Tên từ review', image: 'https://down-vn.img.susercontent.com/file/review-photo' },
      'Shopee'
    ),
    {
      title: 'Tên từ review',
      image: 'https://down-vn.img.susercontent.com/file/product-cover'
    }
  );
  assert.deepEqual(
    mergeProductMetadata({}, { title: 'Tên từ review', image: 'https://down-vn.img.susercontent.com/file/review-photo' }, 'Shopee'),
    { title: 'Tên từ review' }
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


