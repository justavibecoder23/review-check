import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { slugifyBlogValue } from './blog-post-model.mjs';
import { isRedisConfigured } from './redis-rest.mjs';
import {
  MEDIA_LOCK_MS,
  MEDIA_RULE_VERSION,
  acquireMedia,
  auditMedia,
  finalizeMedia,
  readMediaMapping,
  releaseMedia,
  renewMedia,
  waitForMedia
} from './blog-media-dedup.mjs';

// Base64 adds roughly 33%. Keep the raw file below 3 MB so the JSON request
// remains under Vercel's serverless request-body ceiling.
const MAX_MEDIA_BYTES = 3 * 1024 * 1024;
const ALLOWED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']);
const RESPONSIVE_WIDTHS = [480, 960, 1600];
const TWO_WIDTHS = [800, 1600];

function widthProfile(options = {}) {
  // Opt-in until mobile KB/LCP and viewport comparisons are measured.
  return (options.widthProfile || process.env.BLOG_MEDIA_WIDTH_PROFILE) === 'two'
    ? TWO_WIDTHS : RESPONSIVE_WIDTHS;
}

function fingerprint(buffer, widths) {
  return createHash('sha256').update(MEDIA_RULE_VERSION).update(':sharp-webp-q84-effort4:')
    .update(widths.join(',')).update(':').update(buffer).digest('hex');
}

function assetFromMapping(mapping, media, actor) {
  const primary = mapping.responsiveSources.at(-1);
  return {
    id: mapping.id,
    url: primary.url,
    pathname: primary.pathname,
    width: primary.width,
    height: primary.height,
    size: primary.size,
    contentType: 'image/webp',
    responsiveSources: mapping.responsiveSources,
    alt: media.alt,
    uploadedBy: {
      id: String(actor.account?.id || actor.id || ''),
      email: String(actor.account?.email || actor.email || '').toLowerCase()
    }
  };
}

function temporaryMediaError() {
  return mediaError('Ảnh đang được xử lý hoặc kho lưu trữ tạm thời bận. Vui lòng thử lại sau ít phút.',
    503, 'BLOG_MEDIA_RETRY');
}

async function inspectUncertainPut(pathname, processed, token, options) {
  const head = options.blobHeadImpl || (await import('@vercel/blob')).head;
  try {
    const object = await head(pathname, { token });
    if (object?.pathname !== pathname || Number(object.size) !== processed.data.length
      || object.contentType !== 'image/webp' || !object.url) return null;
    return object;
  } catch (error) {
    if (error?.name === 'BlobNotFoundError' || error?.code === 'BLOB_NOT_FOUND') return null;
    throw error;
  }
}

function startHeartbeat(lease, options) {
  let stopped = false;
  let lost = false;
  let inFlight = Promise.resolve();
  const interval = setInterval(() => {
    if (stopped) return;
    inFlight = inFlight.then(async () => {
      if (!stopped && !(await renewMedia(lease, options))) lost = true;
    }).catch(() => { lost = true; });
  }, Math.min(10_000, Math.floor(MEDIA_LOCK_MS / 3)));
  interval.unref?.();
  return {
    async assertOwned() {
      await inFlight;
      if (lost) throw temporaryMediaError();
      try {
        if (!(await renewMedia(lease, options))) throw temporaryMediaError();
      } catch { lost = true; throw temporaryMediaError(); }
    },
    async stop() { stopped = true; clearInterval(interval); await inFlight; }
  };
}

function mediaError(message, statusCode = 400, code = 'BLOG_MEDIA_ERROR') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function normalizeBlobUploadError(error) {
  const message = String(error?.message || '');
  if (/public access on a private store|private store|configured with private access/i.test(message)) {
    return mediaError(
      'Kho ảnh Blog Studio đang ở chế độ Private. Hãy cấu hình BLOG_MEDIA_BLOB_TOKEN trỏ tới Blob Store Public.',
      503,
      'BLOG_MEDIA_PUBLIC_STORE_REQUIRED'
    );
  }
  return mediaError('Không thể tải ảnh lên kho lưu trữ lúc này.', 502, 'BLOG_MEDIA_UPLOAD_FAILED');
}

export function decodeBlogMedia(input = {}) {
  const contentType = String(input.contentType || '').trim().toLowerCase();
  if (!ALLOWED_MEDIA_TYPES.has(contentType)) {
    throw mediaError('Chỉ hỗ trợ ảnh JPEG, PNG, WebP, AVIF hoặc GIF.', 415, 'BLOG_MEDIA_TYPE_UNSUPPORTED');
  }
  let base64 = String(input.data || '').trim();
  const dataUrl = base64.match(/^data:([^;,]+);base64,(.+)$/s);
  if (dataUrl) {
    if (dataUrl[1].toLowerCase() !== contentType) throw mediaError('MIME của ảnh không khớp dữ liệu tải lên.', 400, 'BLOG_MEDIA_MIME_MISMATCH');
    base64 = dataUrl[2];
  }
  if (!base64 || !/^[a-zA-Z0-9+/=\s]+$/.test(base64)) {
    throw mediaError('Dữ liệu ảnh base64 không hợp lệ.', 400, 'BLOG_MEDIA_INVALID_BASE64');
  }
  const buffer = Buffer.from(base64.replace(/\s+/g, ''), 'base64');
  if (!buffer.length) throw mediaError('Ảnh tải lên đang rỗng.', 400, 'BLOG_MEDIA_EMPTY');
  if (buffer.length > MAX_MEDIA_BYTES) throw mediaError('Ảnh tải lên vượt quá giới hạn 3 MB.', 413, 'BLOG_MEDIA_TOO_LARGE');
  return {
    buffer,
    contentType,
    fileName: String(input.fileName || 'blog-image').slice(0, 200),
    alt: String(input.alt || '').trim().slice(0, 300)
  };
}

export async function saveBlogMedia(input = {}, actor = {}, options = {}) {
  const token = options.blobToken || process.env.BLOG_MEDIA_BLOB_TOKEN || process.env.BLOB_READ_WRITE_TOKEN;
  if (!token && !options.blobPutImpl) {
    throw mediaError('Kho ảnh blog chưa được cấu hình.', 503, 'BLOG_MEDIA_STORAGE_UNAVAILABLE');
  }
  const media = decodeBlogMedia(input);
  const put = options.blobPutImpl || (await import('@vercel/blob')).put;
  const widths = widthProfile(options);
  const hash = fingerprint(media.buffer, widths);
  const useDedup = options.redisCommandImpl || options.redisFetchImpl || isRedisConfigured();
  if (!useDedup && process.env.VERCEL_ENV) {
    throw mediaError('Kho chỉ mục ảnh blog chưa được cấu hình.', 503, 'BLOG_MEDIA_INDEX_UNAVAILABLE');
  }
  const requestId = (options.randomUUIDImpl || randomUUID)();
  const auditData = { requestId, hash, ruleVersion: MEDIA_RULE_VERSION,
    actorId: String(actor.account?.id || actor.id || '') };
  const audit = async (event, extra = {}) => {
    if (!useDedup) return;
    try {
      await auditMedia(event, { ...auditData, ...extra }, options);
    } catch (error) {
      console.warn(JSON.stringify({ event: 'blog_media_audit_failed', requestId, phase: event,
        message: String(error?.message || error) }));
      throw error;
    }
  };
  let lease;
  if (useDedup) {
    try {
      const existing = await readMediaMapping(hash, options);
      if (existing) {
        await audit('dedup_hit', { variantCount: existing.responsiveSources.length });
        return assetFromMapping(existing, media, actor);
      }
      const acquired = await acquireMedia(hash, options);
      if (acquired.state === 'ready') {
        const ready = await readMediaMapping(hash, options);
        if (ready) return assetFromMapping(ready, media, actor);
      }
      if (acquired.state === 'busy') {
        const waited = await waitForMedia(hash, options);
        if (waited) return assetFromMapping(waited, media, actor);
        throw temporaryMediaError();
      }
      if (acquired.state !== 'acquired') throw temporaryMediaError();
      lease = acquired;
    } catch (error) {
      if (error?.code === 'BLOG_MEDIA_RETRY') throw error;
      throw temporaryMediaError();
    }
  }
  const heartbeat = lease ? startHeartbeat(lease, options) : null;
  const processedByWidth = new Map();
  try {
    const sharpFactory = options.sharpImpl || sharp;
    for (const width of widths) {
      const processed = await sharpFactory(media.buffer, {
        failOn: 'error',
        animated: false,
        limitInputPixels: 40_000_000
      })
        .rotate()
        .resize({ width, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 84, effort: 4 })
        .toBuffer({ resolveWithObject: true });
      const actualWidth = Number(processed.info?.width || 0);
      if (actualWidth > 0 && !processedByWidth.has(actualWidth)) processedByWidth.set(actualWidth, processed);
    }
  } catch {
    await heartbeat?.stop();
    await audit('upload_failed', { code: 'BLOG_MEDIA_INVALID_IMAGE' }).catch(() => null);
    if (lease) await releaseMedia(lease, options).catch(() => null);
    throw mediaError('Không thể đọc hoặc tối ưu file ảnh này.', 400, 'BLOG_MEDIA_INVALID_IMAGE');
  }
  if (!processedByWidth.size) {
    await heartbeat?.stop();
    await audit('upload_failed', { code: 'BLOG_MEDIA_INVALID_IMAGE' }).catch(() => null);
    if (lease) await releaseMedia(lease, options).catch(() => null);
    throw mediaError('Không thể đọc kích thước file ảnh này.', 400, 'BLOG_MEDIA_INVALID_IMAGE');
  }
  const baseName = slugifyBlogValue(media.fileName.replace(/\.[^.]+$/, '')) || 'blog-image';
  const id = lease ? hash.slice(0, 32) : requestId;
  const responsiveSources = [];
  try {
    for (const [width, processed] of [...processedByWidth.entries()].sort((left, right) => left[0] - right[0])) {
      await heartbeat?.assertOwned();
      const pathname = lease
        ? `blog/assets/${MEDIA_RULE_VERSION}/${hash}/${width}w.webp`
        : `blog/assets/${baseName}-${id}-${width}w.webp`;
      let result;
      // A previous lease may have written a subset of variants before it
      // failed. HEAD only on a retry generation, not on every fresh upload.
      if (lease && Number(lease.fence) > 1) {
        try { result = await inspectUncertainPut(pathname, processed, token, options); }
        catch { throw temporaryMediaError(); }
        if (result) await audit('head_reused', { pathname, width }).catch(() => null);
      }
      if (!result) {
        await audit('put_attempted', { pathname, width, size: processed.data.length });
        try {
          result = await put(pathname, processed.data, {
            access: 'public', addRandomSuffix: false, allowOverwrite: false,
            contentType: 'image/webp', token
          });
        } catch (error) {
          if (/public access on a private store|private store|configured with private access/i.test(String(error?.message || ''))) {
            await audit('put_failed', { pathname, width, reason: 'private_store' }).catch(() => null);
            throw normalizeBlobUploadError(error);
          }
          result = lease ? await inspectUncertainPut(pathname, processed, token, options).catch(() => null) : null;
          if (!result) {
            await audit('put_failed', { pathname, width, reason: 'unconfirmed' }).catch(() => null);
            throw normalizeBlobUploadError(error);
          }
        }
        await audit('put_confirmed', { pathname, width, size: processed.data.length }).catch(() => null);
      }
      responsiveSources.push({
        url: result.url,
        pathname: result.pathname || pathname,
        width,
        height: Number(processed.info?.height || 0),
        size: Number(processed.info?.size || processed.data.length),
        contentType: 'image/webp'
      });
    }
    await heartbeat?.assertOwned();
    let mapping = { id, responsiveSources };
    if (lease) {
      try { mapping = await finalizeMedia(lease, mapping, options); }
      catch { throw temporaryMediaError(); }
    }
    await audit('upload_complete', { variantCount: responsiveSources.length }).catch(() => null);
    return assetFromMapping(mapping, media, actor);
  } catch (error) {
    await audit('upload_failed', { code: error.code || error.message || 'UNKNOWN' }).catch(() => null);
    if (lease) await releaseMedia(lease, options).catch(() => null);
    throw error;
  } finally {
    await heartbeat?.stop();
  }
}

export const blogMediaInternals = {
  MAX_MEDIA_BYTES,
  ALLOWED_MEDIA_TYPES,
  RESPONSIVE_WIDTHS,
  TWO_WIDTHS,
  widthProfile,
  fingerprint,
  mediaError,
  normalizeBlobUploadError
};
