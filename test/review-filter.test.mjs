import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldKeep } from '../src/analyze.mjs';

test('bộ lọc cuối loại review sai sản phẩm', () => {
  const result = shouldKeep({
    rating: 5,
    text: 'Dao cạo râu ok, sắc, bền và giá hạt dẻ',
    labels: { is_off_topic: true, defect_categories: [] }
  });
  assert.equal(result.keep, false);
  assert.match(result.reason, /không liên quan/u);
});

test('bộ lọc cuối không dùng review mơ hồ khi Layer 2 đã lỗi', () => {
  const result = shouldKeep({
    rating: 5,
    text: 'Nội dung dài nhưng chưa có tín hiệu kiểm chứng rõ ràng',
    labels: { layer2_unavailable: true, defect_categories: [] }
  });
  assert.equal(result.keep, false);
  assert.match(result.reason, /Chưa đủ dữ liệu/u);
});
