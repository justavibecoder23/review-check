import { randomUUID } from 'node:crypto';

export const CHAT_REQUEST_BUDGET_MS = 12_000;
export const CHAT_FINALIZE_RESERVE_MS = 700;
export function chatError(code, statusCode = 503, retryAfterMs = null) {
  return Object.assign(new Error(code), { code, statusCode, retryAfterMs });
}
export function createChatBudget(options = {}) {
  const startedAt = Date.now();
  const deadlineAt = startedAt + (options.budgetMs || CHAT_REQUEST_BUDGET_MS);
  const timings = {};
  const signal = AbortSignal.timeout(Math.max(1, deadlineAt - startedAt));
  const remaining = () => Math.max(0, deadlineAt - Date.now());
  const run = async (phase, operation, maximum = Infinity) => {
    const duration = Math.min(maximum, remaining());
    if (duration < 1) throw chatError('CHAT_DEADLINE_EXCEEDED');
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const start = Date.now(); let timer;
    try {
      return await Promise.race([Promise.resolve().then(() => operation(combined)), new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(chatError('CHAT_DEADLINE_EXCEEDED')); }, duration);
      })]);
    } finally { clearTimeout(timer); timings[phase] = (timings[phase] || 0) + Date.now() - start; }
  };
  return { startedAt, deadlineAt, remaining, run, signal, timings, requestId: randomUUID() };
}
export const FALLBACK_CODES = Object.freeze({
  quota_exhausted: ['AI_QUOTA_EXHAUSTED', false], temporarily_busy: ['AI_BUSY', true],
  timeout: ['AI_TIMEOUT', true], invalid_response: ['AI_INVALID_RESPONSE', true],
  connection_failed: ['AI_CONNECTION_FAILED', true], provider_overloaded: ['AI_OVERLOADED', true],
  pool_unavailable: ['CHAT_POOL_UNAVAILABLE', true], idempotency_unavailable: ['CHAT_IDEMPOTENCY_UNAVAILABLE', true],
  not_configured: ['AI_NOT_CONFIGURED', false], authentication_failed: ['AI_AUTHENTICATION_FAILED', false],
  request_rejected: ['AI_REQUEST_REJECTED', false], model_unavailable: ['AI_MODEL_UNAVAILABLE', false]
});
const ERROR_RETRY = new Set(['CHAT_DEADLINE_EXCEEDED', 'RESULT_CONTEXT_PREPARING', 'RESULT_CONTEXT_UNAVAILABLE',
  'ACCOUNT_STORAGE_UNAVAILABLE', 'CHAT_POOL_UNAVAILABLE', 'CHAT_IDEMPOTENCY_UNAVAILABLE', 'CHAT_REQUEST_IN_PROGRESS', 'CHAT_RATE_LIMITED']);
export function responseState(result, requestId) {
  const [code, retryable] = FALLBACK_CODES[result.fallbackReason] || ['AI_UNAVAILABLE', false];
  return { ...result, status: result.fallbackReason ? (result.fallbackUseful ? 'fallback' : 'temporarily_unavailable') : 'answered',
    code: result.fallbackReason ? code : null, retryable: Boolean(result.fallbackReason && retryable), requestId,
    retryAfterMs: result.retryAfterMs ?? (result.fallbackReason && retryable ? 1500 : null) };
}
export function errorState(error, requestId) {
  const code = error?.code || 'CHAT_REQUEST_FAILED';
  return { status: 'temporarily_unavailable', code, requestId, retryable: ERROR_RETRY.has(code),
    retryAfterMs: error?.retryAfterMs ?? (code === 'RESULT_CONTEXT_PREPARING' ? 400 : code === 'CHAT_REQUEST_IN_PROGRESS' ? 1000 : null), error: code };
}
export function retryDecision(error, remainingMs, random = Math.random, options = {}) {
  // Default remains conservative for all existing callers. Only the chatbot
  // opts in after the owner confirmed its credentials belong to separate projects.
  const quota = error?.quotaExhausted || Number(error?.statusCode) === 429;
  if ([400, 401, 402, 403, 404].includes(Number(error?.statusCode)) || (quota && !options.independentProjects)) return { retry: false };
  const transient = error?.transient || error?.name === 'TimeoutError' || error?.name === 'AbortError'
    || error?.code === 'GEMINI_INVALID_RESPONSE' || error?.statusCode === 408 || Number(error?.statusCode) >= 500 || (quota && options.independentProjects);
  // Retry-After belongs to the failed project on quota errors, not a different
  // independently authorized project. Other provider errors retain that wait.
  const delayMs = Math.max(quota ? 0 : Number(error?.retryAfterMs) || 0, 200 + Math.floor(random() * 200));
  const requiredMs = (options.minimumAttemptMs ?? 0) + (options.completionReserveMs ?? 500);
  return { retry: Boolean(transient && delayMs + requiredMs < remainingMs), delayMs };
}

export const CHATBOT_FIRST_ATTEMPT_MS = 4_000;
export const CHATBOT_SINGLE_ATTEMPT_MS = 9_000;
export const CHATBOT_BACKUP_ATTEMPT_MS = 5_500;
export const CHATBOT_MIN_RETRY_MS = 3_000;
export const CHATBOT_VALIDATION_RESERVE_MS = 500;
export function chatbotAttemptTimeout({ remainingMs, eligibleRoutes, attempts }, reserveMs = CHATBOT_VALIDATION_RESERVE_MS) {
  const available = Math.floor(remainingMs - reserveMs);
  if (available < 1 || (attempts > 0 && available < CHATBOT_MIN_RETRY_MS)) return 0;
  const cap = attempts > 0 ? CHATBOT_BACKUP_ATTEMPT_MS
    : eligibleRoutes > 1 ? CHATBOT_FIRST_ATTEMPT_MS : CHATBOT_SINGLE_ATTEMPT_MS;
  return Math.min(cap, available);
}
export function waitForRetry(delayMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(done, delayMs); signal?.addEventListener('abort', abort, { once: true });
  });
}
