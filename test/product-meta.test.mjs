import test from 'node:test';
import assert from 'node:assert/strict';
import { extractProductPageMeta } from '../src/sources.mjs';

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
