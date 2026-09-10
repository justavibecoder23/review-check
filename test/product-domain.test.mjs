import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aspectCompatibleWithDomain,
  reconcileProductDomain,
  resolveProductDomain
} from '../src/product-domain.mjs';

test('xác định ngành hàng từ metadata trước rồi mới dùng tiêu đề', () => {
  assert.equal(resolveProductDomain({ title: '[TẶNG MUỐI] Kẹo me cay sấy' }).domain, 'food');
  assert.deepEqual(resolveProductDomain({
    title: 'Sản phẩm mới',
    categoryPath: ['Làm đẹp', 'Trang điểm môi']
  }), { domain: 'beauty', subcategory: 'lip', confidence: 0.98, source: 'category' });
  assert.equal(resolveProductDomain({ title: 'Sản phẩm mới chưa phân loại' }).domain, 'unknown');
  assert.equal(resolveProductDomain({ title: 'Táo đỏ sấy dẻo' }).domain, 'food');
});

test('metadata chắc chắn không bị phiếu Layer 2 thay đổi ngành hàng', () => {
  const base = resolveProductDomain({ category: 'Thực phẩm và đồ ăn vặt' });
  const result = reconcileProductDomain(base, [
    { domain: 'beauty', confidence: 0.99 },
    { domain: 'beauty', confidence: 0.99 }
  ], { batchCount: 2 });
  assert.deepEqual(result, base);
});

test('đồng thuận Layer 2 có thể sửa suy luận chỉ dựa trên tiêu đề', () => {
  const base = resolveProductDomain({ title: 'Túi đựng kẹo thời trang' });
  const result = reconcileProductDomain(base, [
    { domain: 'fashion', confidence: 0.96 },
    { domain: 'fashion', confidence: 0.94 }
  ], { batchCount: 2 });
  assert.equal(base.source, 'title');
  assert.equal(result.domain, 'fashion');
  assert.equal(result.source, 'layer2-consensus');
});

test('sản phẩm chưa rõ chỉ nhận đồng thuận Layer 2 đủ mạnh', () => {
  const base = resolveProductDomain({ title: 'Sản phẩm ABC' });
  assert.equal(reconcileProductDomain(base, [{ domain: 'food', confidence: 0.9 }], { batchCount: 2 }).domain, 'unknown');
  assert.equal(reconcileProductDomain(base, [
    { domain: 'food', confidence: 0.9 },
    { domain: 'food', confidence: 0.94 }
  ], { batchCount: 2 }).domain, 'food');
});

test('aspect chuyên ngành phải tương thích với domain cuối', () => {
  assert.equal(aspectCompatibleWithDomain({ label: 'Hương vị' }, { domain: 'food' }), true);
  assert.equal(aspectCompatibleWithDomain({ label: 'Cảm giác trên môi' }, { domain: 'food' }), false);
  assert.equal(aspectCompatibleWithDomain({ label: 'Độ bền sản phẩm' }, { domain: 'electronics' }), true);
  assert.equal(aspectCompatibleWithDomain({ label: 'Hương vị' }, { domain: 'unknown' }), false);
});
