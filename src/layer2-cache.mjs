import { createHash } from 'node:crypto';
import { isRedisConfigured, redisCommand, redisTransaction } from './redis-rest.mjs';

const CACHE_PREFIX = 'realview:layer2:v2.3.0:';
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

function cacheKey(item, product = {}) {
  const fingerprint = JSON.stringify({
    promptVersion: '2.3.0',
    title: String(product?.title || '').trim().toLowerCase(),
    category: String(product?.category || '').trim().toLowerCase(),
    platform: String(product?.platform || '').trim().toLowerCase(),
    rating: Number(item?.review?.rating) || 0,
    verified: Boolean(item?.review?.verified),
    text: String(item?.review?.text || '').replace(/\s+/g, ' ').trim().toLowerCase()
  });
  return `${CACHE_PREFIX}${createHash('sha256').update(fingerprint).digest('hex')}`;
}

function redisOptions(options = {}) {
  return {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    timeoutMs: Math.min(1_000, Math.max(100, Number(options.timeoutMs) || 700))
  };
}

export async function readLayer2Cache(items = [], product = {}, options = {}) {
  const result = new Map();
  if (!items.length || !isRedisConfigured()) return result;
  const keys = items.map((item) => cacheKey(item, product));
  try {
    const values = await redisCommand(['MGET', ...keys], redisOptions(options));
    items.forEach((item, index) => {
      try {
        const cached = values?.[index] ? JSON.parse(values[index]) : null;
        if (cached && typeof cached === 'object') {
          result.set(String(item.layer1.id), { ...cached, id: String(item.layer1.id) });
        }
      } catch {
        // Cache hỏng hoặc cũ chỉ là cache miss; Gemini sẽ kiểm định lại.
      }
    });
  } catch {
    // Cache không được phép làm gián đoạn pipeline phân tích.
  }
  return result;
}

export async function writeLayer2Cache(items = [], labels = [], product = {}, options = {}) {
  if (!items.length || !labels.length || !isRedisConfigured()) return;
  const labelsById = new Map(labels.map((label) => [String(label?.id || ''), label]));
  const commands = items.flatMap((item) => {
    const label = labelsById.get(String(item.layer1.id));
    if (!label) return [];
    const { id: _id, ...cacheValue } = label;
    return [['SET', cacheKey(item, product), JSON.stringify(cacheValue), 'EX', String(CACHE_TTL_SECONDS)]];
  });
  if (!commands.length) return;
  try {
    await redisTransaction(commands, redisOptions(options));
  } catch {
    // Ghi cache là tối ưu tùy chọn, không ảnh hưởng kết quả chính.
  }
}

export const LAYER2_CACHE_TTL_SECONDS = CACHE_TTL_SECONDS;
