import { createHmac, timingSafeEqual } from 'node:crypto';
import { generateId } from 'ai';
import { isRedisConfigured, redisCommand } from './redis-rest.mjs';

export const RESULT_CHAT_CONTEXT_TTL_SECONDS = 5 * 24 * 60 * 60;
const RESULT_CONTEXT_SCHEMA_VERSION = '1.0.0';
const MAX_CONTEXT_BYTES = 300_000;
const MAX_REVIEW_TEXT = 900;

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

function pruneReview(review, index) {
  return {
    ref: `R${String(index + 1).padStart(3, '0')}`,
    rating: numberOrNull(review?.rating),
    text: cleanText(review?.text),
    date: cleanText(review?.date, 80) || null,
    verified: typeof review?.verified === 'boolean' ? review.verified : null,
    included: review?.included !== false,
    exclusionReason: cleanText(review?.exclusionReason, 300) || null,
    labelId: cleanText(review?.labelId, 80) || null
  };
}

export function buildResultChatContext(result = {}, options = {}) {
  const reviews = (Array.isArray(result.reviews) ? result.reviews : [])
    .map(pruneReview)
    .filter((review) => review.text);
  return {
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
      itemId: cleanText(result?.product?.itemId || result?.product?.productId, 80) || null
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
      pros: Array.isArray(result?.trust?.pros) ? result.trust.pros.slice(0, 12) : [],
      cons: Array.isArray(result?.trust?.cons) ? result.trust.cons.slice(0, 12) : [],
      drivers: Array.isArray(result?.trust?.drivers) ? result.trust.drivers.slice(0, 12) : [],
      method: result?.trust?.method || null
    },
    verdict: cleanText(result?.verdict, 1200) || null,
    issues: Array.isArray(result?.issues) ? result.issues.slice(0, 12) : [],
    warnings: Array.isArray(result?.warnings) ? result.warnings.map((item) => cleanText(item, 500)).filter(Boolean).slice(0, 12) : [],
    reviews
  };
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

function contextBlobPath(context) {
  const datePath = context.createdAt.slice(0, 10).replaceAll('-', '/');
  return `result-contexts/${datePath}/${context.resultId}.json`;
}

async function saveContextBlob(context, options = {}) {
  const token = options.blobToken || process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;
  const putBlob = options.blobPutImpl || (await import('@vercel/blob')).put;
  return putBlob(contextBlobPath(context), JSON.stringify(context), {
    access: 'private',
    addRandomSuffix: false,
    contentType: 'application/json; charset=utf-8',
    abortSignal: AbortSignal.timeout(options.blobTimeoutMs || 1_200),
    token
  });
}

export async function saveResultChatContext(result, options = {}) {
  const context = buildResultChatContext(result, options);
  const serialized = JSON.stringify(context);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CONTEXT_BYTES) {
    return { available: false, reason: 'CONTEXT_TOO_LARGE' };
  }
  if ((!isRedisConfigured() && !options.redisFetchImpl) || !signingSecret()) {
    return { available: false, reason: 'CONTEXT_STORAGE_NOT_CONFIGURED' };
  }
  try {
    const hasBlob = Boolean(options.blobToken || process.env.BLOB_READ_WRITE_TOKEN);
    const record = {
      context,
      blobPath: hasBlob ? contextBlobPath(context) : null
    };
    // Redis unlocks result Q&A; the private Blob is a durable mirror. Run both
    // writes concurrently so persistence adds at most the slower bounded write,
    // rather than serial network latency after Layer 2 and TrustScore finish.
    await Promise.all([
      redisCommand(['SET', contextKey(context.resultId), JSON.stringify(record), 'EX', String(RESULT_CHAT_CONTEXT_TTL_SECONDS)], {
        fetchImpl: options.redisFetchImpl,
        timeoutMs: options.redisTimeoutMs || 1_500
      }),
      saveContextBlob(context, options).catch(() => null)
    ]);
    return {
      available: true,
      resultId: context.resultId,
      accessToken: createResultAccessToken(context.resultId, { nowMs: Date.parse(context.createdAt) }),
      expiresAt: new Date(Date.parse(context.createdAt) + RESULT_CHAT_CONTEXT_TTL_SECONDS * 1000).toISOString(),
      schemaVersion: RESULT_CONTEXT_SCHEMA_VERSION
    };
  } catch (error) {
    return { available: false, reason: 'CONTEXT_SAVE_FAILED', detail: cleanText(error?.message, 160) };
  }
}

async function readContextBlob(record, options = {}) {
  const locator = record?.blobPath || record?.blobUrl;
  if (!locator) return null;
  const getBlob = options.blobGetImpl || (await import('@vercel/blob')).get;
  const result = await getBlob(locator, {
    access: 'private',
    token: options.blobToken || process.env.BLOB_READ_WRITE_TOKEN
  });
  if (result?.statusCode !== 200 || !result.stream || Number(result?.blob?.size) > MAX_CONTEXT_BYTES) return null;
  return JSON.parse(await new Response(result.stream).text());
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
    const error = new Error('Kết quả này đã hết thời gian hỗ trợ hỏi đáp.');
    error.statusCode = 404;
    error.code = 'RESULT_CONTEXT_NOT_FOUND';
    throw error;
  }
  const record = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
  const context = record?.context || await readContextBlob(record, options);
  if (!context || context.resultId !== normalizedId) {
    const error = new Error('Không đọc được dữ liệu kết quả.');
    error.statusCode = 503;
    error.code = 'RESULT_CONTEXT_UNAVAILABLE';
    throw error;
  }
  return context;
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
