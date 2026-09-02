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
  assert.match(result.reason, /sản phẩm khác/u);
});

test('bộ lọc cuối giữ nhận xét chất lượng hữu ích dù ngắn và Layer 2 không phản hồi', () => {
  const result = shouldKeep({
    rating: 5,
    text: 'Dây mềm và dai, đầu sạc chắc chắn',
    labels: {
      is_off_topic: false,
      relevance: 'on_topic',
      information_value: 'high',
      layer2_unavailable: true,
      defect_categories: []
    }
  });
  assert.equal(result.keep, true);
});

test('bộ lọc cuối trả lý do riêng cho rác và review chỉ nói giao hàng', () => {
  const gibberish = shouldKeep({
    rating: 5,
    text: 'abcbcbcbcbcbcbcbcbcb',
    labels: { is_low_value: true, information_value: 'none', defect_categories: [] },
    labeling: { layer1: { reason_codes: ['LOW_VALUE_GIBBERISH'] } }
  });
  const logistics = shouldKeep({
    rating: 5,
    text: 'Giao hàng nhanh, đóng gói kỹ',
    labels: { is_low_value: true, information_value: 'low', defect_categories: [] },
    labeling: { layer1: { reason_codes: ['LOW_VALUE_LOGISTICS_ONLY'] } }
  });
  assert.match(gibberish.reason, /ký tự ngẫu nhiên/u);
  assert.match(logistics.reason, /giao hàng hoặc đóng gói/u);
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
