import { markGeminiModelExhausted, reserveGeminiCredential } from './gemini-credential-store.mjs';

function truncate(value, maxLength = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

const DEFAULT_MODEL = 'gemini-3.5-flash';
const DEFAULT_FALLBACK_MODELS = Object.freeze(['gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.5-flash-lite']);

function configuredFallbackModels(value) {
  if (value === undefined || value === null || String(value).trim() === '') return DEFAULT_FALLBACK_MODELS;
  return String(value).split(',').map((model) => model.trim()).filter(Boolean);
}

function transientGeminiError(error) {
  const status = Number(error?.statusCode) || 0;
  return error?.name === 'AbortError'
    || /abort|timeout|timed out|network|fetch failed/i.test(String(error?.message || ''))
    || [408, 425, 500, 502, 503, 504].includes(status);
}

async function fetchGemini(fetchImpl, url, init, context, model) {
  try {
    const response = await fetchImpl(url, init);
    if (response.ok) return { response };
    const error = await geminiHttpError(response, context);
    error.model = model;
    return { error };
  } catch (cause) {
    const error = new Error(`${context} tạm thời không phản hồi: ${truncate(cause?.message || cause || 'lỗi mạng')}`);
    error.name = cause?.name || 'GeminiNetworkError';
    error.statusCode = Number(cause?.statusCode) || null;
    error.model = model;
    error.transient = true;
    return { error };
  }
}

export function geminiModelChain(primaryModel = DEFAULT_MODEL, fallbackModels = process.env.GEMINI_FALLBACK_MODELS) {
  return [...new Set([
    String(primaryModel || DEFAULT_MODEL).trim(),
    ...configuredFallbackModels(fallbackModels),
    ...DEFAULT_FALLBACK_MODELS
  ])];
}

export async function geminiHttpError(response, context = 'Gemini') {
  let detail = '';
  let payload = null;
  try {
    if (typeof response?.json === 'function') payload = await response.json();
    else if (typeof response?.text === 'function') {
      const text = await response.text();
      payload = text ? JSON.parse(text) : null;
    }
    const status = truncate(payload?.error?.status, 80);
    const message = truncate(payload?.error?.message);
    detail = [status, message].filter(Boolean).join(' — ');
  } catch {
    // Không đưa response thô vào log vì có thể chứa dữ liệu người dùng.
  }
  const httpStatus = Number(response?.status) || 'không rõ';
  const rawQuotaDetails = JSON.stringify(payload?.error?.details || []);
  const error = new Error(`${context} trả về HTTP ${httpStatus}${detail ? `: ${detail}` : ''}`);
  error.statusCode = Number(response?.status) || null;
  error.geminiStatus = truncate(payload?.error?.status, 80) || null;
  error.quotaExhausted = error.statusCode === 429 || error.geminiStatus === 'RESOURCE_EXHAUSTED';
  error.quotaScope = /per.?day|requestsperday|tokensperday/i.test(rawQuotaDetails)
    ? 'day'
    : /per.?minute|requestsperminute|tokensperminute/i.test(rawQuotaDetails)
      ? 'minute'
      : 'unknown';
  return error;
}

export async function requestGeminiWithFallback({
  fetchImpl = fetch,
  redisFetchImpl,
  apiKey,
  primaryModel = DEFAULT_MODEL,
  fallbackModels,
  context = 'Gemini',
  buildRequest,
  reserveCredentialImpl = reserveGeminiCredential,
  markModelExhaustedImpl = markGeminiModelExhausted,
  transientModelsPerKey = 2,
  transientBackupKeyRetries = process.env.GEMINI_TRANSIENT_KEY_RETRIES || '1'
}) {
  const models = geminiModelChain(primaryModel, fallbackModels);
  const maxTransientModelsPerKey = Math.min(models.length, Math.max(1, Number.parseInt(transientModelsPerKey, 10) || 1));
  const maxTransientBackupKeys = Math.min(2, Math.max(0, Number.parseInt(transientBackupKeyRetries, 10) || 0));
  let lastError;
  let credential = null;
  try {
    credential = await reserveCredentialImpl({ fetchImpl: redisFetchImpl });
  } catch (error) {
    if (error?.code !== 'POOL_NOT_CONFIGURED') throw error;
  }

  if (!credential) {
    if (!apiKey) {
      const error = new Error('GEMINI_API_KEY chưa được cấu hình và Gemini pool chưa có key.');
      error.code = 'GEMINI_NOT_CONFIGURED';
      error.statusCode = 503;
      throw error;
    }
    let transientAttempts = 0;
    for (let index = 0; index < models.length; index += 1) {
      const model = models[index];
      const attempt = await fetchGemini(fetchImpl,
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        buildRequest(model, apiKey), context, model
      );
      if (attempt.response) return { response: attempt.response, model, attemptedModels: models.slice(0, index + 1), credentialId: null };
      lastError = attempt.error;
      lastError.model = model;
      lastError.attemptedModels = models.slice(0, index + 1);
      if (transientGeminiError(lastError)) {
        transientAttempts += 1;
        if (transientAttempts < maxTransientModelsPerKey && index < models.length - 1) continue;
        throw lastError;
      }
      if (!lastError.quotaExhausted || index === models.length - 1) throw lastError;
    }
    throw lastError || new Error(`${context} không có model khả dụng.`);
  }

  const attemptedModels = [];
  const attemptedCredentialIds = [];
  const excludedCredentialIds = new Set();
  let transientBackupKeysUsed = 0;
  while (credential) {
    if (excludedCredentialIds.has(credential.id)) throw lastError || new Error(`${context} không còn API key khác để retry.`);
    attemptedCredentialIds.push(credential.id);
    excludedCredentialIds.add(credential.id);
    const exhausted = new Set(credential.exhaustedModels || []);
    const availableModels = models.filter((model) => !exhausted.has(model));
    let credentialUsed = false;
    let temporaryQuotaFailure = false;
    let transientAttempts = 0;
    let rotateAfterTransientFailure = false;
    for (const model of availableModels) {
      attemptedModels.push(model);
      const attempt = await fetchGemini(fetchImpl,
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        buildRequest(model, credential.apiKey), context, model
      );
      if (attempt.response) {
        return { response: attempt.response, model, attemptedModels, credentialId: credential.id, attemptedCredentialIds };
      }
      lastError = attempt.error;
      lastError.model = model;
      lastError.credentialId = credential.id;
      lastError.attemptedModels = [...attemptedModels];
      lastError.attemptedCredentialIds = [...attemptedCredentialIds];
      if (transientGeminiError(lastError)) {
        transientAttempts += 1;
        if (transientAttempts < maxTransientModelsPerKey) continue;
        rotateAfterTransientFailure = true;
        break;
      }
      if (!lastError.quotaExhausted) throw lastError;
      if (lastError.quotaScope === 'minute') {
        temporaryQuotaFailure = true;
        continue;
      }
      const state = await markModelExhaustedImpl(credential, model, { fetchImpl: redisFetchImpl });
      credentialUsed = Boolean(state.used);
    }
    if (rotateAfterTransientFailure || temporaryQuotaFailure) {
      if (transientBackupKeysUsed >= maxTransientBackupKeys) throw lastError;
      transientBackupKeysUsed += 1;
      try {
        credential = await reserveCredentialImpl({
          fetchImpl: redisFetchImpl,
          excludeCredentialIds: [...excludedCredentialIds]
        });
      } catch (error) {
        if (error?.code === 'POOL_RETRY_EXHAUSTED') throw lastError;
        throw error;
      }
      continue;
    }
    if (!credentialUsed) throw lastError;
    credential = await reserveCredentialImpl({ fetchImpl: redisFetchImpl, excludeCredentialIds: [...excludedCredentialIds] });
  }
  throw lastError || new Error(`${context} không có model khả dụng.`);
}

export function parseGeminiJson(payload, context = 'Gemini') {
  const candidate = payload?.candidates?.[0];
  const finishReason = truncate(candidate?.finishReason || payload?.promptFeedback?.blockReason, 80) || 'không rõ';
  const text = candidate?.content?.parts
    ?.filter((part) => !part?.thought && typeof part?.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim() || '';

  if (!text) throw new Error(`${context} không trả nội dung JSON (finishReason: ${finishReason}).`);

  const normalized = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(normalized);
  } catch {
    throw new Error(`${context} trả JSON không hợp lệ (finishReason: ${finishReason}).`);
  }
}

export function geminiThinkingConfig(level = 'minimal', model = '') {
  const normalizedModel = String(model).trim().toLowerCase();
  return { thinkingLevel: level === 'minimal' && normalizedModel.startsWith('gemini-3.7-') ? 'low' : level };
}
