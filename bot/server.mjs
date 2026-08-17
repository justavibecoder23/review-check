import express from 'express';
import { chromium } from 'playwright';

const app = express();
const port = Number(process.env.PORT || 8080);
const token = process.env.REVIEWS_BOT_TOKEN;
const cache = new Map();
let collecting = false;

app.use(express.json({ limit: '16kb' }));

function isShopeeUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'shopee.vn' || host.endsWith('.shopee.vn');
  } catch {
    return false;
  }
}

function extractShopeeIds(url) {
  const direct = url.match(/-i\.(\d+)\.(\d+)/);
  const product = url.match(/\/product\/(\d+)\/(\d+)/);
  const [, shopId, itemId] = direct || product || [];
  return shopId && itemId ? { shopId, itemId } : null;
}

function toReview(rating) {
  return {
    rating: Number(rating.rating_star) || 0,
    text: String(rating.comment || '').trim(),
    date: rating.mtime ? new Date(rating.mtime * 1000).toISOString() : 'Không rõ ngày',
    verified: Boolean(rating.orderid || rating.order_id),
    author: rating.author_username || 'Khách đã mua'
  };
}

async function collectShopeeReviews(productUrl, limit) {
  const ids = extractShopeeIds(productUrl);
  if (!ids) throw Object.assign(new Error('Bot không đọc được mã sản phẩm từ link Shopee.'), { statusCode: 400 });

  const endpoint = new URL('https://shopee.vn/api/v4/item/get_ratings');
  endpoint.search = new URLSearchParams({
    itemid: ids.itemId, shopid: ids.shopId, limit: String(limit), offset: '0', type: '0', filter: '0'
  }).toString();

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ locale: 'vi-VN', viewport: { width: 1365, height: 900 } });
    const page = await context.newPage();
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(1_000);

    const result = await page.evaluate(async (apiUrl) => {
      const response = await fetch(apiUrl, { credentials: 'include', headers: { accept: 'application/json' } });
      return { status: response.status, body: await response.text() };
    }, endpoint.toString());

    if (result.status !== 200) {
      throw Object.assign(new Error(`Shopee từ chối phiên thu thập (HTTP ${result.status}).`), { statusCode: 502 });
    }
    const payload = JSON.parse(result.body);
    const reviews = (payload?.data?.ratings || []).map(toReview).filter((review) => review.text);
    if (!reviews.length) throw Object.assign(new Error('Shopee không trả về review có nội dung.'), { statusCode: 502 });
    return reviews;
  } finally {
    await browser.close();
  }
}

app.get('/health', (_request, response) => response.json({ ok: true }));

app.post('/reviews', async (request, response) => {
  if (token && request.get('authorization') !== `Bearer ${token}`) {
    return response.status(401).json({ error: 'Không có quyền gọi bot.' });
  }
  const { url, platform, limit: requestedLimit = 50 } = request.body || {};
  if (platform !== 'Shopee' || !isShopeeUrl(url)) {
    return response.status(501).json({ error: 'Bot hiện chỉ hỗ trợ link Shopee Việt Nam.' });
  }
  if (collecting) return response.status(429).json({ error: 'Bot đang xử lý một yêu cầu khác, hãy thử lại sau.' });

  const limit = Math.min(Math.max(Number(requestedLimit) || 50, 1), 50);
  const key = `${url}:${limit}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return response.json({ reviews: cached.reviews, cached: true });

  collecting = true;
  try {
    const reviews = await collectShopeeReviews(url, limit);
    cache.set(key, { reviews, expiresAt: Date.now() + 15 * 60_000 });
    return response.json({ reviews, cached: false });
  } catch (error) {
    return response.status(error.statusCode || 502).json({ error: error.message || 'Không thể lấy review từ Shopee.' });
  } finally {
    collecting = false;
  }
});

app.listen(port, '0.0.0.0', () => console.log(`Review collector listening on ${port}`));
