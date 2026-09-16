import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRedisConfigured, redisCommand } from './redis-rest.mjs';

const BUNDLE_SCHEMA_VERSION = '2.0.0';
const DATASET_DEDUPE_TTL_SECONDS = 5 * 24 * 60 * 60;
const DATASET_WRITE_LOCK_SECONDS = 120;
const DATASET_WRITE_WAIT_MS = 2_000;
const DATASET_WRITE_POLL_MS = 100;

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
      productId: product?.productId || null,
      title: product?.title || null,
      category: product?.category || null,
      categoryPath: product?.categoryPath || null,
      domainResolution: product?.domainResolution || null,
      image: product?.image || null,
      price: product?.price || null,
      rating: product?.rating || null
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

function datasetBundle({ runId, createdAt, product, rawDataset, labeledDataset }) {
  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    datasetKind: 'review-dataset-bundle',
    runId,
    createdAt,
    product: rawDataset.product,
    rawDataset,
    labeledDataset
  };
}

function datasetFingerprint(product, rawDataset) {
  const identity = product?.platform === 'TikTok Shop'
    ? `tiktok:${product?.productId || ''}`
    : `shopee:${product?.itemId || ''}`;
  const reviews = rawDataset.reviews.map((review) => ({
    reviewId: review.reviewId,
    itemId: review.itemId,
    authorId: review.authorId,
    rating: review.rating,
    text: review.text,
    date: review.date,
    createdAt: review.createdAt
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const canonical = JSON.stringify({
    identity,
    collection: rawDataset.source?.collection || null,
    reviews
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

function dedupeResultKey(fingerprint) {
  return `realview:dataset:write:v2:${fingerprint}`;
}

function dedupeLockKey(fingerprint) {
  return `${dedupeResultKey(fingerprint)}:lock`;
}

function parseJson(value) {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}

async function waitForDedupeResult(fingerprint, options = {}) {
  const deadline = Date.now() + (options.datasetWriteWaitMs ?? DATASET_WRITE_WAIT_MS);
  const sleep = options.sleepImpl || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  do {
    const value = await redisCommand(['GET', dedupeResultKey(fingerprint)], {
      fetchImpl: options.redisFetchImpl,
      timeoutMs: 1_200
    }).catch(() => null);
    const location = parseJson(value);
    if (location?.bundlePath || location?.rawPath) return location;
    await sleep(options.datasetWritePollMs ?? DATASET_WRITE_POLL_MS);
  } while (Date.now() < deadline);
  return null;
}

async function releaseOwnedDedupeLock(fingerprint, lockId, options = {}) {
  if (!fingerprint || !lockId) return;
  const activeLock = await redisCommand(['GET', dedupeLockKey(fingerprint)], {
    fetchImpl: options.redisFetchImpl,
    timeoutMs: 1_200
  }).catch(() => null);
  if (activeLock !== lockId) return;
  await redisCommand(['DEL', dedupeLockKey(fingerprint)], {
    fetchImpl: options.redisFetchImpl,
    timeoutMs: 1_200
  }).catch(() => null);
}

async function saveLocally(pathPrefix, bundleJson, options = {}) {
  const root = options.localRoot || process.env.REVIEW_DATA_DIR || join(process.cwd(), 'data', 'review-runs');
  const directory = join(root, ...pathPrefix.split('/'));
  await mkdir(directory, { recursive: true });
  const bundlePath = join(directory, 'reviews.dataset.json');
  await writeFile(bundlePath, bundleJson, { encoding: 'utf8', flag: 'wx' });
  return {
    provider: 'local-filesystem',
    bundlePath,
    rawPath: bundlePath,
    labeledPath: bundlePath,
    blobOperations: 0
  };
}

async function saveToVercelBlob(pathPrefix, bundleJson, fingerprint, options = {}) {
  const put = options.blobPutImpl || (await import('@vercel/blob')).put;
  const common = {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json; charset=utf-8',
    token: options.blobToken || process.env.BLOB_READ_WRITE_TOKEN
  };
  const bundle = await put(`review-datasets/${pathPrefix}/reviews.dataset.json`, bundleJson, common);
  return {
    provider: 'vercel-blob-private',
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    fingerprint,
    bundlePath: bundle.pathname,
    bundleUrl: bundle.url,
    // Aliases keep v1 cache callers working while readers learn schema v2.
    rawPath: bundle.pathname,
    labeledPath: bundle.pathname,
    rawUrl: bundle.url,
    labeledUrl: bundle.url,
    blobOperations: 1
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
  const bundle = datasetBundle({ runId, createdAt, product, rawDataset, labeledDataset });
  const bundleJson = `${JSON.stringify(bundle)}\n`;
  const fingerprint = datasetFingerprint(product, rawDataset);
  const storagePathPrefix = `${datePath}/${productKey}/${fingerprint}`;
  let claimedLockId = null;

  try {
    let location;
    const blobEnabled = process.env.VERCEL && (options.blobToken || process.env.BLOB_READ_WRITE_TOKEN);
    if (blobEnabled) {
      const redisEnabled = isRedisConfigured() || options.redisFetchImpl;
      if (redisEnabled) {
        const existing = parseJson(await redisCommand(['GET', dedupeResultKey(fingerprint)], {
          fetchImpl: options.redisFetchImpl,
          timeoutMs: 1_200
        }).catch(() => null));
        if (existing?.bundlePath || existing?.rawPath) {
          location = { ...existing, reused: true, blobOperations: 0 };
        } else {
          claimedLockId = randomUUID();
          const claimed = await redisCommand([
            'SET', dedupeLockKey(fingerprint), claimedLockId, 'NX', 'EX', String(DATASET_WRITE_LOCK_SECONDS)
          ], {
            fetchImpl: options.redisFetchImpl,
            timeoutMs: 1_200
          }).catch(() => null);
          if (!claimed) {
            const reused = await waitForDedupeResult(fingerprint, options);
            if (reused) location = { ...reused, reused: true, blobOperations: 0 };
            else {
              return {
                saved: false,
                reused: true,
                runId,
                provider: 'vercel-blob-write-in-progress',
                warning: 'Dataset của sản phẩm đang được một request khác lưu; không tạo bản trùng.'
              };
            }
          }
        }
      }
      if (!location) {
        location = await saveToVercelBlob(storagePathPrefix, bundleJson, fingerprint, options);
        location = { ...location, storedRunId: runId, storedCreatedAt: createdAt };
        if (redisEnabled) {
          await redisCommand([
            'SET', dedupeResultKey(fingerprint), JSON.stringify(location), 'EX', String(DATASET_DEDUPE_TTL_SECONDS)
          ], {
            fetchImpl: options.redisFetchImpl,
            timeoutMs: 1_200
          }).catch(() => null);
          await releaseOwnedDedupeLock(fingerprint, claimedLockId, options);
          claimedLockId = null;
        }
      }
    } else if (process.env.VERCEL) {
      location = null;
    } else {
      location = await saveLocally(pathPrefix, bundleJson, options);
    }
    if (!location) {
      return {
        saved: false,
        runId,
        provider: 'none',
        warning: 'Đang chạy trên Vercel nhưng chưa có BLOB_READ_WRITE_TOKEN; dataset không thể lưu bền vững.'
      };
    }
    const effectiveRunId = location.storedRunId || runId;
    const effectiveCreatedAt = location.storedCreatedAt || createdAt;
    const effectiveRawDataset = location.reused
      ? { ...rawDataset, runId: effectiveRunId, createdAt: effectiveCreatedAt }
      : rawDataset;
    return {
      saved: true,
      runId: effectiveRunId,
      createdAt: effectiveCreatedAt,
      rawDataset: effectiveRawDataset,
      ...location
    };
  } catch (error) {
    await releaseOwnedDedupeLock(fingerprint, claimedLockId, options);
    return {
      saved: false,
      runId,
      provider: process.env.VERCEL ? 'vercel-blob-private' : 'local-filesystem',
      warning: `Không lưu được dataset: ${error?.message || 'lỗi không xác định'}`
    };
  }
}
