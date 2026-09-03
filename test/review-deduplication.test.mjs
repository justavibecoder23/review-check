import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldKeep } from '../src/analyze.mjs';
import { annotateReviewDuplicates } from '../src/review-deduplication.mjs';
import { calculateTrustScoreV31 } from '../src/trust-score-v31.mjs';

function labeled(text, id, rating = 5) {
  return {
    labelId: id,
    rating,
    text,
    verified: true,
    included: true,
    labels: {
      is_seeding: false,
      is_vague: false,
      is_low_value: false,
      is_off_topic: false,
      information_value: 'high',
      defect_categories: [],
      reviewed_by: 'gemini-layer2'
    }
  };
}

test('nội dung giống hệt với ID khác chỉ giữ bản đầu tiên', () => {
  const text = 'Dây sạc chắc chắn, sạc nhanh ổn định và không làm nóng máy khi sử dụng.';
  const result = annotateReviewDuplicates([labeled(text, 'r1'), labeled(text, 'r2')]);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.reviews[0].labels.is_duplicate, undefined);
  assert.equal(result.reviews[1].labels.is_duplicate, true);
  assert.equal(result.reviews[1].labels.duplicate_of, 'r1');
  assert.equal(shouldKeep(result.reviews[1]).keep, false);
});

test('near-duplicate dài bị phát hiện nhưng hai trải nghiệm khác nhau không bị gộp', () => {
  const original = 'Cáp sạc Baseus dùng rất tốt, sạc nhanh, đầu cắm chắc chắn và dây dày dặn.';
  const copied = 'Cáp sạc Baseus dùng rất tốt, sạc nhanh, đầu cắm chắc chắn và dây dày dặn nhé.';
  const different = 'Sau hai tuần sử dụng, cáp đôi lúc mất kết nối khi bẻ gần đầu cắm.';
  const result = annotateReviewDuplicates([
    labeled(original, 'r1'), labeled(copied, 'r2'), labeled(different, 'r3', 2)
  ]);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.reviews[1].labels.reason_code, 'DUPLICATE_CONTENT');
  assert.equal(result.reviews[2].labels.is_duplicate, undefined);
});

test('nhiều bản sao không thể làm cỡ mẫu TrustScore tăng giả tạo', () => {
  const reviews = Array.from({ length: 60 }, (_, index) => labeled(
    'Sản phẩm dùng tốt, chất liệu chắc chắn và đúng mô tả của cửa hàng.',
    `r${index + 1}`,
    [1, 3, 5][index % 3]
  ));
  const annotated = annotateReviewDuplicates(reviews).reviews;
  const scored = calculateTrustScoreV31(annotated, {
    sampling: { strategy: 'parallel-star-filters', perStarLimit: 20 }
  });
  assert.equal(scored.sample.afterSeedingRemoval, 1);
  assert.equal(scored.score, null);
  assert.equal(scored.scoreStatus, 'insufficient');
  assert.ok(scored.components.authenticity.score < 2);
});
