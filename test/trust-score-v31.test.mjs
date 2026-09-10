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

test('TrustScore v4.2 tính chất lượng ba thành phần rồi điều chỉnh độ phủ đúng một lần', () => {
  const combined = combineTrustComponents({ text: 80, authenticity: 60, labeling: 100, adequacy: 40 });
  assert.equal(combined.qualityScore, 80);
  assert.equal(combined.rawScore, 62);
  assert.equal(combined.score, 62);
  assert.deepEqual(Object.values(combined.components).map((item) => item.weight), [1 / 3, 1 / 3, 1 / 3, 0]);
  assert.equal(combined.components.adequacy.active, false);
  assert.equal(combined.guardrails.totalPenalty, 18);
  assert.equal(combined.guardrails.method, 'one-sided-coverage-shrinkage');
  assert.equal(combined.caps.deprecated, true);
  assert.equal(combined.caps.applied.length, 0);
});

test('độ phủ không được nâng điểm chất lượng thấp về mức trung lập', () => {
  const combined = combineTrustComponents({ text: 40, authenticity: 40, labeling: 40, adequacy: 10 });
  assert.equal(combined.qualityScore, 40);
  assert.equal(combined.rawScore, 40);
  assert.equal(combined.score, 40);
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
  assert.equal(result.scoreStatus, 'limited');
  assert.ok(Number.isFinite(result.score));
  assert.ok(result.score <= 51);
});

test('một tài khoản lặp nhiều dòng không lấn át điểm chất lượng của contributor khác', () => {
  const repeatedHigh = Array.from({ length: 20 }, (_, index) => usefulReview(index, {
    authorId: 'repeated-buyer',
    text: `Review rất chi tiết số ${index + 1} về trải nghiệm, độ bền, chất liệu và cách dùng thực tế.`
  }));
  const oneLow = usefulReview(21, {
    authorId: 'second-buyer',
    text: 'x',
    labels: { information_value: 'none' }
  });
  const result = calculateTrustScoreV31([...repeatedHigh, oneLow]);

  assert.ok(result.components.text.score > 49 && result.components.text.score < 51);
  assert.equal(result.sample.distinctContributorEvidenceSize, 2);
});

test('một tài khoản xuất hiện ở nhiều tầng chỉ đóng góp một đơn vị độ phủ', () => {
  const reviews = [1, 2, 3, 4, 5].flatMap((rating) => Array.from(
    { length: 4 },
    (_, index) => usefulReview(index, { rating, authorId: 'same-buyer' })
  ));
  const result = calculateTrustScoreV31(reviews, {
    sampling: { strategy: 'parallel-star-filters', perStarLimit: 20 }
  });

  assert.ok(Math.abs(result.sample.distinctContributorCoverageSize - 1) < 1e-12);
  assert.ok(Math.abs(result.adequacy.coveredSampleSlots - 1) < 1e-12);
  assert.ok(Math.abs(result.adequacy.coverage - 0.01) < 1e-12);
  assert.equal(result.scoreStatus, 'limited');
  assert.ok(Number.isFinite(result.score));
});

test('mẫu chia tầng không được giả là phân bố rating tự nhiên', () => {
  const reviews = [5, 4, 3, 2, 1].flatMap((rating) => Array.from({ length: 20 }, (_, index) => usefulReview(index, { rating })));
  const result = calculateTrustScoreV31(reviews, { sampling: { strategy: 'parallel-star-filters', perStarLimit: 20 } });
  assert.equal(result.sampling.controlledStarStrata, true);
  assert.equal(result.sampling.populationInferenceEnabled, false);
  assert.equal(result.fisher.positive.pValue, null);
  assert.equal(result.fisher.negative.pValue, null);
  assert.ok(Math.abs(result.adequacy.balancedEvidenceSize - 100) < 1e-10);
  assert.equal(result.adequacy.effectiveSampleSizeDeprecated, true);
  assert.equal(result.sample.statisticalPopulation, 100);
  assert.equal(result.sample.excludedBySamplingDesign, 0);
  assert.deepEqual(result.adequacy.missingRatings, []);
});

test('TikTok raw cache từ actor tạm được tính như mẫu quan sát không phân tầng', () => {
  const reviews = Array.from({ length: 20 }, (_, index) => usefulReview(index, {
    rating: index < 18 ? 5 : 4
  }));
  const result = calculateTrustScoreV31(reviews, {
    sampling: {
      strategy: 'single-unfiltered',
      samplingStrategy: 'most-recent-100',
      distributionMode: 'observed-sample',
      ratingStrata: null,
      ratingStrataRequired: false
    }
  });
  assert.equal(result.sampling.controlledStarStrata, false);
  assert.equal(result.sampling.distributionMode, 'observed-sample');
  assert.equal(result.sampling.perStarLimit, null);
  assert.equal(result.sample.excludedBySamplingDesign, 0);
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
    sampling: { strategy: 'parallel-star-filters', ratingStrata: [1, 3, 5], perStarLimit: 20 }
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

test('thiếu một số tầng chuẩn vẫn tính TrustScore khi đã có ít nhất 20 review chữ', () => {
  const reviews = [2, 3, 4, 5].flatMap((rating) => Array.from({ length: 20 }, (_, index) => usefulReview(index, { rating })));
  const result = calculateTrustScoreV31(reviews, { sampling: { strategy: 'parallel-star-filters', perStarLimit: 20 } });
  assert.ok(typeof result.score === 'number' && result.score > 0);
  assert.ok(typeof result.rawScore === 'number');
  assert.equal(result.scoreStatus, 'provisional');
  assert.deepEqual(result.adequacy.missingRatings, [1]);
});

test('không có bằng chứng không được mặc định thành điểm cao', () => {
  const reviews = Array.from({ length: 20 }, (_, index) => usefulReview(index, {
    included: false, labels: { is_low_value: true, information_value: 'none' }
  }));
  const result = calculateTrustScoreV31(reviews);
  assert.equal(result.score, 33);
  assert.equal(result.scoreStatus, 'limited');
  assert.equal(result.components.text.score, 0);
  assert.equal(result.components.authenticity.score, 0);
});

test('coverage dùng đủ mẫu số thiết kế và không cho tầng dư bù tầng thiếu', () => {
  const build = (counts) => counts.flatMap((count, ratingIndex) => Array.from(
    { length: count },
    (_, index) => usefulReview(index, { rating: ratingIndex + 1, authorId: `${ratingIndex + 1}-${index}` })
  ));
  const one = calculateTrustScoreV31(build([20, 0, 0, 0, 0]), {
    sampling: { strategy: 'parallel-star-filters', perStarLimit: 20 }
  });
  const four = calculateTrustScoreV31(build([20, 20, 20, 20, 0]), {
    sampling: { strategy: 'parallel-star-filters', perStarLimit: 20 }
  });
  const five = calculateTrustScoreV31(build([20, 20, 20, 20, 20]), {
    sampling: { strategy: 'parallel-star-filters', perStarLimit: 20 }
  });

  assert.ok(Math.abs(one.adequacy.coverage - 0.2) < 1e-12);
  assert.equal(one.score, 60);
  assert.equal(one.scoreStatus, 'limited');
  assert.ok(Math.abs(four.adequacy.coverage - 0.8) < 1e-12);
  assert.equal(four.score, 90);
  assert.equal(four.scoreStatus, 'provisional');
  assert.equal(five.adequacy.coverage, 1);
  assert.equal(five.score, 100);
  assert.equal(five.scoreStatus, 'valid');
});

test('xóa tầng mỏng không còn làm độ phủ hoặc TrustScore tăng', () => {
  const build = (counts) => counts.flatMap((count, ratingIndex) => Array.from(
    { length: count },
    (_, index) => usefulReview(index, { rating: ratingIndex + 1, authorId: `${ratingIndex + 1}-${index}` })
  ));
  const withThinStratum = calculateTrustScoreV31(build([20, 20, 20, 20, 1]), {
    sampling: { strategy: 'parallel-star-filters', perStarLimit: 20 }
  });
  const withoutThinStratum = calculateTrustScoreV31(build([20, 20, 20, 20, 0]), {
    sampling: { strategy: 'parallel-star-filters', perStarLimit: 20 }
  });

  assert.ok(withThinStratum.adequacy.coverage > withoutThinStratum.adequacy.coverage);
  assert.ok(withThinStratum.rawScore > withoutThinStratum.rawScore);
  assert.equal(withThinStratum.scoreStatus, 'provisional');
  assert.deepEqual(withThinStratum.adequacy.thinRatings, [5]);
});

test('từ 20 review trở lên luôn trả điểm dù bằng chứng hoặc tầng sao bị thiếu', () => {
  const cases = [
    Array.from({ length: 20 }, (_, index) => usefulReview(index, { rating: 5 })),
    Array.from({ length: 20 }, (_, index) => usefulReview(index, {
      included: false, labels: { is_low_value: true, information_value: 'none' }
    })),
    Array.from({ length: 20 }, (_, index) => usefulReview(index, {
      labels: { layer2_unavailable: true }
    })),
    Array.from({ length: 20 }, (_, index) => usefulReview(index, {
      rating: 0, labels: { is_duplicate: true }
    }))
  ];

  for (const reviews of cases) {
    const result = calculateTrustScoreV31(reviews, {
      sampling: { strategy: 'parallel-star-filters', perStarLimit: 20 }
    });
    assert.ok(Number.isFinite(result.score));
    assert.ok(result.score >= 0 && result.score <= 100);
    assert.notEqual(result.scoreStatus, 'insufficient');
  }

  const tooSmall = calculateTrustScoreV31(cases[0].slice(0, 19), {
    sampling: { strategy: 'parallel-star-filters', perStarLimit: 20 }
  });
  assert.equal(tooSmall.score, null);
  assert.equal(tooSmall.scoreStatus, 'insufficient');
});

test('phần tử rỗng không được giả làm review để vượt ngưỡng 20', () => {
  const result = calculateTrustScoreV31([
    ...Array.from({ length: 19 }, (_, index) => usefulReview(index)),
    null,
    {},
    { text: '   ' }
  ]);
  assert.equal(result.sample.total, 19);
  assert.equal(result.score, null);
  assert.equal(result.scoreStatus, 'insufficient');
});

test('thêm một tầng toàn review bị loại không được làm TrustScore tăng', () => {
  const options = { sampling: { strategy: 'parallel-star-filters', ratingStrata: [1, 5], perStarLimit: 20 } };
  const clean = Array.from({ length: 20 }, (_, index) => usefulReview(index, {
    rating: 5, authorId: `clean-${index}`
  }));
  const rejected = Array.from({ length: 20 }, (_, index) => usefulReview(index, {
    rating: 1,
    authorId: `rejected-${index}`,
    included: false,
    labels: { is_low_value: true, information_value: 'none' }
  }));
  const before = calculateTrustScoreV31(clean, options);
  const after = calculateTrustScoreV31([...clean, ...rejected], options);

  assert.equal(before.adequacy.coverage, after.adequacy.coverage);
  assert.ok(after.components.text.score < before.components.text.score);
  assert.ok(after.rawScore <= before.rawScore);
  assert.deepEqual(after.adequacy.missingRatings, [1]);
});

test('thành phần chất lượng cân bằng theo tầng thay vì theo số review gộp', () => {
  const detailed = (count, rating) => Array.from({ length: count }, (_, index) => usefulReview(index, {
    rating,
    authorId: `d-${rating}-${index}`,
    text: 'Review mô tả rất chi tiết trải nghiệm sử dụng, độ bền, độ hoàn thiện và tình huống kiểm tra thực tế.',
    labels: { information_value: 'high' }
  }));
  const brief = (count, rating) => Array.from({ length: count }, (_, index) => usefulReview(index, {
    rating,
    authorId: `b-${rating}-${index}`,
    text: 'Ổn.',
    labels: { information_value: 'low' }
  }));
  const options = { sampling: { strategy: 'parallel-star-filters', perStarLimit: 20 } };
  const highStratumLarge = calculateTrustScoreV31([...detailed(20, 5), ...brief(1, 1)], options);
  const lowStratumLarge = calculateTrustScoreV31([...detailed(1, 5), ...brief(20, 1)], options);

  assert.ok(Math.abs(highStratumLarge.components.text.score - lowStratumLarge.components.text.score) < 1e-10);
  assert.ok(Math.abs(highStratumLarge.rawScore - lowStratumLarge.rawScore) < 1e-10);
});

test('coverage đơn điệu, hữu hạn và bất biến với hoán vị tầng trên nhiều cấu hình', () => {
  const build = (counts) => counts.flatMap((count, ratingIndex) => Array.from(
    { length: count },
    (_, index) => usefulReview(index, { rating: ratingIndex + 1, authorId: `${ratingIndex + 1}-${index}` })
  ));
  const options = { sampling: { strategy: 'parallel-star-filters', perStarLimit: 20 } };
  let seed = 20260906;
  for (let iteration = 0; iteration < 250; iteration += 1) {
    seed = (1664525 * seed + 1013904223) >>> 0;
    const counts = Array.from({ length: 5 }, (_value, index) => (seed >>> (index * 5)) % 21);
    const before = calculateTrustScoreV31(build(counts), options);
    const target = iteration % 5;
    const incremented = [...counts];
    incremented[target] += 1;
    const after = calculateTrustScoreV31(build(incremented), options);
    const permuted = calculateTrustScoreV31(build([...counts].reverse()), options);

    assert.ok(Number.isFinite(before.adequacy.coverage));
    assert.ok(before.adequacy.coverage >= 0 && before.adequacy.coverage <= 1);
    assert.ok(after.adequacy.coverage + 1e-12 >= before.adequacy.coverage);
    assert.ok(Math.abs(permuted.adequacy.coverage - before.adequacy.coverage) < 1e-12);
  }
});

test('không có cap 39 và điểm tăng liên tục theo độ phủ', () => {
  const scores = [20, 40, 60, 80, 100].map((adequacy) => combineTrustComponents({
    text: 100, authenticity: 100, labeling: 100, adequacy
  }));
  assert.deepEqual(scores.map(({ score }) => score), [60, 70, 80, 90, 100]);
  assert.ok(scores.every(({ caps }) => caps.applied.length === 0));
});

test('perStarLimit không hợp lệ quay về mốc 20 và không sinh NaN', () => {
  const reviews = Array.from({ length: 20 }, (_, index) => usefulReview(index, { rating: 5 }));
  for (const perStarLimit of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
    const result = calculateTrustScoreV31(reviews, {
      sampling: { strategy: 'parallel-star-filters', perStarLimit }
    });
    assert.equal(result.adequacy.targetSample, 100);
    assert.ok(Number.isFinite(result.score));
    assert.ok(Number.isFinite(result.adequacy.coverage));
  }
  const bounded = calculateTrustScoreV31(reviews, {
    sampling: { strategy: 'parallel-star-filters', perStarLimit: Number.MAX_VALUE }
  });
  assert.equal(bounded.adequacy.targetSample, 500);
  assert.ok(Number.isFinite(bounded.adequacy.coveredSampleSlots));
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
  const reviews = Array.from({ length: 20 }, (_, index) => usefulReview(index, { authorId: `buyer-${index}` }));
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

test('review ẩn danh chỉ dùng mô tả, không giả định độc lập để chạy kiểm định', () => {
  const reviews = Array.from({ length: 20 }, (_, index) => usefulReview(index));
  const result = calculateTrustScoreV31(reviews, {
    sampling: { strategy: 'random', randomized: true }
  });
  assert.equal(result.sampling.populationInferenceEnabled, false);
  assert.equal(result.sampling.populationInferenceDisabledReason, 'unknown-contributor-identity');
  assert.equal(result.fisher.positive.pValue, null);
  assert.ok(Number.isFinite(result.score));
});

test('suy luận tổng thể tự tắt khi cùng contributor xuất hiện nhiều lần', () => {
  const ids = ['chat-lieu', 'kich-co', 'dung-mo-ta', 'giao-hang', 'su-dung'];
  const baselines = { calibrated: true, source: 'test', values: { general: Object.fromEntries(ids.map((id) => [id, 0.04])) } };
  const reviews = Array.from({ length: 20 }, (_, index) => usefulReview(index, {
    authorId: index < 2 ? 'repeated-buyer' : `buyer-${index}`
  }));
  const result = calculateTrustScoreV31(reviews, {
    category: 'general', baselines, sampling: { strategy: 'random', randomized: true }
  });

  assert.equal(result.sampling.populationInferenceRequested, true);
  assert.equal(result.sampling.populationInferenceEnabled, false);
  assert.equal(result.sampling.populationInferenceDisabledReason, 'repeated-contributor');
  assert.equal(result.fisher.positive.pValue, null);
  assert.ok(result.defects.tests.every((item) => item.pValue === null));
});

test('cờ randomized không bật suy luận tổng thể khi mẫu vẫn chia tầng sao', () => {
  const reviews = [1, 2, 3, 4, 5].flatMap((rating) => Array.from({ length: 20 }, (_, index) => usefulReview(index, { rating })));
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
