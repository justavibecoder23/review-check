export function normalizeGeminiApiKeys(lines) {
  return lines.map((line) => String(line || '').trim()).filter(Boolean);
}

export function buildGeminiPoolFile(apiKeys, options = {}) {
  const cleaned = normalizeGeminiApiKeys(apiKeys);
  const unique = [...new Set(cleaned)];
  if (!unique.length) throw new Error('Chưa có Gemini API key nào được nhập.');
  if (unique.length > 200) throw new Error('Pool Gemini không được vượt quá 200 API key.');
  const mode = options.mode === 'replace' ? 'replace' : 'append';
  const start = Number.parseInt(String(options.start ?? 1), 10);
  if (!Number.isInteger(start) || start < 1) throw new Error('start phải là số nguyên dương.');
  return {
    mode,
    credentials: unique.map((apiKey, index) => ({
      label: `gemini-key-${String(start + index).padStart(2, '0')}`,
      apiKey
    }))
  };
}
