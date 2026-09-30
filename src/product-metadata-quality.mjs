const BLOCKED_PRODUCT_TITLE_PATTERNS = [
  /^(?:security check|just a moment(?:\.{3})?|access denied|captcha|verification required|verify (?:you are human|to continue))(?:\s*[|\-–—]\s*(?:tiktok(?: shop)?|shopee))?$/i,
  /^(?:tiktok(?: shop)?|shopee)\s*[|\-–—]\s*(?:security check|just a moment(?:\.{3})?|access denied|verification required)$/i
];

export function cleanProductTitle(value) {
  const title = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!title) return '';
  const normalized = title.normalize('NFKC');
  return BLOCKED_PRODUCT_TITLE_PATTERNS.some((pattern) => pattern.test(normalized)) ? '' : title;
}

export function isBlockedProductTitle(value) {
  return Boolean(String(value || '').trim()) && !cleanProductTitle(value);
}
