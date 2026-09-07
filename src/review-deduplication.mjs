function normalizeContent(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordShingles(text, size = 3) {
  const words = text.split(' ').filter(Boolean);
  const shingles = new Set();
  for (let index = 0; index <= words.length - size; index += 1) {
    shingles.add(words.slice(index, index + size).join(' '));
  }
  return shingles;
}

function jaccard(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function duplicateSimilarity(current, previous) {
  if (!current.normalized || !previous.normalized) return 0;
  if (current.normalized === previous.normalized) return 1;
  const lengthRatio = Math.min(current.normalized.length, previous.normalized.length)
    / Math.max(current.normalized.length, previous.normalized.length);
  if (lengthRatio < 0.8 || current.shingles.size < 4 || previous.shingles.size < 4) return 0;
  return jaccard(current.shingles, previous.shingles);
}

function reviewIdentifier(review, index) {
  return review?.labelId || review?.reviewId || review?.id || `r${String(index + 1).padStart(4, '0')}`;
}

function semanticFingerprint(review = {}) {
  const labels = review?.labeling?.final || review?.labels || {};
  return JSON.stringify({
    included: review?.included === false ? false : true,
    isSeeding: Boolean(labels.is_seeding),
    isVague: Boolean(labels.is_vague),
    isLowValue: Boolean(labels.is_low_value),
    isOffTopic: Boolean(labels.is_off_topic || labels.relevance === 'off_topic'),
    hardReject: Boolean(labels.hard_reject),
    layer2Unavailable: Boolean(labels.layer2_unavailable),
    informationValue: String(labels.information_value || '').toLowerCase(),
    hasDefect: Boolean(labels.has_defect),
    defectCategories: Array.isArray(labels.defect_categories)
      ? [...new Set(labels.defect_categories.map(String))].sort()
      : []
  });
}

function stableReviewKey(review, normalized) {
  return [
    normalized,
    review?.authorId || '',
    review?.reviewId || review?.id || review?.itemId || '',
    review?.createdAt || review?.date || '',
    Number.isFinite(Number(review?.rating)) ? String(Number(review.rating)).padStart(2, '0') : '',
    semanticFingerprint(review),
    review?.labelId || ''
  ].map(String).join('\u0000');
}

function clearDuplicateMarkers(review = {}) {
  const labels = { ...(review?.labels || {}) };
  delete labels.is_duplicate;
  delete labels.duplicate_of;
  delete labels.duplicate_similarity;
  delete labels.duplicate_rating_conflict;
  delete labels.duplicate_semantic_conflict;
  if (['DUPLICATE_CONTENT', 'DUPLICATE_RATING_CONFLICT', 'DUPLICATE_SEMANTIC_CONFLICT'].includes(labels.reason_code)) {
    delete labels.reason_code;
  }
  const labeling = review?.labeling
    ? { ...review.labeling, final: review.labeling.final ? { ...review.labeling.final } : review.labeling.final }
    : review?.labeling;
  if (labeling?.final) {
    delete labeling.final.is_duplicate;
    delete labeling.final.duplicate_of;
    delete labeling.final.duplicate_similarity;
    delete labeling.final.duplicate_rating_conflict;
    delete labeling.final.duplicate_semantic_conflict;
    if (['DUPLICATE_CONTENT', 'DUPLICATE_RATING_CONFLICT', 'DUPLICATE_SEMANTIC_CONFLICT'].includes(labeling.final.reason_code)) {
      delete labeling.final.reason_code;
    }
  }
  return { ...review, labels, labeling };
}

function ratingBucket(review) {
  const rating = Number(review?.rating);
  return Number.isInteger(rating) && rating >= 1 && rating <= 5 ? String(rating) : 'unknown';
}

// Max 100 review/lượt nên phép so sánh O(n²) vẫn nhỏ, đồng thời tránh thêm
// dependency hoặc mô hình embedding chỉ để nhận diện nội dung sao chép.
export function annotateReviewDuplicates(reviews = [], options = {}) {
  const threshold = Number.isFinite(Number(options.threshold)) ? Number(options.threshold) : 0.86;
  const minimumLength = Number.isFinite(Number(options.minimumLength)) ? Number(options.minimumLength) : 30;
  const cleanReviews = reviews.map(clearDuplicateMarkers);
  const candidates = cleanReviews.map((review, index) => {
    const normalized = normalizeContent(review?.text);
    return {
      review,
      index,
      normalized,
      shingles: wordShingles(normalized),
      stableKey: stableReviewKey(review, normalized)
    };
  }).sort((left, right) => {
    if (left.stableKey < right.stableKey) return -1;
    if (left.stableKey > right.stableKey) return 1;
    return left.index - right.index;
  });
  const representatives = [];
  const exactRepresentatives = new Map();
  const groups = new Map();
  const duplicateMatches = new Map();

  for (const current of candidates) {
    let duplicate = null;
    const exactRepresentative = current.normalized ? exactRepresentatives.get(current.normalized) : undefined;
    if (exactRepresentative) {
      duplicate = { representative: exactRepresentative, similarity: 1 };
    } else if (current.normalized.length >= minimumLength) {
      for (const representative of representatives) {
        const similarity = duplicateSimilarity(current, representative);
        if (similarity >= threshold) {
          duplicate = { representative, similarity };
          break;
        }
      }
    }

    if (!duplicate) {
      if (current.normalized) exactRepresentatives.set(current.normalized, current);
      if (current.normalized.length >= minimumLength) representatives.push(current);
      groups.set(current.index, [current.index]);
      continue;
    }
    duplicateMatches.set(current.index, {
      representativeIndex: duplicate.representative.index,
      similarity: duplicate.similarity
    });
    groups.get(duplicate.representative.index).push(current.index);
  }

  const duplicateMetadata = new Map();
  for (const [representativeIndex, memberIndexes] of groups) {
    if (memberIndexes.length < 2) continue;
    const ratingConflict = new Set(memberIndexes.map((index) => ratingBucket(cleanReviews[index]))).size > 1;
    const semanticConflict = new Set(memberIndexes.map((index) => semanticFingerprint(cleanReviews[index]))).size > 1;
    const duplicateOf = String(reviewIdentifier(cleanReviews[representativeIndex], representativeIndex));
    for (const index of memberIndexes) {
      if (!ratingConflict && !semanticConflict && index === representativeIndex) continue;
      const match = duplicateMatches.get(index);
      duplicateMetadata.set(index, {
        is_duplicate: true,
        duplicate_of: duplicateOf,
        duplicate_similarity: Number((match?.similarity ?? 1).toFixed(4)),
        duplicate_rating_conflict: ratingConflict,
        duplicate_semantic_conflict: semanticConflict,
        reason_code: ratingConflict
          ? 'DUPLICATE_RATING_CONFLICT'
          : semanticConflict
            ? 'DUPLICATE_SEMANTIC_CONFLICT'
            : 'DUPLICATE_CONTENT'
      });
    }
  }

  const annotated = cleanReviews.map((review, index) => {
    const metadata = duplicateMetadata.get(index);
    if (!metadata) return review;
    const final = { ...(review.labels || {}), ...metadata };
    return {
      ...review,
      labels: final,
      labeling: review.labeling ? { ...review.labeling, final } : review.labeling
    };
  });

  return { reviews: annotated, duplicateCount: duplicateMetadata.size };
}

export { normalizeContent as normalizeReviewContent };
