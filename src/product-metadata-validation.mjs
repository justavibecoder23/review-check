const CHALLENGE_TITLE = /^(?:security check|access denied|verify (?:you are human|your identity)|just a moment(?:\.\.\.)?|captcha|robot check|please enable javascript|truy cập bị từ chối|xác minh bảo mật|kiểm tra bảo mật)(?:\s*[-|:]\s*(?:shopee|tiktok(?: shop)?))?$/i;
const CHALLENGE_HTML = /(?:<title[^>]*>\s*(?:security check|access denied|just a moment|captcha|robot check)|cf-chl-|id=["'](?:captcha|challenge-form)|captcha\.shopee|verify you are human)/i;

export function cleanProductTitle(value) {
  const title = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return title && !CHALLENGE_TITLE.test(title) ? title : '';
}

export function isMarketplaceChallengePage(html) {
  return CHALLENGE_HTML.test(String(html || ''));
}
