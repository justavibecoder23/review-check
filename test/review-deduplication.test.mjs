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

test('nội dung giống hệt với ID khác chỉ giữ một bản đại diện ổn định', () => {
  const text = 'Dây sạc chắc chắn, sạc nhanh ổn định và không làm nóng máy khi sử dụng.';
  const result = annotateReviewDuplicates([labeled(text, 'r1'), labeled(text, 'r2')]);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.reviews[0].labels.is_duplicate, undefined);
  assert.equal(result.reviews[1].labels.is_duplicate, true);
  assert.equal(result.reviews[1].labels.duplicate_of, 'r1');
  assert.equal(shouldKeep(result.reviews[1]).keep, false);
});

test('bản sao exact ngắn vẫn bị loại dù chưa đủ độ dài so khớp near-duplicate', () => {
  const result = annotateReviewDuplicates([labeled('Rất tốt', 'r1'), labeled('Rất tốt', 'r2')]);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.reviews[1].labels.duplicate_of, 'r1');
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
  assert.equal(scored.sample.afterSeedingRemoval, 0);
  assert.ok(Number.isFinite(scored.score));
  assert.ok(scored.score <= 52);
  assert.equal(scored.scoreStatus, 'limited');
  assert.ok(scored.components.authenticity.score < 2);
});

test('đổi thứ tự duplicate khác tầng sao không làm đổi TrustScore', () => {
  const duplicatedText = 'Cáp sạc bền và đầu cắm chắc chắn, sử dụng ổn định trong thực tế.';
  const duplicatePair = [
    labeled(duplicatedText, 'duplicate-low', 1),
    labeled(duplicatedText, 'duplicate-high', 5)
  ];
  const unique = Array.from({ length: 18 }, (_, index) => labeled(`Mẫu riêng ${index + 1}`, `unique-${index + 1}`, index % 5 + 1));
  const options = { sampling: { strategy: 'parallel-star-filters', perStarLimit: 20 } };
  const forwardDedup = annotateReviewDuplicates([...duplicatePair, ...unique]);
  const reverseDedup = annotateReviewDuplicates([...duplicatePair, ...unique].reverse());
  const forward = calculateTrustScoreV31(forwardDedup.reviews, options);
  const reverse = calculateTrustScoreV31(reverseDedup.reviews, options);

  assert.equal(forwardDedup.duplicateCount, 2, 'duplicate mâu thuẫn sao phải loại cả cụm');
  assert.equal(reverseDedup.duplicateCount, 2);
  assert.ok(forwardDedup.reviews.filter((review) => review.labels?.duplicate_rating_conflict).length === 2);
  assert.equal(forward.score, reverse.score);
  assert.ok(Math.abs(forward.rawScore - reverse.rawScore) < 1e-12);
  assert.ok(Math.abs(forward.adequacy.coverage - reverse.adequacy.coverage) < 1e-12);
  assert.deepEqual(forward.components, reverse.components);
});

test('duplicate cùng định danh nhưng khác nhãn cuối không phụ thuộc thứ tự đầu vào', () => {
  const text = 'Sản phẩm rất chắc chắn và dùng tốt trong trải nghiệm thực tế';
  const common = {
    labelId: 'same', reviewId: 'id1', authorId: 'a', date: '2025-01-01',
    rating: 5, text, verified: true
  };
  const clean = labeled(text, 'same', 5);
  Object.assign(clean, common);
  const rejected = labeled(text, 'same', 5);
  Object.assign(rejected, common, { included: false });
  rejected.labels = { ...rejected.labels, is_low_value: true, information_value: 'none' };
  const unique = Array.from({ length: 18 }, (_, index) => labeled(
    `Trải nghiệm riêng ${index + 1} đủ chi tiết về độ bền và cách sử dụng.`,
    `unique-${index + 1}`,
    5
  ));
  const options = { sampling: { strategy: 'parallel-star-filters', perStarLimit: 20 } };
  const forward = calculateTrustScoreV31(annotateReviewDuplicates([clean, rejected, ...unique]).reviews, options);
  const reverse = calculateTrustScoreV31(annotateReviewDuplicates([rejected, clean, ...unique]).reviews, options);

  assert.equal(forward.score, reverse.score);
  assert.ok(Math.abs(forward.rawScore - reverse.rawScore) < 1e-12);
  assert.deepEqual(forward.components, reverse.components);
  assert.ok(Math.abs(forward.adequacy.coverage - reverse.adequacy.coverage) < 1e-12);
});

test('duplicate xung đột nhãn không phụ thuộc giá trị định danh nguồn', () => {
  const text = 'Sản phẩm chắc chắn và dùng tốt trong trải nghiệm thực tế hằng ngày';
  const makePair = (cleanId, rejectedId) => {
    const clean = labeled(text, `clean-${cleanId}`, 5);
    Object.assign(clean, { reviewId: cleanId, authorId: cleanId });
    const rejected = labeled(text, `rejected-${rejectedId}`, 5);
    Object.assign(rejected, { reviewId: rejectedId, authorId: rejectedId, included: false });
    rejected.labels = { ...rejected.labels, is_low_value: true, information_value: 'none' };
    return [clean, rejected];
  };
  const unique = Array.from({ length: 18 }, (_, index) => labeled(
    `Nội dung riêng ${index + 1} mô tả đủ rõ độ bền và cách sử dụng sản phẩm.`,
    `unique-${index + 1}`,
    5
  ));
  const options = { sampling: { strategy: 'parallel-star-filters', perStarLimit: 20 } };
  const firstAudit = annotateReviewDuplicates([...makePair('a', 'z'), ...unique]);
  const swappedAudit = annotateReviewDuplicates([...makePair('z', 'a'), ...unique]);
  const first = calculateTrustScoreV31(firstAudit.reviews, options);
  const swapped = calculateTrustScoreV31(swappedAudit.reviews, options);

  assert.equal(firstAudit.duplicateCount, 2);
  assert.equal(swappedAudit.duplicateCount, 2);
  assert.ok(firstAudit.reviews.filter((review) => review.labels?.duplicate_semantic_conflict).length === 2);
  assert.equal(first.score, swapped.score);
  assert.ok(Math.abs(first.rawScore - swapped.rawScore) < 1e-12);
  assert.deepEqual(first.components, swapped.components);
  assert.ok(Math.abs(first.adequacy.coverage - swapped.adequacy.coverage) < 1e-12);
});
