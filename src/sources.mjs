const DEMO_REVIEWS = [
  { rating: 5, text: 'Nhận xu nên đánh giá cho shop 5 sao nha mọi người.', date: '12/08/2026', verified: false },
  { rating: 5, text: 'Hàng đẹp, giao nhanh, đóng gói kỹ.', date: '11/08/2026', verified: false },
  { rating: 2, text: 'Vải mỏng hơn nhiều so với ảnh, mặc lên nhìn form khá chật dù đã chọn đúng size thường mặc.', date: '10/08/2026', verified: true },
  { rating: 3, text: 'Màu thực tế tối hơn hình. Form nhỏ, ai thích mặc rộng nên tăng một size.', date: '09/08/2026', verified: true },
  { rating: 2, text: 'Đợi hàng lâu hơn dự kiến. Sản phẩm không lỗi nhưng chất vải mỏng, không hợp giá này.', date: '08/08/2026', verified: true },
  { rating: 4, text: 'Kiểu dáng ổn, nhưng đường may hơi thô và vải khá bí khi mặc trời nóng.', date: '07/08/2026', verified: true },
  { rating: 5, text: 'Chưa dùng nhưng thấy đóng gói đẹp.', date: '06/08/2026', verified: false },
  { rating: 3, text: 'Giao chậm 4 ngày, hộp bị móp nhẹ. Dùng tạm ổn nhưng màu nhận được khác hình.', date: '05/08/2026', verified: true },
  { rating: 4, text: 'Sản phẩm đúng nhu cầu, tuy nhiên form nhỏ hơn bảng size khoảng một cỡ.', date: '04/08/2026', verified: true },
  { rating: 1, text: 'Nhận về có lỗi ở đường may, vải mỏng và bị xù nhẹ sau hai lần giặt.', date: '03/08/2026', verified: true },
  { rating: 5, text: 'Tốt', date: '02/08/2026', verified: false },
  { rating: 3, text: 'Không giống màu trên ảnh, giao hàng hơi lâu nhưng shop có phản hồi.', date: '01/08/2026', verified: true }
];

function platformFrom(url) {
  const host = new URL(url).hostname.toLowerCase();
  if (host.includes('shopee.')) return 'Shopee';
  if (host === 'vm.tiktok.com' || host === 'vt.tiktok.com' || host.includes('tiktok.com')) return 'TikTok Shop';
  throw Object.assign(new Error('Link chưa thuộc Shopee hoặc TikTok Shop.'), { statusCode: 400 });
}

function extractShopeeIds(url) {
  const direct = url.match(/-i\.(\d+)\.(\d+)/);
  const product = url.match(/\/product\/(\d+)\/(\d+)/);
  const [, shopId, itemId] = direct || product || [];
  return shopId && itemId ? { shopId, itemId } : null;
}

function mapShopeeRating(rating) {
  return {
    rating: rating.rating_star || 0,
    text: rating.comment || '',
    date: rating.mtime ? new Date(rating.mtime * 1000).toLocaleDateString('vi-VN') : 'Không rõ ngày',
    verified: Boolean(rating.author_username),
    author: rating.author_username || 'Khách đã mua'
  };
}

async function loadShopeeReviews(url) {
  const ids = extractShopeeIds(url);
  if (!ids) throw new Error('Không đọc được mã sản phẩm từ link Shopee này.');
  const query = new URLSearchParams({ itemid: ids.itemId, shopid: ids.shopId, limit: '50', offset: '0', type: '0', filter: '0' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`https://shopee.vn/api/v4/item/get_ratings?${query}`, {
      headers: { 'user-agent': 'Mozilla/5.0', 'accept': 'application/json' },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Shopee trả về HTTP ${response.status}`);
    const body = await response.json();
    const reviews = (body?.data?.ratings || []).map(mapShopeeRating).filter((item) => item.text);
    if (!reviews.length) throw new Error('Shopee không trả về bình luận công khai.');
    return reviews;
  } finally {
    clearTimeout(timer);
  }
}

async function loadFromConfiguredBot(url, platform) {
  const endpoint = process.env.REVIEWS_BOT_URL;
  if (!endpoint) throw new Error('Chưa cấu hình bot thu thập đánh giá.');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: process.env.REVIEWS_BOT_TOKEN ? `Bearer ${process.env.REVIEWS_BOT_TOKEN}` : '' },
    body: JSON.stringify({ url, platform, limit: 50 })
  });
  if (!response.ok) throw new Error(`Bot trả về HTTP ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body.reviews)) throw new Error('Bot không trả về danh sách reviews hợp lệ.');
  return body.reviews.map((review) => ({
    rating: Number(review.rating) || 0,
    text: String(review.text || ''),
    date: review.date || 'Không rõ ngày',
    verified: Boolean(review.verified),
    author: review.author || 'Khách đã mua'
  })).filter((review) => review.text);
}

export async function getReviews(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw Object.assign(new Error('Link không hợp lệ.'), { statusCode: 400 }); }
  const platform = platformFrom(parsed.href);
  const warnings = [];
  try {
    const reviews = process.env.REVIEWS_BOT_URL
      ? await loadFromConfiguredBot(parsed.href, platform)
      : platform === 'Shopee'
        ? await loadShopeeReviews(parsed.href)
        : await loadFromConfiguredBot(parsed.href, platform);
    return {
      reviews,
      source: { type: 'live', label: process.env.REVIEWS_BOT_URL ? 'Bot thu thập đã cấu hình' : 'Bình luận công khai Shopee' },
      product: { platform, url: parsed.href },
      warnings
    };
  } catch (error) {
    if (process.env.ALLOW_DEMO_REVIEWS !== 'true') {
      throw Object.assign(new Error(`Không lấy được review thật từ ${platform}: ${error.message}`), { statusCode: 502 });
    }
    warnings.push(`Không thể lấy dữ liệu trực tiếp: ${error.message}`);
    warnings.push('Đang hiển thị dữ liệu mô phỏng để kiểm tra luồng. Không dùng kết quả này để quyết định mua hàng.');
    return {
      reviews: DEMO_REVIEWS,
      source: { type: 'demo', label: 'Dữ liệu mô phỏng' },
      product: { platform, url: parsed.href },
      warnings
    };
  }
}
