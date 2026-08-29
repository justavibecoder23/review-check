import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateTrustScoreV31,
  combineTrustComponents,
  correctedOddsRatio,
  exactBinomialSurvival,
  fisherExactTwoSided,
  holmAdjust,
  scoreNegativeReview
} from '../src/trust-score-v31.mjs';

test('TrustScore ưu tiên nhãn cuối của pipeline hai lớp thay vì tự bắt keyword lại', () => {
  const result = calculateTrustScoreV31([
    { rating: 5, text: 'Nội dung không chứa keyword seeding.', labels: { is_seeding: true, is_vague: false, is_low_value: false, defect_categories: [], reviewed_by: 'gemini-layer2' } },
    { rating: 1, text: 'Tệ', labels: { is_seeding: false, is_vague: true, is_low_value: true, defect_categories: [], reviewed_by: 'gemini-layer2' } },
    { rating: 2, text: 'Không có cụm lỗi trong lexicon.', labels: { is_seeding: false, is_vague: false, is_low_value: false, defect_categories: ['su-dung'], reviewed_by: 'gemini-layer2' } }
  ]);
  assert.equal(result.sample.seedingCount, 1);
  assert.equal(result.defects.tests.find((item) => item.id === 'su-dung').count, 1);
  assert.equal(result.fisher.negative.table.a, 1);
});

test('binomial exact khớp ví dụ n=85, k=9, p0=0.03 trong tài liệu', () => {
  const pValue = exactBinomialSurvival(85, 9, 0.03);
  assert.ok(Math.abs(pValue - 0.0010374532) < 1e-10);
  assert.ok(pValue < 0.002, 'vượt ngưỡng Bonferroni 0.01/5');
});

test('Fisher two-sided và OR Haldane–Anscombe khớp bảng 14,1,53,32', () => {
  const table = { a: 14, b: 1, c: 53, d: 32 };
  assert.ok(Math.abs(fisherExactTwoSided(table) - 0.0182989522) < 1e-10);
  assert.ok(Math.abs(correctedOddsRatio(table) - 5.8722741433) < 1e-10);
});

test('Holm điều chỉnh p-value theo thứ tự và không làm p điều chỉnh giảm', () => {
  const results = holmAdjust([
    { id: 'a', pValue: 0.001 },
    { id: 'b', pValue: 0.004 },
    { id: 'c', pValue: 0.20 }
  ]);
  assert.equal(results.find((item) => item.id === 'a').adjustedPValue, 0.003);
  assert.equal(results.find((item) => item.id === 'b').adjustedPValue, 0.008);
  assert.equal(results.find((item) => item.id === 'c').adjustedPValue, 0.2);
});

test('hard gatekeeping được áp dụng trước khi làm tròn điểm cuối', () => {
  const combined = combineTrustComponents({ distribution: 72, text: 70, fisher: 36, defect: 33.8235, temporal: 85 });
  assert.ok(Math.abs(combined.rawScore - 54.89705) < 1e-8);
  assert.equal(combined.caps.fisher, 55);
  assert.equal(combined.caps.high, 79);
  assert.equal(combined.score, 55);

  const defectGate = combineTrustComponents({ distribution: 100, text: 100, fisher: 100, defect: 24.9, temporal: 100 });
  assert.equal(defectGate.score, 39);
});

test('điểm review tiêu cực dùng logistic, thưởng chi tiết lỗi và phạt nội dung mơ hồ', () => {
  const vague = scoreNegativeReview({ rating: 1, text: 'Quá tệ' });
  const detailed = scoreNegativeReview({ rating: 1, text: 'Sản phẩm không hoạt động sau hai ngày, pin yếu và máy nóng bất thường.' });
  assert.ok(vague < detailed);
  assert.ok(vague >= 0 && detailed <= 100);
});

test('mẫu lấy đều 5 mức sao không được xem là phân bố rating tự nhiên để nâng điểm', () => {
  const reviews = [5, 4, 3, 2, 1].flatMap((rating) => Array.from({ length: 20 }, (_, index) => ({
    rating,
    text: `Trải nghiệm đủ chi tiết ở mức ${rating} sao, mẫu ${index + 1}.`,
    verified: true,
    labels: { is_seeding: false, is_vague: false, is_low_value: false, defect_categories: [], reviewed_by: 'layer1' }
  })));
  const result = calculateTrustScoreV31(reviews, {
    sampling: { strategy: 'parallel-star-filters', perStarLimit: 20 }
  });
  assert.equal(result.sampling.controlledStarStrata, true);
  assert.equal(result.components.distribution.score, 50);
  assert.equal(result.components.distribution.status, 'neutral-controlled-sample');
  assert.equal(result.fisher.positive.score <= 50, true);
  assert.equal(result.fisher.negative.score <= 50, true);
});

test('không đủ ý nghĩa Fisher là trung tính, không được tự động xem là tín hiệu tốt', () => {
  const result = calculateTrustScoreV31([
    { rating: 5, text: 'Nội dung chi tiết và bình thường.', labels: { is_seeding: false, is_vague: false, defect_categories: [] } },
    { rating: 1, text: 'Không dính và rơi ra.', labels: { is_seeding: false, is_vague: false, defect_categories: ['chat-lieu'] } }
  ]);
  assert.equal(result.fisher.positive.significant, false);
  assert.equal(result.fisher.negative.significant, false);
  assert.equal(result.fisher.positive.score, 50);
  assert.equal(result.fisher.negative.score, 50);
});

test('chỉ báo Holm chỉ bật khi đủ p-value cho cả gia đình kiểm định', () => {
  const reviews = [
    { rating: 2, text: 'Vải mỏng và form nhỏ.', verified: true },
    { rating: 4, text: 'Sản phẩm dùng ổn.', verified: true }
  ];
  const partial = calculateTrustScoreV31(reviews, {
    category: 'general',
    baselines: { calibrated: true, source: 'test', values: { general: { 'giao-hang': 0.04 } } }
  });
  assert.equal(partial.defects.familyComplete, false);
  assert.equal(partial.defects.multipleTestingMethod, 'bonferroni-fixed');
  assert.ok(partial.defects.tests.every((item) => item.significantHolm === false));
  assert.ok(partial.defects.tests.every((item) => item.adjustedPValue === null));

  const completeValues = Object.fromEntries(partial.defects.tests.map((item) => [item.id, 0.04]));
  const complete = calculateTrustScoreV31(reviews, {
    category: 'general',
    baselines: { calibrated: true, source: 'test', values: { general: completeValues } }
  });
  assert.equal(complete.defects.familyComplete, true);
  assert.equal(complete.defects.multipleTestingMethod, 'holm-bonferroni');
  assert.ok(complete.defects.tests.every((item) => Number.isFinite(item.adjustedPValue)));
});
