import { createHash } from 'node:crypto';
import { finalizeTikTokCostCredential, reserveTikTokCostCredentials } from './apify-credential-store.mjs';
import { createProgressReporter } from './sse.mjs';
import { timeoutAbortSignal } from './abort.mjs';
import { tikTokActorAdapter } from './apify-tiktok-adapters.mjs';
import {
  classifyApifyFailure,
  resolveTikTokRuntimeConfig,
  TIKTOK_DEFAULT_REVIEW_LIMIT
} from './apify-tiktok-runtime.mjs';
import { assertTikTokCircuitClosed, recordTikTokActorHealth } from './apify-tiktok-health.mjs';
import { MINIMUM_REVIEWS_FOR_ANALYSIS } from './analysis-eligibility.mjs';

const STAR_FILTERS = Object.freeze(['5_star', '4_star', '3_star', '2_star', '1_star']);
const REVIEWS_PER_STAR = TIKTOK_DEFAULT_REVIEW_LIMIT / STAR_FILTERS.length;
const APIFY_TERMINAL_RUN_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);
const DEFAULT_PROGRESSIVE_POLL_INTERVAL_MS = 850;

function actorPath(actorId) {
  return encodeURIComponent(String(actorId).trim().replace('/', '~'));
}

function compactErrorDetail(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function reviewKey(review) {
  const id = review?.review_id ?? review?.reviewId;
  if (id !== undefined && id !== null && String(id)) return `id:${id}`;
  return `hash:${createHash('sha256').update([
    review?.product_id || '', review?.reviewer_id || review?.reviewer_name || '', review?.review_time || '',
    review?.review_rating || '', review?.review_text || ''
  ].join('|')).digest('hex')}`;
}

function normalizeCreatedAt(value) {
  if (value === undefined || value === null || value === '') return null;
  const raw = String(value).trim();
  const timestamp = /^\d{10,13}$/.test(raw)
    ? Number(raw) * (raw.length <= 10 ? 1000 : 1)
    : raw;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeReview(review, productId) {
  const createdAt = normalizeCreatedAt(review.review_time);
  const verificationValue = review.is_verified_purchase ?? review.isVerifiedPurchase ?? review.verified;
  return {
    reviewId: review.review_id !== undefined && review.review_id !== null ? String(review.review_id) : null,
    itemId: review.product_id !== undefined && review.product_id !== null ? String(review.product_id) : String(productId),
    authorId: review.reviewer_id !== undefined && review.reviewer_id !== null ? String(review.reviewer_id) : null,
    rating: Number(review.review_rating) || 0,
    text: String(review.review_text || '').trim(),
    date: createdAt ? new Date(createdAt).toLocaleDateString('vi-VN') : 'Không rõ ngày',
    createdAt,
    // Provider không trả trường xác minh thì giữ null, không suy diễn thành false.
    verified: typeof verificationValue === 'boolean' ? verificationValue : null,
    author: review.reviewer_name || review.user_name || 'Khách đã mua'
  };
}

function sortReviewsMostRecent(reviews) {
  return reviews.sort((left, right) => {
    const leftTime = Date.parse(left.createdAt || '') || 0;
    const rightTime = Date.parse(right.createdAt || '') || 0;
    return rightTime - leftTime;
  });
}

function ratingFromFilter(reviewFilter) {
  const match = String(reviewFilter || '').match(/^([1-5])_star$/);
  return match ? Number(match[1]) : null;
}

function retryAfterMs(response) {
  const raw = response?.headers?.get?.('retry-after');
  if (!raw) return 60_000;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(1_000, seconds * 1000);
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? Math.max(1_000, timestamp - Date.now()) : 60_000;
}

function apifyRunData(body) {
  return body?.data && typeof body.data === 'object' ? body.data : body;
}

function mergeProductMeta(current = {}, next = {}) {
  return {
    ...current,
    ...(!current.title && next.title ? { title: next.title } : {}),
    ...(!current.image && next.image ? { image: next.image } : {}),
    ...(!current.price && next.price ? { price: next.price } : {}),
    ...(!current.rating && next.rating ? { rating: next.rating } : {})
  };
}

function logTikTokCollection(event, payload = {}) {
  if (!process.env.VERCEL) return;
  console.log(JSON.stringify({ level: 'info', event, ...payload }));
}

function delay(ms, signal) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener?.('abort', abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(Object.assign(new Error('Đã dừng chờ Actor TikTok.'), { name: 'AbortError' }));
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener?.('abort', abort, { once: true });
  });
}

async function apifyRequest(fetchImpl, url, init, deadline, signal) {
  const remaining = Math.max(1, deadline - Date.now());
  const response = await fetchImpl(url, {
    ...init,
    signal: timeoutAbortSignal(remaining, signal)
  });
  if (!response.ok) {
    const detail = compactErrorDetail(await response.text());
    throw Object.assign(new Error(`Apify trả về HTTP ${response.status}${detail ? `: ${detail}` : ''}`), {
      statusCode: response.status,
      retryAfterMs: retryAfterMs(response)
    });
  }
  return response;
}

async function runActorSync({ productId, productUrl, reviewLimit, reviewFilter, credential, fetchImpl, runtime, timeoutMs, signal }) {
  const startedAt = performance.now();
  const adapter = tikTokActorAdapter(runtime);
  const endpoint = `https://api.apify.com/v2/acts/${actorPath(runtime.actorId)}/run-sync-get-dataset-items`;
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(adapter.buildInput({ productId, productUrl, reviewLimit, reviewFilter, runtime })),
      signal: timeoutAbortSignal(timeoutMs, signal)
    });
    if (!response.ok) {
      const detail = compactErrorDetail(await response.text());
      throw Object.assign(new Error(`Apify trả về HTTP ${response.status}${detail ? `: ${detail}` : ''}`), {
        statusCode: response.status,
        retryAfterMs: retryAfterMs(response)
      });
    }
    const datasetItems = await response.json();
    if (!Array.isArray(datasetItems)) throw new Error('Apify không trả về dataset TikTok hợp lệ.');
    const productMeta = adapter.extractProductMeta(datasetItems);
    const items = adapter.extractItems(datasetItems, productId);
    const expectedRating = ratingFromFilter(reviewFilter);
    const matching = expectedRating === null
      ? items
      : items.filter((item) => Number(item?.review_rating) === expectedRating);
    return {
      ok: true,
      credentialId: credential.id,
      credentialLabel: credential.label,
      runCount: credential.runCount ?? null,
      filter: reviewFilter,
      requested: reviewLimit,
      billedReviewCount: items.length,
      droppedWrongRating: items.length - matching.length,
      reviewCount: matching.filter((item) => String(item?.review_text || '').trim()).length,
      latencyMs: Math.round(performance.now() - startedAt),
      actorRunId: response.headers?.get?.('x-apify-run-id') || null,
      actorStarted: true,
      statusCode: response.status || 200,
      failureClass: null,
      productMeta,
      items: matching
    };
  } catch (error) {
    return {
      ok: false,
      credentialId: credential.id,
      credentialLabel: credential.label,
      runCount: credential.runCount ?? null,
      filter: reviewFilter,
      requested: reviewLimit,
      billedReviewCount: 0,
      reviewCount: 0,
      latencyMs: Math.round(performance.now() - startedAt),
      statusCode: error?.statusCode || null,
      failureClass: classifyApifyFailure(error?.statusCode, error),
      retryAfterMs: error?.retryAfterMs || 60_000,
      actorStarted: false,
      error: error?.message || 'Không lấy được reviews TikTok.',
      productMeta: {},
      items: []
    };
  }
}

async function runActorProgressive({
  productId,
  productUrl,
  reviewLimit,
  reviewFilter,
  credential,
  fetchImpl,
  runtime,
  timeoutMs,
  signal,
  progress,
  pollIntervalMs = DEFAULT_PROGRESSIVE_POLL_INTERVAL_MS,
  sleepImpl = delay
}) {
  const startedAt = performance.now();
  const wallStartedAt = Date.now();
  const deadline = wallStartedAt + timeoutMs;
  const adapter = tikTokActorAdapter(runtime);
  const actorEndpoint = `https://api.apify.com/v2/acts/${actorPath(runtime.actorId)}`;
  let actorRunId = null;
  let datasetId = null;
  let statusCode = null;
  let runStatus = 'READY';
  let datasetPollCount = 0;
  let rawDatasetItemCount = 0;
  let productMeta = {};
  let firstReviewAt = null;
  let targetReachedAt = null;
  let completionReason = null;
  let cacheable = false;
  let lastReportedCount = -1;
  const seen = new Map();

  const readDataset = async () => {
    if (!datasetId) return;
    const datasetResponse = await apifyRequest(fetchImpl,
      `https://api.apify.com/v2/datasets/${encodeURIComponent(datasetId)}/items?clean=true&limit=250000`,
      { headers: { authorization: `Bearer ${credential.token}` } }, deadline, signal);
    const datasetItems = await datasetResponse.json();
    if (!Array.isArray(datasetItems)) throw new Error('Apify không trả về dataset TikTok hợp lệ.');
    datasetPollCount += 1;
    rawDatasetItemCount = Math.max(rawDatasetItemCount, datasetItems.length);
    productMeta = mergeProductMeta(productMeta, adapter.extractProductMeta(datasetItems));
    for (const item of adapter.extractItems(datasetItems, productId)) {
      seen.set(reviewKey(item), item);
    }
    if (seen.size && firstReviewAt === null) {
      firstReviewAt = Date.now();
      logTikTokCollection('tiktok_dataset_first_item', {
        productId: String(productId), actorRunId, timeToFirstReviewMs: firstReviewAt - wallStartedAt
      });
    }
    if (seen.size !== lastReportedCount) {
      lastReportedCount = seen.size;
      const percent = 14 + Math.min(44, Math.round((seen.size / Math.max(1, reviewLimit)) * 44));
      progress?.('collecting', percent, `Đã nhận ${Math.min(seen.size, reviewLimit)}/${reviewLimit} review TikTok...`);
      logTikTokCollection('tiktok_dataset_progress', {
        productId: String(productId), actorRunId, datasetPollCount,
        rawDatasetItemCount, uniqueReviewCount: seen.size,
        elapsedMs: Date.now() - wallStartedAt
      });
    }
  };

  try {
    const startResponse = await apifyRequest(fetchImpl, `${actorEndpoint}/runs?waitForFinish=0`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(adapter.buildInput({ productId, productUrl, reviewLimit, reviewFilter, runtime }))
    }, deadline, signal);
    statusCode = startResponse.status || 201;
    let run = apifyRunData(await startResponse.json());
    actorRunId = String(run?.id || '') || null;
    datasetId = String(run?.defaultDatasetId || '') || null;
    runStatus = String(run?.status || 'READY').toUpperCase();
    if (!actorRunId) throw new Error('Apify không trả về mã run TikTok để theo dõi tiến độ.');
    logTikTokCollection('tiktok_actor_started', {
      productId: String(productId), actorRunId, datasetId, requested: reviewLimit
    });

    while (Date.now() < deadline) {
      await readDataset();
      if (seen.size >= reviewLimit) {
        targetReachedAt = Date.now();
        completionReason = 'target-reached';
        cacheable = true;
        break;
      }

      const statusResponse = await apifyRequest(fetchImpl,
        `https://api.apify.com/v2/actor-runs/${encodeURIComponent(actorRunId)}`,
        { headers: { authorization: `Bearer ${credential.token}` } }, deadline, signal);
      run = apifyRunData(await statusResponse.json());
      runStatus = String(run?.status || runStatus).toUpperCase();
      datasetId = String(run?.defaultDatasetId || datasetId || '') || null;
      if (APIFY_TERMINAL_RUN_STATUSES.has(runStatus)) {
        // The run status and dataset storage are separate writes. Re-read once
        // after the terminal status so the last review page is not missed.
        await readDataset();
        completionReason = runStatus === 'SUCCEEDED' ? 'actor-succeeded' : `actor-${runStatus.toLowerCase()}`;
        cacheable = runStatus === 'SUCCEEDED';
        break;
      }
      await sleepImpl(Math.max(0, Number(pollIntervalMs) || 0), signal);
    }

    if (!completionReason) {
      completionReason = 'timeout-partial';
      runStatus = 'TIMED-OUT';
      cacheable = false;
    }

    const items = [...seen.values()];
    const expectedRating = ratingFromFilter(reviewFilter);
    const matching = expectedRating === null
      ? items
      : items.filter((item) => Number(item?.review_rating) === expectedRating);
    const writtenCount = matching.filter((item) => String(item?.review_text || '').trim()).length;
    const partialUsable = writtenCount >= MINIMUM_REVIEWS_FOR_ANALYSIS;
    const successful = completionReason === 'target-reached' || runStatus === 'SUCCEEDED' || partialUsable;
    cacheable = cacheable && writtenCount >= MINIMUM_REVIEWS_FOR_ANALYSIS;
    logTikTokCollection('tiktok_collection_complete', {
      productId: String(productId), actorRunId, runStatus, completionReason,
      requested: reviewLimit, rawDatasetItemCount, uniqueReviewCount: items.length,
      writtenReviewCount: writtenCount, datasetPollCount, cacheable,
      timeToFirstReviewMs: firstReviewAt ? firstReviewAt - wallStartedAt : null,
      timeToTargetMs: targetReachedAt ? targetReachedAt - wallStartedAt : null,
      durationMs: Date.now() - wallStartedAt
    });
    if (!successful) {
      throw Object.assign(new Error(`Apify run TikTok kết thúc với trạng thái ${runStatus}.`), {
        statusCode: 502,
        failureClass: runStatus === 'TIMED-OUT' ? 'timeout' : 'actor_run_failed'
      });
    }
    return {
      ok: true,
      credentialId: credential.id,
      credentialLabel: credential.label,
      runCount: credential.runCount ?? null,
      filter: reviewFilter,
      requested: reviewLimit,
      billedReviewCount: items.length,
      droppedWrongRating: items.length - matching.length,
      reviewCount: writtenCount,
      latencyMs: Math.round(performance.now() - startedAt),
      actorRunId,
      actorStarted: true,
      statusCode,
      failureClass: null,
      productMeta,
      runStatus,
      completionReason,
      cacheable,
      datasetPollCount,
      rawDatasetItemCount,
      timeToFirstReviewMs: firstReviewAt ? firstReviewAt - wallStartedAt : null,
      timeToTargetMs: targetReachedAt ? targetReachedAt - wallStartedAt : null,
      items: matching
    };
  } catch (error) {
    const items = [...seen.values()];
    const expectedRating = ratingFromFilter(reviewFilter);
    const matching = expectedRating === null
      ? items
      : items.filter((item) => Number(item?.review_rating) === expectedRating);
    const writtenCount = matching.filter((item) => String(item?.review_text || '').trim()).length;
    if (writtenCount >= MINIMUM_REVIEWS_FOR_ANALYSIS) {
      completionReason = completionReason || 'request-failed-partial';
      logTikTokCollection('tiktok_collection_complete', {
        productId: String(productId), actorRunId, runStatus, completionReason,
        requested: reviewLimit, rawDatasetItemCount, uniqueReviewCount: items.length,
        writtenReviewCount: writtenCount, datasetPollCount, cacheable: false,
        timeToFirstReviewMs: firstReviewAt ? firstReviewAt - wallStartedAt : null,
        timeToTargetMs: null,
        durationMs: Date.now() - wallStartedAt,
        partialError: compactErrorDetail(error?.message)
      });
      return {
        ok: true,
        credentialId: credential.id,
        credentialLabel: credential.label,
        runCount: credential.runCount ?? null,
        filter: reviewFilter,
        requested: reviewLimit,
        billedReviewCount: items.length,
        droppedWrongRating: items.length - matching.length,
        reviewCount: writtenCount,
        latencyMs: Math.round(performance.now() - startedAt),
        actorRunId,
        actorStarted: Boolean(actorRunId),
        statusCode: error?.statusCode || statusCode,
        failureClass: null,
        productMeta,
        runStatus,
        completionReason,
        cacheable: false,
        datasetPollCount,
        rawDatasetItemCount,
        timeToFirstReviewMs: firstReviewAt ? firstReviewAt - wallStartedAt : null,
        timeToTargetMs: null,
        items: matching
      };
    }
    return {
      ok: false,
      credentialId: credential.id,
      credentialLabel: credential.label,
      runCount: credential.runCount ?? null,
      filter: reviewFilter,
      requested: reviewLimit,
      billedReviewCount: items.length,
      reviewCount: writtenCount,
      latencyMs: Math.round(performance.now() - startedAt),
      statusCode: error?.statusCode || statusCode,
      failureClass: error?.failureClass || classifyApifyFailure(error?.statusCode, error),
      retryAfterMs: error?.retryAfterMs || 60_000,
      actorRunId,
      actorStarted: Boolean(actorRunId),
      error: error?.message || 'Không lấy được reviews TikTok.',
      productMeta,
      runStatus,
      completionReason: completionReason || 'request-failed',
      cacheable: false,
      datasetPollCount,
      rawDatasetItemCount,
      items: []
    };
  }
}

async function allocate(runtime, options) {
  if (options.allocation) return {
    allocation: options.allocation,
    strategy: options.allocation.credentials.length === 5 ? 'parallel-star-filters' : 'single-unfiltered'
  };
  if (runtime.strategy === 'single-unfiltered') {
    return {
      allocation: await reserveTikTokCostCredentials({
        count: 1,
        reviewsPerCredential: runtime.reviewLimit,
        runtime,
        fetchImpl: options.redisFetchImpl,
        usageFetchImpl: options.usageFetchImpl
      }),
      strategy: 'single-unfiltered'
    };
  }
  const allocation = await reserveTikTokCostCredentials({
    count: 5,
    reviewsPerCredential: REVIEWS_PER_STAR,
    runtime,
    allowSingleFallback: true,
    fetchImpl: options.redisFetchImpl,
    usageFetchImpl: options.usageFetchImpl
  });
  return {
    allocation,
    strategy: allocation.credentials.length === 5 ? 'parallel-star-filters' : 'single-unfiltered'
  };
}

export async function collectTikTokReviews(productId, options = {}) {
  if (!/^\d{8,25}$/.test(String(productId || ''))) throw new Error('Mã sản phẩm TikTok Shop không hợp lệ.');
  const progress = createProgressReporter(options.onProgress);
  // Resolve once per request. A flag change while the actor is running cannot
  // change pricing, adapter or metadata during finalization.
  const runtime = options.runtimeConfig || resolveTikTokRuntimeConfig(productId, {
    ...(options.runtimeOptions || {}),
    ...(options.actorId ? { actorId: options.actorId } : {})
  });
  await (options.assertCircuitImpl || assertTikTokCircuitClosed)(runtime.actorId, { fetchImpl: options.redisFetchImpl });
  const { allocation, strategy } = await allocate(runtime, options);
  if (!allocation?.credentials?.length) throw new Error('Không có Apify key khả dụng cho TikTok.');
  const fetchImpl = options.fetchImpl || fetch;
  const configuredTimeout = Number(options.timeoutMs ?? process.env.APIFY_RUN_TIMEOUT_MS ?? 70_000);
  const timeoutMs = Number.isFinite(configuredTimeout) ? Math.min(110_000, Math.max(10_000, configuredTimeout)) : 70_000;
  const targetMaximum = strategy === 'parallel-star-filters'
    ? TIKTOK_DEFAULT_REVIEW_LIMIT
    : runtime.reviewLimit;
  const startedAt = performance.now();
  const runs = await Promise.all(allocation.credentials.map((credential, index) => {
    const runner = runtime.temporary ? runActorProgressive : runActorSync;
    return runner({
      productId,
      productUrl: options.productUrl,
      reviewLimit: Math.min(
        credential.plannedReviews || (strategy === 'parallel-star-filters' ? REVIEWS_PER_STAR : targetMaximum),
        targetMaximum
      ),
      reviewFilter: strategy === 'parallel-star-filters' ? STAR_FILTERS[index] : 'all',
      credential,
      fetchImpl,
      runtime,
      timeoutMs,
      signal: options.signal,
      progress,
      pollIntervalMs: options.pollIntervalMs,
      sleepImpl: options.sleepImpl
    });
  }));
  const hasInfrastructureFailure = runs.some((run) => ['timeout', 'upstream_service_error', 'unknown_error'].includes(run.failureClass));
  const healthOutcome = runs.some((run) => run.ok) ? 'success' : hasInfrastructureFailure ? 'failure' : 'neutral';
  await (options.recordHealthImpl || recordTikTokActorHealth)(runtime.actorId, healthOutcome, { fetchImpl: options.redisFetchImpl });

  if (allocation.source === 'redis-vault-cost-ledger-v4') {
    await Promise.allSettled(runs.map((run, index) => (options.finalizeImpl || finalizeTikTokCostCredential)(
      allocation.credentials[index],
      {
        reviewCount: run.billedReviewCount,
        statusCode: run.statusCode || 0,
        failureClass: run.failureClass || '',
        actorRunId: run.actorRunId,
        actorStarted: run.actorStarted,
        retryAfterMs: run.retryAfterMs
      },
      { fetchImpl: options.redisFetchImpl }
    )));
  }

  progress('collecting', 58, 'Đang lấy reviews...');
  const successful = runs.filter((run) => run.ok);
  if (!successful.length) {
    const quotaFailure = runs.find((run) => run.failureClass === 'billing_exhausted');
    const detail = runs[0]?.error || 'Không có dữ liệu trả về.';
    const error = new Error(quotaFailure
      ? `Apify key TikTok không còn quyền/hạn mức hoặc đang bị giới hạn. ${detail}`
      : `Không lấy được reviews TikTok từ Apify. ${detail}`);
    error.statusCode = 502;
    throw error;
  }

  const seen = new Set();
  const deduplicated = [];
  let duplicateCount = 0;
  let emptyCommentCount = 0;
  let wrongProductCount = 0;
  for (const run of runs) {
    for (const rawReview of run.items) {
      if (rawReview?.product_id && String(rawReview.product_id) !== String(productId)) {
        wrongProductCount += 1;
        continue;
      }
      if (!String(rawReview?.review_text || '').trim()) {
        emptyCommentCount += 1;
        continue;
      }
      const key = reviewKey(rawReview);
      if (seen.has(key)) {
        duplicateCount += 1;
        continue;
      }
      seen.add(key);
      if (deduplicated.length < targetMaximum) deduplicated.push(normalizeReview(rawReview, productId));
    }
  }
  sortReviewsMostRecent(deduplicated);

  const warnings = [];
  for (const run of runs.filter((run) => !run.ok)) warnings.push(run.error);
  const wrongRatingCount = runs.reduce((sum, run) => sum + (run.droppedWrongRating || 0), 0);
  if (wrongRatingCount) warnings.push(`Đã bỏ ${wrongRatingCount} review TikTok không khớp bộ lọc sao.`);
  if (emptyCommentCount) warnings.push(`Đã bỏ ${emptyCommentCount} review TikTok không có bình luận viết.`);
  if (duplicateCount) warnings.push(`Đã loại ${duplicateCount} review TikTok trùng trong dữ liệu trả về.`);
  if (wrongProductCount) warnings.push(`Đã loại ${wrongProductCount} review không thuộc đúng sản phẩm TikTok yêu cầu.`);
  if (strategy === 'single-unfiltered' && !runtime.temporary) warnings.push('TikTok đang dùng một key không lọc sao vì không còn đủ 5 key có hạn mức để chia mẫu an toàn.');
  if (runtime.temporary) warnings.push(`Kết quả TikTok sử dụng tối đa ${targetMaximum} review gần nhất; phân bố sao phản ánh mẫu quan sát và có thể thiên lệch theo thời gian.`);

  const firstItem = successful.find((run) => run.items.length)?.items[0] || null;
  const productMeta = successful.reduce((merged, run) => ({
    ...merged,
    ...(!merged.title && run.productMeta?.title ? { title: run.productMeta.title } : {}),
    ...(!merged.image && run.productMeta?.image ? { image: run.productMeta.image } : {}),
    ...(!merged.price && run.productMeta?.price ? { price: run.productMeta.price } : {}),
    ...(!merged.rating && run.productMeta?.rating ? { rating: run.productMeta.rating } : {})
  }), {});
  return {
    reviews: deduplicated,
    productMetaSource: firstItem,
    productMeta: {
      ...productMeta,
      ...(!productMeta.title && firstItem?.product_name ? { title: String(firstItem.product_name) } : {})
    },
    warnings,
    credential: {
      source: allocation.source,
      keys: allocation.credentials.map(({ id, label, runCount, reviewCount, plannedReviews }) => ({
        id, label, runCount, reviewCount, plannedReviews
      }))
    },
    usage: {
      provider: allocation.source,
      tracked: allocation.source === 'redis-vault-cost-ledger-v4',
      platform: 'tiktok',
      billingPeriod: allocation.billingPeriod || null,
      billingCycles: allocation.billingCycles || [],
      pricingVersion: runtime.pricingVersion,
      reviewCostMicroUsd: runtime.reviewCostMicroUsd,
      startupFeeMicroUsd: runtime.startupFeeMicroUsd,
      credentials: allocation.credentials.map(({ id, label, runCount, reviewCount, plannedReviews }) => ({
        id, label, runCount, reviewCount, plannedReviews
      }))
    },
    collection: {
      strategy,
      actorId: runtime.actorId,
      adapter: runtime.adapter,
      samplingStrategy: strategy === runtime.strategy ? runtime.samplingStrategy : strategy,
      distributionMode: runtime.distributionMode,
      methodVersion: runtime.methodVersion,
      pricingVersion: runtime.pricingVersion,
      randomized: runtime.randomized,
      region: runtime.region,
      temporaryActor: runtime.temporary,
      ratingStrata: strategy === 'parallel-star-filters' ? [1, 2, 3, 4, 5] : null,
      filters: strategy === 'parallel-star-filters' ? STAR_FILTERS : ['all'],
      writtenCommentsOnly: true,
      perStarLimit: strategy === 'parallel-star-filters' ? REVIEWS_PER_STAR : null,
      targetMaximum,
      returned: deduplicated.length,
      cacheable: successful.every((run) => run.cacheable !== false),
      completionReason: successful.length === 1 ? successful[0].completionReason || 'sync-complete' : 'parallel-sync-complete',
      duplicateCount,
      emptyCommentCount,
      wrongRatingCount,
      wrongProductCount,
      latencyMs: Math.round(performance.now() - startedAt),
      runs: runs.map(({ items: _items, productMeta: _productMeta, error, ...run }) => ({ ...run, ...(error ? { error } : {}) }))
    }
  };
}
