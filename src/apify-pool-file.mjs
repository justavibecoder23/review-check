const STARS = Object.freeze([5, 4, 3, 2, 1]);

export function normalizeApifyTokens(lines) {
  return lines.map((line) => String(line || '').trim()).filter(Boolean);
}

export function buildApifyPoolFile(tokens, options = {}) {
  const normalized = normalizeApifyTokens(tokens);
  if (!normalized.length) throw new Error('Chưa có API key nào được nhập.');
  if (normalized.length % STARS.length !== 0) {
    throw new Error(`Cần số lượng key chia hết cho 5. Hiện có ${normalized.length} key.`);
  }
  const duplicateCount = normalized.length - new Set(normalized).size;
  if (duplicateCount) throw new Error(`Phát hiện ${duplicateCount} API key bị trùng.`);

  const mode = options.mode === 'append' ? 'append' : 'replace';
  const maxUsesPerKey = Number.parseInt(String(options.maxUsesPerKey ?? 10), 10);
  if (!Number.isInteger(maxUsesPerKey) || maxUsesPerKey < 1) {
    throw new Error('maxUsesPerKey phải là số nguyên dương.');
  }

  const groupPrefix = String(options.groupPrefix || 'group').trim() || 'group';
  const startGroup = Number.parseInt(String(options.startGroup ?? 1), 10);
  if (!Number.isInteger(startGroup) || startGroup < 1) throw new Error('startGroup phải là số nguyên dương.');

  const groups = [];
  for (let offset = 0; offset < normalized.length; offset += STARS.length) {
    const number = startGroup + offset / STARS.length;
    const groupNumber = String(number).padStart(2, '0');
    groups.push({
      label: `${groupPrefix}-${groupNumber}`,
      credentials: STARS.map((star, index) => ({
        star,
        label: `${groupPrefix}-${groupNumber}-${star}-star`,
        token: normalized[offset + index]
      }))
    });
  }

  return { mode, maxUsesPerKey, groups };
}
