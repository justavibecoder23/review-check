import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateTrustScoreV31, combineTrustComponents, correctedOddsRatio,
  exactBinomialSurvival, fisherExactTwoSided, holmAdjust, scoreNegativeReview
} from '../src/trust-score-v31.mjs';

function usefulReview(index, overrides = {}) {
  return {
    rating: 3,
    text: `Review ${index + 1} mô tả trải nghiệm sử dụng thực tế, chất liệu và độ hoàn thiện của sản phẩm.`,
    verified: true,
    included: true,
    ...overrides,
    labels: {
      has_defect: false,
      is_seeding: false,
      is_vague: false,
      is_low_value: false,
      is_off_topic: false,
      relevance: 'on_topic',
      information_value: 'high',
      defect_categories: [],
      reviewed_by: 'gemini-layer2',
      ...(overrides.labels || {})
    }
  };
}

test('TrustScore ưu tiên nhãn cuối của pipeline hai lớp', () => {
  const result = calculateTrustScoreV31([
    usefulReview(0, { rating: 5, labels: { is_seeding: true } }),
    usefulReview(1, { rating: 1, included: false, labels: { is_vague: true, is_low_value: true } }),
    usefulReview(2, { rating: 2, labels: { has_defect: true, defect_categories: ['su-dung'] } })
  ]);
  assert.equal(result.sample.seedingCount, 1);
  assert.equal(result.defects.tests.find((item) => item.id === 'su-dung').count, 1);
  assert.equal(result.fisher.negative.table.a, 1);
  assert.ok(Math.abs(result.components.authenticity.score - 100 / 3) < 1e-10);
});

test('nhãn has_defect=false khóa category lỗi cũ', () => {
  const result = calculateTrustScoreV31([usefulReview(0, {
    rating: 5, text: 'Sạc ổn định không nóng máy.',
    labels: { has_defect: false, defect_categories: ['su-dung'] }
  })]);
  assert.equal(result.defects.tests.find((item) => item.id === 'su-dung').count, 0);
  assert.equal(result.defects.risk, 0);
});

test('binomial exact khớp ví dụ n=85, k=9, p0=0.03', () => {
  assert.ok(Math.abs(exactBinomialSurvival(85, 9, 0.03) - 0.0010374532) < 1e-10);
});

test('Fisher two-sided và OR Haldane–Anscombe khớp bảng 14,1,53,32', () => {
  const table = { a: 14, b: 1, c: 53, d: 32 };
  assert.ok(Math.abs(fisherExactTwoSided(table) - 0.0182989522) < 1e-10);
  assert.ok(Math.abs(correctedOddsRatio(table) - 5.8722741433) < 1e-10);
});

test('Holm điều chỉnh p-value đơn điệu theo thứ tự', () => {
  const results = holmAdjust([{ id: 'a', pValue: 0.001 }, { id: 'b', pValue: 0.004 }, { id: 'c', pValue: 0.20 }]);
  assert.equal(results.find((item) => item.id === 'a').adjustedPValue, 0.003);
  assert.equal(results.find((item) => item.id === 'b').adjustedPValue, 0.008);
  assert.equal(results.find((item) => item.id === 'c').adjustedPValue, 0.2);
});

test('TrustScore v4 là trung bình minh bạch của bốn thành phần và không còn cap', () => {
  const combined = combineTrustComponents({ text: 80, authenticity: 60, labeling: 100, adequacy: 40 });
  assert.equal(combined.rawScore, 70);
  assert.equal(combined.score, 70);
  assert.deepEqual(Object.values(combined.components).map((item) => item.weight), [0.25, 0.25, 0.25, 0.25]);
  assert.equal(combined.guardrails.totalPenalty, 0);
  assert.equal(combined.caps.deprecated, true);
  assert.equal(combined.caps.applied.length, 0);
});

test('điểm review tiêu cực riêng thưởng chi tiết và phạt nội dung mơ hồ', () => {
  const vague = scoreNegativeReview({ rating: 1, text: 'Quá tệ' });
  const detailed = scoreNegativeReview({ rating: 1, text: 'Sản phẩm không hoạt động sau hai ngày, pin yếu và máy nóng bất thường.' });
  assert.ok(vague < detailed);
  assert.equal(scoreNegativeReview({ rating: 0, text: 'Không có rating hợp lệ' }), null);
});

test('một tài khoản lặp nhiều review không làm cỡ mẫu bằng chứng tăng giả', () => {
  const reviews = Array.from({ length: 20 }, (_, index) => usefulReview(index, { authorId: 'same-buyer' }));
  const result = calculateTrustScoreV31(reviews);
  assert.equal(result.sample.independentEvidenceSize, 1);
  assert.equal(result.scoreStatus, 'insufficient');
  assert.equal(result.score, null);
});

test('mẫu chia tầng không được giả là phân bố rating tự nhiên', () => {
  const reviews = [5, 4, 3, 2, 1].flatMap((rating) => Array.from({ length: 20 }, (_, index) => usefulReview(index, { rating })));
  const result = calculateTrustScoreV31(reviews, { sampling: { strategy: 'parallel-star-filters', perStarLimit: 20 } });
  assert.equal(result.sampling.controlledStarStrata, true);
  assert.equal(result.sampling.populationInferenceEnabled, false);
  assert.equal(result.fisher.positive.pValue, null);
  assert.equal(result.fisher.negative.pValue, null);
  assert.ok(Math.abs(result.adequacy.balancedEvidenceSize - 60) < 1e-10);
  assert.equal(result.adequacy.effectiveSampleSizeDeprecated, true);
  assert.equal(result.sample.statisticalPopulation, 60);
  assert.equal(result.sample.excludedBySamplingDesign, 40);
  assert.deepEqual(result.adequacy.missingRatings, []);
});

test('defectScore chỉ là chẩn đoán sản phẩm và không tham gia TrustScore', () => {
  const clean = Array.from({ length: 20 }, (_, index) => usefulReview(index));
  const defective = clean.map((review, index) => index < 10
    ? usefulReview(index, { labels: { has_defect: true, defect_categories: ['su-dung'] } })
    : review);
  const cleanResult = calculateTrustScoreV31(clean);
  const defectResult = calculateTrustScoreV31(defective);
  assert.equal(defectResult.scope, 'review-set-reliability');
  assert.equal(defectResult.defects.diagnosticOnly, true);
  assert.equal(defectResult.defects.affectsTrustScore, false);
  assert.ok(cleanResult.defects.score > defectResult.defects.score);
  assert.equal(cleanResult.score, defectResult.score);
  assert.deepEqual(cleanResult.components, defectResult.components);
});

test('mẫu chia tầng dùng mốc 1,3,5 và review 2,4 không làm lệch defectRisk', () => {
  const clean = (rating) => Array.from({ length: 20 }, (_, index) => usefulReview(index, { rating }));
  const defective = (rating) => Array.from({ length: 20 }, (_, index) => usefulReview(index, {
    rating, labels: { has_defect: true, defect_categories: ['su-dung'] }
  }));
  const result = calculateTrustScoreV31([...clean(1), ...defective(2), ...clean(3), ...defective(4), ...clean(5)], {
    sampling: { strategy: 'parallel-star-filters', perStarLimit: 20 }
  });
  assert.equal(result.defects.estimator.method, 'equal-anchor-ratings');
  assert.deepEqual(result.defects.estimator.strata.map((item) => item.rating), [1, 3, 5]);
  assert.equal(result.defects.risk, 0);
  assert.equal(result.defects.estimator.comparableAcrossPlatforms, false);
  assert.equal(result.defects.estimator.comparableUnderCommonDesign, true);
});

test('TikTok dùng đủ năm tầng 1–5 theo đúng thiết kế lấy mẫu riêng', () => {
  const reviews = [1, 2, 3, 4, 5].flatMap((rating) => Array.from({ length: 20 }, (_, index) => usefulReview(index, { rating })));
  const result = calculateTrustScoreV31(reviews, {
    sampling: { strategy: 'parallel-star-filters', ratingStrata: [1, 2, 3, 4, 5], perStarLimit: 20 }
  });
  assert.deepEqual(result.sampling.standardRatings, [1, 2, 3, 4, 5]);
  assert.equal(result.sample.statisticalPopulation, 100);
  assert.equal(result.sample.excludedBySamplingDesign, 0);
  assert.ok(Math.abs(result.adequacy.balancedEvidenceSize - 100) < 1e-10);
  assert.deepEqual(result.defects.estimator.strata.map((item) => item.rating), [1, 2, 3, 4, 5]);
});

test('thiếu một tầng chuẩn thì không công bố TrustScore', () => {
  const reviews = [3, 5].flatMap((rating) => Array.from({ length: 20 }, (_, index) => usefulReview(index, { rating })));
  const result = calculateTrustScoreV31(reviews, { sampling: { strategy: 'parallel-star-filters', perStarLimit: 20 } });
  assert.equal(result.score, null);
  assert.equal(result.rawScore, null);
  assert.equal(result.scoreStatus, 'insufficient');
  assert.deepEqual(result.adequacy.missingRatings, [1]);
});

test('không có bằng chứng không được mặc định thành điểm cao', () => {
  const reviews = Array.from({ length: 20 }, (_, index) => usefulReview(index, {
    included: false, labels: { is_low_value: true, information_value: 'none' }
  }));
  const result = calculateTrustScoreV31(reviews);
  assert.equal(result.score, null);
  assert.equal(result.scoreStatus, 'insufficient');
  assert.equal(result.components.text.score, 0);
  assert.equal(result.components.authenticity.score, 0);
});

test('review bị loại là nhiễu audit nhưng không làm sai thống kê khuyết điểm', () => {
  const kept = Array.from({ length: 20 }, (_, index) => usefulReview(index));
  const rejected = [
    usefulReview(20, {
      rating: 1, text: 'Đôi dép bị rách và không dùng được.', included: false,
      labels: { is_off_topic: true, relevance: 'off_topic', has_defect: true, defect_categories: ['chat-lieu', 'su-dung'] }
    }),
    usefulReview(21, { text: 'ok', included: false, labels: { is_low_value: true, information_value: 'none' } })
  ];
  const baseline = calculateTrustScoreV31(kept);
  const withRejected = calculateTrustScoreV31([...kept, ...rejected]);
  assert.ok(withRejected.components.authenticity.score < baseline.components.authenticity.score);
  assert.equal(withRejected.defects.risk, baseline.defects.risk);
  assert.equal(withRejected.sample.afterSeedingRemoval, 20);
  assert.equal(withRejected.sample.rejectedFromEvidence, 2);
});

test('từ khen “đẹp” không làm suy luận sai sản phẩm thành thời trang', () => {
  const reviews = Array.from({ length: 20 }, (_, index) => usefulReview(index, {
    text: `Bình nước giữ nhiệt siêu đẹp và dùng tốt, lần thử ${index + 1}.`
  }));
  const result = calculateTrustScoreV31(reviews, { product: { title: 'Bình nước giữ nhiệt siêu đẹp' } });
  assert.equal(result.defects.baseline.category, 'general');
});

test('suy luận chỉ bật khi mẫu ngẫu nhiên và baseline đã hiệu chuẩn', () => {
  const reviews = Array.from({ length: 20 }, (_, index) => usefulReview(index));
  const ids = ['chat-lieu', 'kich-co', 'dung-mo-ta', 'giao-hang', 'su-dung'];
  const baselines = { calibrated: true, source: 'test', values: { general: Object.fromEntries(ids.map((id) => [id, 0.04])) } };
  const descriptive = calculateTrustScoreV31(reviews, { category: 'general', baselines });
  assert.equal(descriptive.sampling.populationInferenceEnabled, false);
  assert.ok(descriptive.defects.tests.every((item) => item.pValue === null));

  const inferential = calculateTrustScoreV31(reviews, {
    category: 'general', baselines, sampling: { strategy: 'random', randomized: true }
  });
  assert.equal(inferential.sampling.populationInferenceEnabled, true);
  assert.equal(inferential.defects.familyComplete, true);
  assert.ok(inferential.defects.tests.every((item) => Number.isFinite(item.adjustedPValue)));
});

test('cờ randomized không bật suy luận tổng thể khi mẫu vẫn chia tầng sao', () => {
  const reviews = [1, 3, 5].flatMap((rating) => Array.from({ length: 20 }, (_, index) => usefulReview(index, { rating })));
  const result = calculateTrustScoreV31(reviews, {
    sampling: { strategy: 'parallel-star-filters', randomized: true, perStarLimit: 20 }
  });
  assert.equal(result.sampling.randomized, true);
  assert.equal(result.sampling.populationInferenceEnabled, false);
  assert.ok(result.defects.tests.every((item) => item.pValue === null));
});

test('trạng thái xác minh không làm lệch điểm nội dung giữa các provider', () => {
  const base = Array.from({ length: 20 }, (_, index) => usefulReview(index, {
    text: 'Trải nghiệm sử dụng đủ rõ về độ bền và cách vận hành sản phẩm.',
    labels: { information_value: 'high' }
  }));
  const unknown = calculateTrustScoreV31(base.map((review) => ({ ...review, verified: null })));
  const explicitlyUnverified = calculateTrustScoreV31(base.map((review) => ({ ...review, verified: false })));
  assert.equal(unknown.components.text.score, explicitlyUnverified.components.text.score);
  assert.equal(unknown.sample.verification.unknown, 20);
  assert.equal(explicitlyUnverified.sample.verification.unverified, 20);
});

test('không đủ dữ liệu ngày thì không gán điểm thời gian mặc định', () => {
  const reviews = Array.from({ length: 20 }, (_, index) => usefulReview(index));
  const result = calculateTrustScoreV31(reviews);
  assert.equal(result.temporal.score, null);
  assert.equal(result.temporal.status, 'unavailable');
});

test('ngày không tồn tại không được tính vào độ phủ thời gian', () => {
  const reviews = Array.from({ length: 20 }, (_, index) => usefulReview(index, { date: '31/02/2025' }));
  const result = calculateTrustScoreV31(reviews);
  assert.equal(result.temporal.coverage, 0);
  assert.equal(result.temporal.status, 'unavailable');
});
