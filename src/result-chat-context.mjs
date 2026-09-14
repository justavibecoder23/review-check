import { createHmac, timingSafeEqual } from 'node:crypto';
import { generateId } from 'ai';
import { isRedisConfigured, redisCommand } from './redis-rest.mjs';

export const RESULT_CHAT_CONTEXT_TTL_SECONDS = 5 * 24 * 60 * 60;
const RESULT_CONTEXT_SCHEMA_VERSION = '1.0.0';
export const MAX_RESULT_CHAT_CONTEXT_BYTES = 20_000;
export const MAX_RESULT_CHAT_REVIEWS = 20;
const MAX_REVIEW_TEXT = 500;

function contextKey(resultId) {
  return `realview:chatbot:result-context:v1:${resultId}`;
}

function generationKey(generationId) {
  return `realview:chatbot:generation:v1:${generationId}`;
}

function signingSecret() {
  return String(
    process.env.RESULT_CONTEXT_SIGNING_SECRET
    || process.env.CHATBOT_GEMINI_API_KEY_VAULT_KEY
    || process.env.GEMINI_API_KEY_VAULT_KEY
    || ''
  );
}

function cleanText(value, maximum = MAX_REVIEW_TEXT) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pruneReview(review, index, refPrefix = 'R') {
  return {
    ref: `${refPrefix}${String(index + 1).padStart(3, '0')}`,
    rating: numberOrNull(review?.rating),
    text: cleanText(review?.text),
    date: cleanText(review?.date, 80) || null,
    verified: typeof review?.verified === 'boolean' ? review.verified : null,
    included: review?.included !== false,
    exclusionReason: cleanText(review?.exclusionReason, 300) || null,
    labelId: cleanText(review?.labelId, 80) || null
  };
}

function finalLabels(review) {
  return review?.labeling?.final || review?.labels || {};
}

function reviewLabelId(review) {
  return cleanText(review?.labelId || finalLabels(review)?.labelId, 80);
}

function ratingLevel(review) {
  const rating = Math.round(Number(review?.rating));
  return rating >= 1 && rating <= 5 ? rating : 0;
}

function evidenceIds(items) {
  return new Set((Array.isArray(items) ? items : [])
    .flatMap((item) => Array.isArray(item?.evidenceIds) ? item.evidenceIds : [])
    .map((id) => cleanText(id, 80))
    .filter(Boolean));
}

function compactSummaryItem(item = {}, evidenceRefs = new Map()) {
  if (typeof item === 'string') return cleanText(item, 500);
  return {
    label: cleanText(item.label || item.title, 180) || null,
    detail: cleanText(item.detail || item.text, 500) || null,
    count: numberOrNull(item.count ?? item.mentions),
    impact: cleanText(item.impact, 120) || null,
    evidenceIds: Array.isArray(item.evidenceIds)
      ? item.evidenceIds.map((id) => evidenceRefs.get(cleanText(id, 80))).filter(Boolean).slice(0, 6)
      : []
  };
}

function compactIssue(item = {}) {
  return {
    id: cleanText(item.id, 100) || null,
    label: cleanText(item.label || item.title, 180) || null,
    count: numberOrNull(item.count),
    level: cleanText(item.level, 120) || null,
    examples: (Array.isArray(item.examples) ? item.examples : []).slice(0, 2).map((example) => ({
      rating: numberOrNull(example?.rating),
      text: cleanText(example?.text, 300),
      date: cleanText(example?.date, 80) || null
    }))
  };
}

function compactMethod(method = {}) {
  if (!method || typeof method !== 'object') return null;
  return {
    version: cleanText(method.version, 100) || null,
    sample: method.sample || null,
    components: method.components || null,
    adequacy: method.adequacy || null,
    guardrails: method.guardrails || null
  };
}

function representativePriority(left, right, requiredEvidence) {
  const leftEvidence = requiredEvidence.has(reviewLabelId(left.review));
  const rightEvidence = requiredEvidence.has(reviewLabelId(right.review));
  if (leftEvidence !== rightEvidence) return Number(rightEvidence) - Number(leftEvidence);
  const leftExcluded = left.review?.included === false;
  const rightExcluded = right.review?.included === false;
  if (leftExcluded !== rightExcluded) return Number(rightExcluded) - Number(leftExcluded);
  const leftRating = ratingLevel(left.review) || 6;
  const rightRating = ratingLevel(right.review) || 6;
  if (leftRating !== rightRating) return leftRating - rightRating;
  const lengthDifference = String(right.review?.text || '').length - String(left.review?.text || '').length;
  return lengthDifference || left.index - right.index;
}

function selectCompactReviews(result, limit = MAX_RESULT_CHAT_REVIEWS) {
  const candidates = (Array.isArray(result?.reviews) ? result.reviews : [])
    .map((review, index) => ({ review, index }))
    .filter(({ review }) => cleanText(review?.text));
  const requiredEvidence = new Set([
    ...evidenceIds(result?.trust?.pros),
    ...evidenceIds(result?.trust?.cons),
    ...evidenceIds(result?.trust?.drivers)
  ]);
  const ranked = [...candidates].sort((left, right) => representativePriority(left, right, requiredEvidence));
  const selected = [];
  const selectedIndexes = new Set();
  const addBest = (predicate) => {
    if (selected.length >= limit) return;
    const candidate = ranked.find((item) => !selectedIndexes.has(item.index) && predicate(item.review));
    if (!candidate) return;
    selected.push(candidate);
    selectedIndexes.add(candidate.index);
  };

  // Giữ các lát cắt tối thiểu trước để danh sách evidence dài của một chủ đề
  // không lấp kín context và làm mất review bị loại hoặc các mức sao khác.
  for (let rating = 1; rating <= 5; rating += 1) addBest((review) => ratingLevel(review) === rating && review.included !== false);
  addBest((review) => review.included !== false);
  addBest((review) => review.included === false);
  const exclusionReasons = [...new Set(candidates
    .filter(({ review }) => review.included === false && review.exclusionReason)
    .map(({ review }) => cleanText(review.exclusionReason, 300)))];
  for (const reason of exclusionReasons) addBest((review) => review.included === false && cleanText(review.exclusionReason, 300) === reason);
  for (const evidenceId of requiredEvidence) addBest((review) => reviewLabelId(review) === evidenceId);
  for (const candidate of ranked) {
    if (selected.length >= limit) break;
    if (!selectedIndexes.has(candidate.index)) {
      selected.push(candidate);
      selectedIndexes.add(candidate.index);
    }
  }
  return selected.map(({ review, index }) => pruneReview(review, index, result?.refPrefix || 'R'));
}

export function buildResultChatContext(result = {}, options = {}) {
  const reviews = selectCompactReviews({ ...result, refPrefix: options.refPrefix || 'R' });
  const evidenceRefs = new Map(reviews.map((review) => [review.labelId, review.ref]).filter(([labelId]) => labelId));
  const context = {
    schemaVersion: RESULT_CONTEXT_SCHEMA_VERSION,
    resultId: String(options.resultId || generateId()),
    resultVersion: cleanText(result?.labeling?.pipelineVersion || result?.trust?.method?.version || 'current', 100),
    createdAt: (options.now instanceof Date ? options.now : new Date(options.now || Date.now())).toISOString(),
    product: {
      platform: cleanText(result?.product?.platform, 80),
      title: cleanText(result?.product?.title, 500),
      category: cleanText(result?.product?.category, 200) || null,
      categoryPath: Array.isArray(result?.product?.categoryPath)
        ? result.product.categoryPath.map((item) => cleanText(item, 160)).filter(Boolean).slice(0, 8)
        : [],
      itemId: cleanText(result?.product?.itemId || result?.product?.productId, 80) || null,
      price: cleanText(result?.product?.price, 100) || null,
      rating: numberOrNull(result?.product?.rating),
      reviewCount: numberOrNull(result?.product?.reviewCount ?? result?.stats?.scanned)
    },
    stats: {
      scanned: numberOrNull(result?.stats?.scanned),
      included: numberOrNull(result?.stats?.included ?? result?.stats?.genuine),
      excluded: numberOrNull(result?.stats?.excluded),
      unverified: numberOrNull(result?.stats?.unverified),
      lowRatings: numberOrNull(result?.stats?.lowRatings)
    },
    trust: {
      score: numberOrNull(result?.trust?.score),
      scoreStatus: cleanText(result?.trust?.scoreStatus, 80) || null,
      label: cleanText(result?.trust?.label, 160) || null,
      summary: cleanText(result?.trust?.summary, 1600) || null,
      pros: Array.isArray(result?.trust?.pros) ? result.trust.pros.slice(0, 5).map((item) => compactSummaryItem(item, evidenceRefs)) : [],
      cons: Array.isArray(result?.trust?.cons) ? result.trust.cons.slice(0, 5).map((item) => compactSummaryItem(item, evidenceRefs)) : [],
      drivers: Array.isArray(result?.trust?.drivers) ? result.trust.drivers.slice(0, 5).map((item) => compactSummaryItem(item, evidenceRefs)) : [],
      method: compactMethod(result?.trust?.method)
    },
    verdict: cleanText(result?.verdict, 1200) || null,
    issues: Array.isArray(result?.issues) ? result.issues.slice(0, 5).map(compactIssue) : [],
    warnings: Array.isArray(result?.warnings) ? result.warnings.map((item) => cleanText(item, 400)).filter(Boolean).slice(0, 5) : [],
    reviews
  };
  while (context.reviews.length > 8 && Buffer.byteLength(JSON.stringify(context), 'utf8') > MAX_RESULT_CHAT_CONTEXT_BYTES) {
    context.reviews.pop();
  }
  return context;
}

function sign(resultId, expiresAt) {
  const secret = signingSecret();
  if (!secret) return '';
  return createHmac('sha256', secret).update(`${resultId}.${expiresAt}`).digest('base64url');
}

export function createResultAccessToken(resultId, options = {}) {
  const expiresAt = Math.floor((options.nowMs || Date.now()) / 1000) + RESULT_CHAT_CONTEXT_TTL_SECONDS;
  const signature = sign(resultId, expiresAt);
  return signature ? `${expiresAt}.${signature}` : '';
}

export function verifyResultAccessToken(resultId, token, options = {}) {
  const [expiresRaw, suppliedSignature] = String(token || '').split('.');
  const expiresAt = Number(expiresRaw);
  if (!resultId || !Number.isInteger(expiresAt) || expiresAt <= Math.floor((options.nowMs || Date.now()) / 1000)) return false;
  const expectedSignature = sign(resultId, expiresAt);
  if (!expectedSignature || !suppliedSignature) return false;
  const expected = Buffer.from(expectedSignature);
  const supplied = Buffer.from(suppliedSignature);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

function unavailable(reason, detail) {
  return { available: false, reason, ...(detail ? { detail } : {}) };
}

export function prepareResultChatContext(result, options = {}) {
  if ((!isRedisConfigured() && !options.redisFetchImpl) || !signingSecret()) {
    return { descriptor: unavailable('CONTEXT_STORAGE_NOT_CONFIGURED'), context: null };
  }
  const context = buildResultChatContext(result, options);
  const serialized = JSON.stringify(context);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RESULT_CHAT_CONTEXT_BYTES) {
    return { descriptor: unavailable('CONTEXT_TOO_LARGE'), context: null };
  }
  const accessToken = createResultAccessToken(context.resultId, { nowMs: Date.parse(context.createdAt) });
  return {
    context,
    serialized,
    descriptor: {
      available: true,
      status: 'preparing',
      resultId: context.resultId,
      accessToken,
      expiresAt: new Date(Date.parse(context.createdAt) + RESULT_CHAT_CONTEXT_TTL_SECONDS * 1000).toISOString(),
      schemaVersion: RESULT_CONTEXT_SCHEMA_VERSION
    }
  };
}

function deadline(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new DOMException('Result context save timed out', 'TimeoutError')), timeoutMs);
      timer.unref?.();
    })
  ]).finally(() => clearTimeout(timer));
}

export async function persistPreparedResultChatContext(prepared, options = {}) {
  if (!prepared?.context || !prepared?.serialized || !prepared?.descriptor?.available) {
    return prepared?.descriptor || unavailable('CONTEXT_UNAVAILABLE');
  }
  const startedAt = Date.now();
  const timeoutMs = Math.max(100, Number(options.redisTimeoutMs) || 1_500);
  if (process.env.VERCEL) console.log(JSON.stringify({ level: 'info', event: 'result_context_background_started', resultId: prepared.context.resultId, bytes: Buffer.byteLength(prepared.serialized, 'utf8') }));
  try {
    await deadline(redisCommand([
      'SET', contextKey(prepared.context.resultId), prepared.serialized,
      'EX', String(RESULT_CHAT_CONTEXT_TTL_SECONDS)
    ], { fetchImpl: options.redisFetchImpl, timeoutMs }), timeoutMs + 100);
    const ready = { ...prepared.descriptor, status: 'ready' };
    if (process.env.VERCEL) console.log(JSON.stringify({ level: 'info', event: 'result_context_background_complete', resultId: prepared.context.resultId, durationMs: Date.now() - startedAt }));
    return ready;
  } catch (error) {
    if (process.env.VERCEL) console.error(JSON.stringify({ level: 'error', event: 'result_context_background_failed', resultId: prepared.context.resultId, durationMs: Date.now() - startedAt, reason: cleanText(error?.message, 120) }));
    return unavailable('CONTEXT_SAVE_FAILED', cleanText(error?.message, 160));
  }
}

export async function saveResultChatContext(result, options = {}) {
  const prepared = prepareResultChatContext(result, options);
  return persistPreparedResultChatContext(prepared, options);
}

export async function loadResultChatContext(resultId, accessToken, options = {}) {
  const normalizedId = String(resultId || '').trim();
  if (!verifyResultAccessToken(normalizedId, accessToken, options)) {
    const error = new Error('Quyền truy cập kết quả không hợp lệ hoặc đã hết hạn.');
    error.statusCode = 403;
    error.code = 'RESULT_CONTEXT_FORBIDDEN';
    throw error;
  }
  const serialized = await redisCommand(['GET', contextKey(normalizedId)], {
    fetchImpl: options.redisFetchImpl,
    timeoutMs: options.redisTimeoutMs || 900
  });
  if (!serialized) {
    const expiresAt = Number(String(accessToken || '').split('.')[0]);
    const createdAt = expiresAt - RESULT_CHAT_CONTEXT_TTL_SECONDS;
    const isPreparing = createdAt > 0 && Math.floor((options.nowMs || Date.now()) / 1000) - createdAt < 15;
    const error = new Error(isPreparing ? 'Dữ liệu giải thích đang được chuẩn bị.' : 'Kết quả này đã hết thời gian hỗ trợ hỏi đáp.');
    error.statusCode = isPreparing ? 409 : 404;
    error.code = isPreparing ? 'RESULT_CONTEXT_PREPARING' : 'RESULT_CONTEXT_NOT_FOUND';
    throw error;
  }
  const record = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
  const context = record?.context || record;
  if (!context || context.resultId !== normalizedId) {
    const error = new Error('Không đọc được dữ liệu kết quả.');
    error.statusCode = 503;
    error.code = 'RESULT_CONTEXT_UNAVAILABLE';
    throw error;
  }
  return context;
}

export async function getResultChatContextStatus(resultId, accessToken, options = {}) {
  const context = await loadResultChatContext(resultId, accessToken, options);
  return {
    status: 'ready',
    resultId: context.resultId,
    productTitle: context.product?.title || null
  };
}

export async function persistChatGeneration(generation, options = {}) {
  if (!isRedisConfigured() && !options.redisFetchImpl) return false;
  try {
    await redisCommand(['SET', generationKey(generation.id), JSON.stringify(generation), 'EX', String(RESULT_CHAT_CONTEXT_TTL_SECONDS)], {
      fetchImpl: options.redisFetchImpl,
      timeoutMs: options.redisTimeoutMs || 900
    });
    return true;
  } catch {
    return false;
  }
}
