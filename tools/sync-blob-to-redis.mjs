import { pathToFileURL } from 'node:url';
import {
  readPrivateBlobDataset,
  setCachedShopeeDataset,
  setCachedTikTokDataset,
  validateShopeeCachedDataset,
  validateTikTokCachedDataset
} from '../src/product-cache.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

function recentDatePrefixes(now = new Date()) {
  const prefixes = new Set();
  for (let offset = 0; offset <= 5; offset += 1) {
    prefixes.add(`review-datasets/${new Date(now.getTime() - offset * DAY_MS).toISOString().slice(0, 10).replaceAll('-', '/')}/`);
  }
  return [...prefixes];
}

async function listAll(listBlobs, prefix, token) {
  const blobs = [];
  let cursor;
  do {
    const page = await listBlobs({ prefix, cursor, limit: 1000, token });
    blobs.push(...(page.blobs || []));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export async function syncRecentProductDatasets(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const token = options.blobToken || process.env.BLOB_READ_WRITE_TOKEN;
  const requestedPlatforms = new Set(Array.isArray(options.platforms) && options.platforms.length
    ? options.platforms.map((platform) => String(platform).trim().toLowerCase())
    : ['shopee', 'tiktok']);
  const listBlobs = options.blobListImpl || (await import('@vercel/blob')).list;
  const pages = await Promise.all(recentDatePrefixes(now).map((prefix) => listAll(listBlobs, prefix, token)));
  const candidates = [...new Map(pages.flat()
    .filter((blob) => /\/(?:shopee-\d+|tiktok-\d{8,25})\/[^/]+\/reviews\.raw\.json$/u.test(String(blob.pathname || '')))
    .map((blob) => [blob.pathname, blob])).values()];

  const inspected = await mapWithConcurrency(candidates, 4, async (blob) => {
    const pathname = String(blob.pathname || '');
    const itemId = pathname.match(/\/shopee-(\d+)\//u)?.[1];
    const productId = pathname.match(/\/tiktok-(\d{8,25})\//u)?.[1];
    if (!itemId && !productId) return null;
    if (itemId && !requestedPlatforms.has('shopee')) return null;
    if (productId && !requestedPlatforms.has('tiktok')) return null;
    const dataset = await readPrivateBlobDataset({ rawPath: blob.pathname, rawUrl: blob.url }, {
      blobGetImpl: options.blobGetImpl,
      blobToken: token
    });
    const platform = itemId ? 'shopee' : 'tiktok';
    const validation = itemId
      ? validateShopeeCachedDataset(dataset, { itemId, now })
      : validateTikTokCachedDataset(dataset, { productId, now });
    return validation.valid ? { platform, itemId, productId, blob, dataset, validation } : null;
  });

  const latestByProduct = new Map();
  for (const candidate of inspected.filter(Boolean)) {
    const key = `${candidate.platform}:${candidate.itemId || candidate.productId}`;
    const current = latestByProduct.get(key);
    if (!current || Date.parse(candidate.dataset.createdAt) > Date.parse(current.dataset.createdAt)) {
      latestByProduct.set(key, candidate);
    }
  }

  let mapped = 0;
  const failures = [];
  const platformCounts = {
    shopee: { eligible: 0, products: 0, mapped: 0 },
    tiktok: { eligible: 0, products: 0, mapped: 0 }
  };
  for (const candidate of inspected.filter(Boolean)) platformCounts[candidate.platform].eligible += 1;
  for (const candidate of latestByProduct.values()) platformCounts[candidate.platform].products += 1;
  for (const candidate of latestByProduct.values()) {
    try {
      const location = {
        rawPath: candidate.blob.pathname,
        rawUrl: candidate.blob.url
      };
      const result = candidate.platform === 'shopee'
        ? await setCachedShopeeDataset(candidate.itemId, location, candidate.dataset, {
            redisFetchImpl: options.redisFetchImpl,
            now
          })
        : await setCachedTikTokDataset(candidate.productId, location, candidate.dataset, {
            redisFetchImpl: options.redisFetchImpl,
            now
          });
      if (result.saved) {
        mapped += 1;
        platformCounts[candidate.platform].mapped += 1;
      } else failures.push({
        platform: candidate.platform,
        productId: candidate.itemId || candidate.productId,
        reason: result.reason
      });
    } catch (error) {
      failures.push({
        platform: candidate.platform,
        productId: candidate.itemId || candidate.productId,
        reason: error?.message || 'UNKNOWN_ERROR'
      });
    }
  }

  return {
    scanned: candidates.length,
    eligible: inspected.filter(Boolean).length,
    products: latestByProduct.size,
    mapped,
    platforms: platformCounts,
    failures
  };
}

export async function syncRecentShopeeDatasets(options = {}) {
  const result = await syncRecentProductDatasets({ ...options, platforms: ['shopee'] });
  return {
    ...result,
    eligible: result.platforms.shopee.eligible,
    products: result.platforms.shopee.products,
    mapped: result.platforms.shopee.mapped
  };
}

async function main() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('Thiếu BLOB_READ_WRITE_TOKEN.');
  const platform = process.argv
    .find((argument) => argument.startsWith('--platform='))
    ?.slice('--platform='.length)
    .trim()
    .toLowerCase();
  if (platform && !['shopee', 'tiktok'].includes(platform)) {
    throw new Error('Platform đồng bộ phải là shopee hoặc tiktok.');
  }
  const result = await syncRecentProductDatasets(platform ? { platforms: [platform] } : {});
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.failures.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`Không đồng bộ được cache sản phẩm: ${error?.message || 'lỗi không xác định'}\n`);
    process.exitCode = 1;
  });
}
