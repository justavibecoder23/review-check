const SHOPEE_HOSTS = new Set([
  'shopee.vn',
  'www.shopee.vn',
  's.shopee.vn',
  'shope.ee',
  'www.shope.ee',
  'vn.shp.ee'
]);

function cleanHostname(value) {
  return String(value || '').toLowerCase().replace(/\.$/, '');
}

function stripTrailingPunctuation(value) {
  return String(value || '').replace(/[\]\[}{),.;]+$/g, '');
}

function extractUrlCandidate(rawInput) {
  const input = String(rawInput || '').trim();
  try {
    const direct = new URL(input);
    if (['https:', 'http:'].includes(direct.protocol)) return direct.href;
  } catch {
    // Nội dung chia sẻ từ ứng dụng thường chứa thêm tên và giá sản phẩm.
  }

  const markdownUrl = input.match(/\]\((https?:\/\/[^\s)]+)\)/i)?.[1];
  const plainUrl = input.match(/https?:\/\/[^\s<>"']+/i)?.[0];
  const bareMarketplaceUrl = input.match(/(?:^|\s)((?:(?:www\.)?shopee\.vn|s\.shopee\.vn|(?:www\.)?shope\.ee|vn\.shp\.ee|(?:[a-z0-9-]+\.)*tiktok\.com)\/[^\s<>"']+)/i)?.[1];
  return stripTrailingPunctuation(markdownUrl || plainUrl || bareMarketplaceUrl || '');
}

function isTikTokHost(hostname) {
  const host = cleanHostname(hostname);
  return host === 'tiktok.com' || host.endsWith('.tiktok.com');
}

export function validateMarketplaceInput(rawInput) {
  const input = String(rawInput || '').trim();
  if (!input) {
    return { valid: false, message: 'Hãy dán link sản phẩm Shopee hoặc TikTok Shop.' };
  }
  if (input.length > 8000) {
    return { valid: false, message: 'Link hoặc nội dung được dán quá dài.' };
  }

  const candidate = extractUrlCandidate(input);
  if (!candidate) {
    return { valid: false, message: 'Không tìm thấy link sản phẩm hợp lệ trong nội dung đã dán.' };
  }

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
  } catch {
    return { valid: false, message: 'Link không đúng định dạng. Hãy sao chép lại từ Shopee hoặc TikTok Shop.' };
  }

  if (url.protocol !== 'https:') {
    return { valid: false, message: 'Link sản phẩm phải sử dụng kết nối HTTPS an toàn.' };
  }
  if (url.username || url.password || (url.port && url.port !== '443')) {
    return { valid: false, message: 'Link chứa thông tin kết nối không được hỗ trợ.' };
  }

  const host = cleanHostname(url.hostname);
  const platform = SHOPEE_HOSTS.has(host) ? 'Shopee' : isTikTokHost(host) ? 'TikTok Shop' : '';
  if (!platform) {
    return { valid: false, message: 'RealView hiện chỉ hỗ trợ link sản phẩm Shopee hoặc TikTok Shop.' };
  }

  return { valid: true, url: url.href, platform, message: '' };
}
