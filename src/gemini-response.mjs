function truncate(value, maxLength = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export async function geminiHttpError(response, context = 'Gemini') {
  let detail = '';
  try {
    let payload = null;
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
  return new Error(`${context} trả về HTTP ${httpStatus}${detail ? `: ${detail}` : ''}`);
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
