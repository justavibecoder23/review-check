import { listAvailableGeminiCredentials, markGeminiModelExhausted } from './gemini-credential-store.mjs';
import {
  beginGeminiRoute,
  configuredGeminiLimit,
  finishGeminiRoute,
  geminiRouteId,
  geminiRoutePressure,
  geminiRouteScore,
  getGeminiHealthSnapshot
} from './gemini-health.mjs';

function truncate(value, maxLength = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export const GEMINI_MODEL = 'gemini-3.5-flash-lite';
export const GEMINI_ATTEMPT_TIMEOUT_MS = 10_000;

async function fetchGemini(fetchImpl, url, init, context, model) {
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(url, init);
    if (response.ok) return { response, latencyMs: Date.now() - startedAt };
    const error = await geminiHttpError(response, context);
    error.model = model;
    return { error, latencyMs: Date.now() - startedAt };
  } catch (cause) {
    const error = new Error(`${context} tạm thời không phản hồi: ${truncate(cause?.message || cause || 'lỗi mạng')}`);
    error.name = cause?.name || 'GeminiNetworkError';
    error.statusCode = Number(cause?.statusCode) || null;
    error.model = model;
    error.transient = true;
    return { error, latencyMs: Date.now() - startedAt };
  }
}

async function responseTokenCount(response) {
  try {
    const payload = await response.clone().json();
    return Math.max(0, Number(payload?.usageMetadata?.totalTokenCount) || 0);
  } catch {
    return 0;
  }
}

function attemptSignal(existingSignal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!existingSignal || typeof AbortSignal.any !== 'function') return timeoutSignal;
  return AbortSignal.any([existingSignal, timeoutSignal]);
}

function healthErrorType(error) {
  if (error?.name === 'AbortError' || /abort|timeout|timed out/i.test(String(error?.message || ''))) return 'timeout';
  if (error?.code === 'GEMINI_INVALID_RESPONSE') return 'invalid-response';
  if (error?.quotaExhausted) return error.quotaScope === 'day' ? 'daily-quota' : 'rate-limit';
  if (Number(error?.statusCode) >= 500) return 'provider-overload';
  return 'request-error';
}

export function geminiModelChain() {
  return [GEMINI_MODEL];
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
  const rawQuotaDetails = JSON.stringify({
    message: payload?.error?.message || '',
    details: payload?.error?.details || []
  });
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
  context = 'Gemini',
  buildRequest,
  listCredentialsImpl = listAvailableGeminiCredentials,
  markModelExhaustedImpl = markGeminiModelExhausted,
  getHealthSnapshotImpl = getGeminiHealthSnapshot,
  beginRouteImpl = beginGeminiRoute,
  finishRouteImpl = finishGeminiRoute,
  maxRetries = 2,
  attemptTimeoutMs = GEMINI_ATTEMPT_TIMEOUT_MS,
  deadlineAt,
  retryOnTimeout = true,
  routeContext,
  validateResponse
}) {
  const requestStartedAt = Date.now();
  const models = geminiModelChain();
  const maxAttempts = 1 + Math.min(2, Math.max(0, Number.parseInt(maxRetries, 10) || 0));
  const timeoutMs = Math.min(GEMINI_ATTEMPT_TIMEOUT_MS, Math.max(10, Number.parseInt(attemptTimeoutMs, 10) || GEMINI_ATTEMPT_TIMEOUT_MS));
  let lastError;
  let credentials = [];
  try {
    credentials = await listCredentialsImpl({ fetchImpl: redisFetchImpl });
  } catch (error) {
    if (error?.code !== 'POOL_NOT_CONFIGURED') throw error;
  }

  if (!credentials.length) {
    if (!apiKey) {
      const error = new Error('GEMINI_API_KEY chưa được cấu hình và Gemini pool chưa có key.');
      error.code = 'GEMINI_NOT_CONFIGURED';
      error.statusCode = 503;
      throw error;
    }
    credentials = [{ id: null, apiKey, exhaustedModels: [] }];
  }

  const attemptedModels = [];
  const attemptedCredentialIds = [];
  const attemptedRoutes = new Set();
  const sharedBusyRoutes = routeContext?.busyRouteIds instanceof Set ? routeContext.busyRouteIds : new Set();
  const sharedFailedRoutes = routeContext?.failedRouteIds instanceof Set ? routeContext.failedRouteIds : new Set();
  const routeIds = credentials.flatMap((credential) => models
    .filter((model) => !(credential.exhaustedModels || []).includes(model))
    .map((model) => geminiRouteId(credential.id, model)));
  const health = await getHealthSnapshotImpl({ fetchImpl: redisFetchImpl, routeIds });
  for (const credential of credentials) {
    if (!credential.id || (credential.exhaustedModels || []).includes(GEMINI_MODEL)) continue;
    const routeId = geminiRouteId(credential.id, GEMINI_MODEL);
    const state = health[routeId] || {};
    if (geminiRoutePressure(state, GEMINI_MODEL, Date.now()).dayRequests < configuredGeminiLimit(GEMINI_MODEL).rpd) continue;
    try {
      await markModelExhaustedImpl(credential, GEMINI_MODEL, { fetchImpl: redisFetchImpl });
    } catch {
      // Không chọn lại route đã đủ RPD dù đồng bộ trạng thái used tạm thời thất bại.
    }
    credential.exhaustedModels = [GEMINI_MODEL];
  }
  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
    const nowMs = Date.now();
    if (Number.isFinite(Number(deadlineAt)) && nowMs >= Number(deadlineAt)) {
      lastError = new Error(`${context} đã hết ngân sách thời gian.`);
      lastError.name = 'TimeoutError';
      lastError.attemptedModels = [...attemptedModels];
      lastError.attemptedCredentialIds = [...attemptedCredentialIds];
      lastError.attemptedRouteIds = [...attemptedRoutes];
      lastError.attempts = attemptedModels.length;
      break;
    }
    const candidates = [];
    credentials.forEach((credential, credentialIndex) => {
      const exhausted = new Set(credential.exhaustedModels || []);
      models.forEach((model, modelIndex) => {
        if (exhausted.has(model)) return;
        const routeId = geminiRouteId(credential.id, model);
        if (attemptedRoutes.has(routeId) || sharedFailedRoutes.has(routeId)) return;
        const state = health[routeId] || {};
        const pressureDetails = geminiRoutePressure(state, model, nowMs);
        const pressure = geminiRouteScore(state, model, nowMs);
        if (pressureDetails.dayRequests >= configuredGeminiLimit(model).rpd) return;
        candidates.push({
          credential,
          credentialIndex,
          model,
          modelIndex,
          routeId,
          state,
          pressure,
          score: pressureDetails.dayRequests * 1_000_000
            + pressureDetails.recentRequests * 10_000
            + pressureDetails.inFlight * 1_000
            + pressure * 10
            + credentialIndex * 0.01
        });
      });
    });
    if (!candidates.length) break;
    const usable = candidates.filter((candidate) => Number.isFinite(candidate.pressure));
    const idle = usable.filter((candidate) => !sharedBusyRoutes.has(candidate.routeId));
    const choices = idle.length ? idle : usable;
    if (!choices.length) {
      lastError ||= new Error(`${context} đang chờ API key Gemini hết thời gian pending.`);
      lastError.code = 'GEMINI_KEYS_PENDING';
      break;
    }
    choices.sort((left, right) => left.score - right.score
      || Number(left.state?.cooldownUntilMs || 0) - Number(right.state?.cooldownUntilMs || 0));
    const selected = choices[0];
    const { credential, model, routeId } = selected;
    attemptedRoutes.add(routeId);
    sharedBusyRoutes.add(routeId);
    attemptedModels.push(model);
    if (credential.id && !attemptedCredentialIds.includes(credential.id)) attemptedCredentialIds.push(credential.id);

    let attempt;
    let request;
    let reservedTokens = 0;
    let responseTokens = 0;
    try {
      request = buildRequest(model, credential.apiKey);
      const bodyLength = typeof request?.body === 'string' ? request.body.length : 0;
      let maxOutputTokens = 0;
      try { maxOutputTokens = Number(JSON.parse(request?.body || '{}')?.generationConfig?.maxOutputTokens) || 0; } catch {}
      reservedTokens = Math.max(1, Math.ceil(bodyLength / 4) + maxOutputTokens);
      const reservation = await beginRouteImpl(routeId, {
        fetchImpl: redisFetchImpl,
        nowMs,
        model,
        reservedTokens
      });
      if (reservation?.ok === false) {
        if (reservation.state) health[routeId] = reservation.state;
        const error = new Error(`${context} tạm bỏ qua API key đang chạm ${reservation.code || 'giới hạn quota'}.`);
        error.code = reservation.code || 'GEMINI_ROUTE_UNAVAILABLE';
        error.model = model;
        error.credentialId = credential.id;
        lastError = error;
        sharedFailedRoutes.add(routeId);
        continue;
      }
      if (reservation?.state) health[routeId] = reservation.state;
      const remainingMs = Number.isFinite(Number(deadlineAt)) ? Number(deadlineAt) - Date.now() : timeoutMs;
      attempt = await fetchGemini(
        fetchImpl,
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { ...request, signal: attemptSignal(request?.signal, Math.max(10, Math.min(timeoutMs, remainingMs))) },
        context,
        model
      );
    } finally {
      sharedBusyRoutes.delete(routeId);
    }
    if (attempt.response) {
      responseTokens = await responseTokenCount(attempt.response);
      let validatedValue;
      if (typeof validateResponse === 'function') {
        try {
          const validationResponse = typeof attempt.response.clone === 'function' ? attempt.response.clone() : attempt.response;
          validatedValue = await validateResponse(validationResponse);
        } catch (cause) {
          const error = new Error(`${context} trả dữ liệu không hợp lệ: ${truncate(cause?.message || cause || 'sai schema')}`);
          error.code = 'GEMINI_INVALID_RESPONSE';
          error.statusCode = 200;
          error.model = model;
          error.transient = true;
          attempt = { error, latencyMs: attempt.latencyMs };
        }
      }
      if (attempt.response) {
        const state = await finishRouteImpl(routeId, {
          ok: true,
          statusCode: Number(attempt.response.status) || 200,
          latencyMs: attempt.latencyMs,
          tokens: responseTokens,
          reservedTokens
        }, { fetchImpl: redisFetchImpl });
        if (state) health[routeId] = state;
        const completedDayRequests = Number(state?.dayRequests ?? (geminiRoutePressure(selected.state, model, nowMs).dayRequests + 1));
        if (credential.id && completedDayRequests >= configuredGeminiLimit(model).rpd) {
          try {
            await markModelExhaustedImpl(credential, model, { fetchImpl: redisFetchImpl });
          } catch {
            // Request hợp lệ vẫn phải được trả về; health đã chặn route tại RPD.
          }
          credential.exhaustedModels = [model];
        }
        return {
          response: attempt.response,
          model,
          attemptedModels,
          credentialId: credential.id,
          attemptedCredentialIds,
          attemptedRouteIds: [...attemptedRoutes],
          attempts: attemptIndex + 1,
          finalAttemptLatencyMs: attempt.latencyMs,
          totalDurationMs: Date.now() - requestStartedAt,
          value: validatedValue
        };
      }
    }

    lastError = attempt.error;
    lastError.model = model;
    lastError.credentialId = credential.id;
    lastError.attemptedModels = [...attemptedModels];
    lastError.attemptedCredentialIds = [...attemptedCredentialIds];
    lastError.attempts = attemptIndex + 1;
    lastError.totalDurationMs = Date.now() - requestStartedAt;
    lastError.attemptedRouteIds = [...attemptedRoutes];
    const state = await finishRouteImpl(routeId, {
      ok: false,
      statusCode: lastError.statusCode,
      latencyMs: attempt.latencyMs,
      errorType: healthErrorType(lastError),
      reservedTokens,
      tokens: responseTokens
    }, { fetchImpl: redisFetchImpl });
    if (state) health[routeId] = state;

    const timedOut = healthErrorType(lastError) === 'timeout';
    sharedFailedRoutes.add(routeId);

    const completedDayRequests = Number(state?.dayRequests ?? (geminiRoutePressure(selected.state, model, nowMs).dayRequests + 1));
    const dailyLimitReached = completedDayRequests >= configuredGeminiLimit(model).rpd;
    const permanentlyUnavailable = [401, 403].includes(Number(lastError.statusCode));
    if (credential.id && (dailyLimitReached || permanentlyUnavailable || (lastError.quotaExhausted && lastError.quotaScope === 'day'))) {
      try {
        await markModelExhaustedImpl(credential, model, { fetchImpl: redisFetchImpl });
      } catch {
        // Health state đã cooldown route; lỗi cập nhật danh sách used không được chặn retry key khác.
      }
      credential.exhaustedModels = [model];
    }
    if (request?.signal?.aborted) throw lastError;
    if (timedOut && !retryOnTimeout) throw lastError;
    // Mọi lỗi của route hiện tại đều đưa key vào pending/used và chuyển ngay
    // sang key khác. attemptedRoutes đảm bảo không gọi lại cùng key trong request này.
  }
  throw lastError || new Error(`${context} không còn route Gemini khả dụng sau ${maxAttempts} lần thử.`);
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

export function geminiThinkingConfig(level = 'minimal') {
  return { thinkingLevel: level };
}
