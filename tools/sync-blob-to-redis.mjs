import { pathToFileURL } from 'node:url';
import {
  readPrivateBlobDataset,
  setCachedShopeeDataset,
  validateShopeeCachedDataset
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

export async function syncRecentShopeeDatasets(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const token = options.blobToken || process.env.BLOB_READ_WRITE_TOKEN;
  const listBlobs = options.blobListImpl || (await import('@vercel/blob')).list;
  const pages = await Promise.all(recentDatePrefixes(now).map((prefix) => listAll(listBlobs, prefix, token)));
  const candidates = [...new Map(pages.flat()
    .filter((blob) => /\/shopee-\d+\/[^/]+\/reviews\.raw\.json$/u.test(String(blob.pathname || '')))
    .map((blob) => [blob.pathname, blob])).values()];

  const inspected = await mapWithConcurrency(candidates, 4, async (blob) => {
    const itemId = String(blob.pathname).match(/\/shopee-(\d+)\//u)?.[1];
    if (!itemId) return null;
    const dataset = await readPrivateBlobDataset({ rawPath: blob.pathname, rawUrl: blob.url }, {
      blobGetImpl: options.blobGetImpl,
      blobToken: token
    });
    const validation = validateShopeeCachedDataset(dataset, { itemId, now });
    return validation.valid ? { itemId, blob, dataset, validation } : null;
  });

  const latestByItem = new Map();
  for (const candidate of inspected.filter(Boolean)) {
    const current = latestByItem.get(candidate.itemId);
    if (!current || Date.parse(candidate.dataset.createdAt) > Date.parse(current.dataset.createdAt)) {
      latestByItem.set(candidate.itemId, candidate);
    }
  }

  let mapped = 0;
  const failures = [];
  for (const candidate of latestByItem.values()) {
    try {
      const result = await setCachedShopeeDataset(candidate.itemId, {
        rawPath: candidate.blob.pathname,
        rawUrl: candidate.blob.url
      }, candidate.dataset, {
        redisFetchImpl: options.redisFetchImpl,
        now
      });
      if (result.saved) mapped += 1;
      else failures.push({ itemId: candidate.itemId, reason: result.reason });
    } catch (error) {
      failures.push({ itemId: candidate.itemId, reason: error?.message || 'UNKNOWN_ERROR' });
    }
  }

  return {
    scanned: candidates.length,
    eligible: inspected.filter(Boolean).length,
    products: latestByItem.size,
    mapped,
    failures
  };
}

async function main() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('Thiếu BLOB_READ_WRITE_TOKEN.');
  const result = await syncRecentShopeeDatasets();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.failures.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`Không đồng bộ được cache Shopee: ${error?.message || 'lỗi không xác định'}\n`);
    process.exitCode = 1;
  });
}
