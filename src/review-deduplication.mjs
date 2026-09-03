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

// Max 100 review/lượt nên phép so sánh O(n²) vẫn nhỏ, đồng thời tránh thêm
// dependency hoặc mô hình embedding chỉ để nhận diện nội dung sao chép.
export function annotateReviewDuplicates(reviews = [], options = {}) {
  const threshold = Number.isFinite(Number(options.threshold)) ? Number(options.threshold) : 0.86;
  const minimumLength = Number.isFinite(Number(options.minimumLength)) ? Number(options.minimumLength) : 30;
  const representatives = [];
  let duplicateCount = 0;

  const annotated = reviews.map((review, index) => {
    const normalized = normalizeContent(review?.text);
    const current = { normalized, shingles: wordShingles(normalized) };
    let duplicate = null;
    if (normalized.length >= minimumLength) {
      for (const representative of representatives) {
        const similarity = duplicateSimilarity(current, representative);
        if (similarity >= threshold) {
          duplicate = { index: representative.index, similarity };
          break;
        }
      }
    }

    if (!duplicate) {
      if (normalized.length >= minimumLength) representatives.push({ ...current, index });
      return review;
    }

    duplicateCount += 1;
    const duplicateOf = reviews[duplicate.index]?.labelId || `r${String(duplicate.index + 1).padStart(4, '0')}`;
    const final = {
      ...(review.labels || {}),
      is_duplicate: true,
      duplicate_of: duplicateOf,
      duplicate_similarity: Number(duplicate.similarity.toFixed(4)),
      reason_code: 'DUPLICATE_CONTENT'
    };
    return {
      ...review,
      labels: final,
      labeling: review.labeling ? { ...review.labeling, final } : review.labeling
    };
  });

  return { reviews: annotated, duplicateCount };
}

export { normalizeContent as normalizeReviewContent };
