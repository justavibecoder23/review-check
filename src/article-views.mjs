import { createHash } from 'node:crypto';
import { isRedisConfigured, redisCommand } from './redis-rest.mjs';

const VIEW_WINDOW_SECONDS = 6 * 60 * 60;
const memoryCounts = new Map();
const memoryVisitors = new Map();

export function normalizeArticleSlug(value) {
  const slug = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 100) {
    const error = new Error('Mã bài viết không hợp lệ.');
    error.statusCode = 400;
    error.code = 'INVALID_ARTICLE_SLUG';
    throw error;
  }
  return slug;
}

export function articleVisitorKey(request, slug) {
  const forwarded = String(request?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const address = forwarded || String(request?.socket?.remoteAddress || 'unknown');
  const userAgent = String(request?.headers?.['user-agent'] || 'unknown').slice(0, 300);
  return createHash('sha256').update(`${slug}|${address}|${userAgent}`).digest('hex').slice(0, 32);
}

export async function readArticleViews(value) {
  const slug = normalizeArticleSlug(value);
  if (!isRedisConfigured()) return memoryCounts.get(slug) || 0;
  const count = Number(await redisCommand(['GET', `realview:article:views:v1:${slug}`]));
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

export async function recordArticleView(value, visitorKey) {
  const slug = normalizeArticleSlug(value);
  const visitor = String(visitorKey || '').trim();
  if (!visitor) {
    const error = new Error('Không xác định được lượt xem.');
    error.statusCode = 400;
    error.code = 'INVALID_VISITOR';
    throw error;
  }

  if (!isRedisConfigured()) {
    const now = Date.now();
    const seenKey = `${slug}:${visitor}`;
    const seenUntil = memoryVisitors.get(seenKey) || 0;
    if (seenUntil <= now) {
      memoryVisitors.set(seenKey, now + VIEW_WINDOW_SECONDS * 1000);
      memoryCounts.set(slug, (memoryCounts.get(slug) || 0) + 1);
    }
    return memoryCounts.get(slug) || 0;
  }

  const uniqueKey = `realview:article:viewer:v1:${slug}:${visitor}`;
  const inserted = await redisCommand(['SET', uniqueKey, '1', 'NX', 'EX', VIEW_WINDOW_SECONDS]);
  if (inserted === 'OK') {
    return Number(await redisCommand(['INCR', `realview:article:views:v1:${slug}`])) || 0;
  }
  return readArticleViews(slug);
}

export const articleViewInternals = { VIEW_WINDOW_SECONDS, memoryCounts, memoryVisitors };
