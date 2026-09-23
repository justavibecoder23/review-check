import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { waitUntil } from '@vercel/functions';
import {
  getTikTokProductMetadata,
  isMirroredProductImage,
  setTikTokProductMetadata
} from './product-cache.mjs';
import { fetchProductPageMetaCandidates } from './sources.mjs';

const MAX_IMAGE_BYTES = 7 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 20_000;

function productIdOf(product = {}) {
  const value = String(product.productId || '').trim();
  return /^\d{8,25}$/.test(value) ? value : '';
}

function trustedTikTokProductUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' && /(^|\.)(?:tiktok\.com|tiktokshop\.com)$/i.test(url.hostname) ? url.href : '';
  } catch {
    return '';
  }
}

function trustedProductImageUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    const trustedHost = /(^|\.)(?:ibyteimg|byteimg|tiktokcdn|tiktokcdn-us)\.com$/i.test(url.hostname)
      || /\.public\.blob\.vercel-storage\.com$/i.test(url.hostname);
    return url.protocol === 'https:' && trustedHost ? url.href : '';
  } catch {
    return '';
  }
}

export async function readMirroredProductImage(productId, options = {}) {
  const metadata = await getTikTokProductMetadata(productId, options).catch(() => null);
  if (!metadata || !isMirroredProductImage(metadata.image)) return null;
  return metadata;
}

async function downloadProductImage(url, options = {}) {
  const response = await (options.fetchImpl || fetch)(url, {
    headers: {
      accept: 'image/avif,image/webp,image/jpeg,image/png',
      'user-agent': 'Mozilla/5.0 (compatible; RealViewProductMedia/1.0)'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(options.timeoutMs || IMAGE_FETCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`Ảnh sản phẩm trả về HTTP ${response.status}.`);
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith('image/')) throw new Error('URL sản phẩm không trả về dữ liệu ảnh.');
  const declaredSize = Number(response.headers.get('content-length')) || 0;
  if (declaredSize > MAX_IMAGE_BYTES) throw new Error('Ảnh sản phẩm vượt giới hạn dung lượng.');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error('Ảnh sản phẩm không hợp lệ.');
  return buffer;
}

export async function mirrorTikTokProductImage(product = {}, options = {}) {
  const productId = productIdOf(product);
  if (!productId || !String(product.platform || '').toLowerCase().includes('tiktok')) {
    return { status: 'skipped', reason: 'not_tiktok' };
  }
  const existing = await readMirroredProductImage(productId, options);
  if (existing) return { status: 'ready', metadata: existing, cached: true };

  const token = options.blobToken
    || process.env.PRODUCT_MEDIA_BLOB_TOKEN
    || process.env.BLOG_MEDIA_BLOB_TOKEN;
  if (!token && !options.blobPutImpl) return { status: 'skipped', reason: 'blob_not_configured' };

  let title = String(product.title || '').trim();
  const productUrl = trustedTikTokProductUrl(product.url);
  const firstImage = trustedProductImageUrl(product.image || product.imageUrl || product.thumbnail);
  let pageMeta = {};
  const loadPageMeta = async () => {
    if (pageMeta.title || pageMeta.image) return pageMeta;
    if (!productUrl) return pageMeta;
    pageMeta = await (options.fetchProductMetaImpl || fetchProductPageMetaCandidates)([productUrl], {
      expectedProductId: productId,
      timeoutMs: options.metadataTimeoutMs || 15_000,
      fetchImpl: options.fetchImpl
    }).catch(() => ({}));
    return pageMeta;
  };
  if (!title || !firstImage) {
    await loadPageMeta();
    title ||= String(pageMeta.title || '').trim();
  }
  const images = [...new Set([firstImage, trustedProductImageUrl(pageMeta.image)].filter(Boolean))];
  if (!images.length) return { status: 'unavailable', reason: 'image_missing' };
  let image = images[0];
  if (isMirroredProductImage(image)) {
    const saved = await setTikTokProductMetadata(productId, { ...product, title, image }, {
      ...options,
      source: 'blob-mirror'
    });
    return { status: 'ready', metadata: saved.metadata };
  }

  let sourceBuffer = null;
  let lastError;
  for (const candidate of images) {
    try {
      sourceBuffer = await downloadProductImage(candidate, options);
      image = candidate;
      break;
    } catch (error) {
      lastError = error;
      // If the actor CDN URL is stale, inspect the product page once for an
      // alternate current image before giving up. This remains background work.
      if (candidate === firstImage && images.length === 1) {
        await loadPageMeta();
        const alternate = trustedProductImageUrl(pageMeta.image);
        if (alternate && alternate !== candidate) images.push(alternate);
      }
    }
  }
  if (!sourceBuffer) throw lastError || new Error('Không tải được ảnh sản phẩm.');
  const processed = await (options.sharpImpl || sharp)(sourceBuffer, {
    failOn: 'error',
    animated: false,
    limitInputPixels: 40_000_000
  })
    .rotate()
    .resize({ width: 960, height: 960, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 84, effort: 4 })
    .toBuffer();
  const digest = createHash('sha256').update(processed).digest('hex').slice(0, 16);
  const pathname = `product-media/tiktok/${productId}/${digest}.webp`;
  const put = options.blobPutImpl || (await import('@vercel/blob')).put;
  const stored = await put(pathname, processed, {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'image/webp',
    token
  });
  const saved = await setTikTokProductMetadata(productId, {
    ...product,
    ...(title ? { title } : {}),
    image: stored.url
  }, {
    ...options,
    source: 'blob-mirror'
  });
  console.log(JSON.stringify({
    level: 'info',
    event: 'product_image_mirrored',
    platform: 'TikTok Shop',
    productId,
    sourceHost: new URL(image).hostname
  }));
  return { status: 'ready', metadata: saved.metadata };
}

export function scheduleProductImageMirror(product, options = {}) {
  const task = mirrorTikTokProductImage(product, options).catch((error) => {
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'product_image_mirror_failed',
      productId: productIdOf(product),
      error: String(error?.message || error).slice(0, 180)
    }));
    return { status: 'unavailable', reason: 'mirror_failed' };
  });
  try {
    (options.waitUntilImpl || waitUntil)(task);
  } catch {
    void task;
  }
  return true;
}

export const productImageBackgroundInternals = {
  IMAGE_FETCH_TIMEOUT_MS,
  MAX_IMAGE_BYTES,
  downloadProductImage,
  productIdOf,
  trustedProductImageUrl,
  trustedTikTokProductUrl
};
