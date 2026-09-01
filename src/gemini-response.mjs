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
  markModelExhaustedImpl = markGeminiModelExhausted
}) {
  const models = geminiModelChain(primaryModel, fallbackModels);
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
    for (let index = 0; index < models.length; index += 1) {
      const model = models[index];
      const response = await fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        buildRequest(model, apiKey)
      );
      if (response.ok) return { response, model, attemptedModels: models.slice(0, index + 1), credentialId: null };
      lastError = await geminiHttpError(response, context);
      lastError.model = model;
      lastError.attemptedModels = models.slice(0, index + 1);
      if (!lastError.quotaExhausted || index === models.length - 1) throw lastError;
    }
    throw lastError || new Error(`${context} không có model khả dụng.`);
  }

  const attemptedModels = [];
  const attemptedCredentialIds = [];
  while (credential) {
    attemptedCredentialIds.push(credential.id);
    const exhausted = new Set(credential.exhaustedModels || []);
    const availableModels = models.filter((model) => !exhausted.has(model));
    let credentialUsed = false;
    let temporaryQuotaFailure = false;
    for (const model of availableModels) {
      attemptedModels.push(model);
      const response = await fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        buildRequest(model, credential.apiKey)
      );
      if (response.ok) {
        return { response, model, attemptedModels, credentialId: credential.id, attemptedCredentialIds };
      }
      lastError = await geminiHttpError(response, context);
      lastError.model = model;
      lastError.credentialId = credential.id;
      lastError.attemptedModels = [...attemptedModels];
      lastError.attemptedCredentialIds = [...attemptedCredentialIds];
      if (!lastError.quotaExhausted) throw lastError;
      if (lastError.quotaScope === 'minute') {
        temporaryQuotaFailure = true;
        continue;
      }
      const state = await markModelExhaustedImpl(credential, model, { fetchImpl: redisFetchImpl });
      credentialUsed = Boolean(state.used);
    }
    if (!credentialUsed || temporaryQuotaFailure) throw lastError;
    credential = await reserveCredentialImpl({ fetchImpl: redisFetchImpl });
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
