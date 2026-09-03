import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function safeSegment(value, fallback = 'unknown') {
  const normalized = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return normalized || fallback;
}

function createRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${stamp}-${randomUUID()}`;
}

function datasetEnvelope({ kind, runId, createdAt, product, source, reviews, labeling }) {
  return {
    schemaVersion: '1.0.0',
    datasetKind: kind,
    runId,
    createdAt,
    product: {
      platform: product?.platform || null,
      url: product?.url || null,
      originalUrl: product?.originalUrl || null,
      shopId: product?.shopId || null,
      itemId: product?.itemId || null,
      title: product?.title || null,
      category: product?.category || null
    },
    source: source || null,
    labeling: labeling || null,
    reviewCount: reviews.length,
    reviews
  };
}

function rawReview(review) {
  return {
    reviewId: review.reviewId || null,
    itemId: review.itemId || null,
    authorId: review.authorId || null,
    rating: Number(review.rating) || 0,
    text: String(review.text || ''),
    date: review.date || null,
    createdAt: review.createdAt || null,
    verified: typeof review.verified === 'boolean' ? review.verified : null,
    author: review.author || null
  };
}

function classifiedReview(review) {
  return {
    ...rawReview(review),
    labelId: review.labelId || null,
    labels: review.labels || null,
    labeling: review.labeling || null,
    included: review.included !== false,
    exclusionReason: review.exclusionReason || null
  };
}

async function saveLocally(pathPrefix, rawJson, labeledJson, options = {}) {
  const root = options.localRoot || process.env.REVIEW_DATA_DIR || join(process.cwd(), 'data', 'review-runs');
  const directory = join(root, ...pathPrefix.split('/'));
  await mkdir(directory, { recursive: true });
  const rawPath = join(directory, 'reviews.raw.json');
  const labeledPath = join(directory, 'reviews.labeled.json');
  await Promise.all([
    writeFile(rawPath, rawJson, { encoding: 'utf8', flag: 'wx' }),
    writeFile(labeledPath, labeledJson, { encoding: 'utf8', flag: 'wx' })
  ]);
  return { provider: 'local-filesystem', rawPath, labeledPath };
}

async function saveToVercelBlob(pathPrefix, rawJson, labeledJson) {
  const { put } = await import('@vercel/blob');
  const common = {
    access: 'private',
    addRandomSuffix: false,
    contentType: 'application/json; charset=utf-8',
    token: process.env.BLOB_READ_WRITE_TOKEN
  };
  const [raw, labeled] = await Promise.all([
    put(`review-datasets/${pathPrefix}/reviews.raw.json`, rawJson, common),
    put(`review-datasets/${pathPrefix}/reviews.labeled.json`, labeledJson, common)
  ]);
  return {
    provider: 'vercel-blob-private',
    rawPath: raw.pathname,
    labeledPath: labeled.pathname,
    rawUrl: raw.url,
    labeledUrl: labeled.url
  };
}

export async function saveReviewDatasets({ rawReviews = [], labeledReviews = [], product = {}, source = null, labeling = null }, options = {}) {
  const now = options.now || new Date();
  const runId = options.runId || createRunId(now);
  const createdAt = now.toISOString();
  const datePath = createdAt.slice(0, 10).replaceAll('-', '/');
  const productKey = product.platform === 'TikTok Shop' && product.productId
    ? `tiktok-${safeSegment(product.productId)}`
    : product.itemId
      ? `shopee-${safeSegment(product.itemId)}`
      : safeSegment(product.title, 'product');
  const pathPrefix = `${datePath}/${productKey}/${runId}`;
  const rawDataset = datasetEnvelope({
    kind: 'raw-reviews', runId, createdAt, product, source,
    reviews: rawReviews.map(rawReview)
  });
  const labeledDataset = datasetEnvelope({
    kind: 'labeled-reviews', runId, createdAt, product, source, labeling,
    reviews: labeledReviews.map(classifiedReview)
  });
  const rawJson = `${JSON.stringify(rawDataset, null, 2)}\n`;
  const labeledJson = `${JSON.stringify(labeledDataset, null, 2)}\n`;

  try {
    const location = process.env.VERCEL
      ? process.env.BLOB_READ_WRITE_TOKEN
        ? await saveToVercelBlob(pathPrefix, rawJson, labeledJson)
        : null
      : await saveLocally(pathPrefix, rawJson, labeledJson, options);
    if (!location) {
      return {
        saved: false,
        runId,
        provider: 'none',
        warning: 'Đang chạy trên Vercel nhưng chưa có BLOB_READ_WRITE_TOKEN; dataset không thể lưu bền vững.'
      };
    }
    return { saved: true, runId, ...location };
  } catch (error) {
    return {
      saved: false,
      runId,
      provider: process.env.VERCEL ? 'vercel-blob-private' : 'local-filesystem',
      warning: `Không lưu được dataset: ${error?.message || 'lỗi không xác định'}`
    };
  }
}
