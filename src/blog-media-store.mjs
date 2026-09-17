import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { slugifyBlogValue } from './blog-post-model.mjs';

// Base64 adds roughly 33%. Keep the raw file below 3 MB so the JSON request
// remains under Vercel's serverless request-body ceiling.
const MAX_MEDIA_BYTES = 3 * 1024 * 1024;
const ALLOWED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']);

function mediaError(message, statusCode = 400, code = 'BLOG_MEDIA_ERROR') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
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
  const token = options.blobToken || process.env.BLOB_READ_WRITE_TOKEN;
  if (!token && !options.blobPutImpl) {
    throw mediaError('Kho ảnh blog chưa được cấu hình.', 503, 'BLOG_MEDIA_STORAGE_UNAVAILABLE');
  }
  const media = decodeBlogMedia(input);
  let processed;
  try {
    const pipeline = (options.sharpImpl || sharp)(media.buffer, {
      failOn: 'error',
      animated: false,
      limitInputPixels: 40_000_000
    })
      .rotate()
      .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 84, effort: 4 });
    processed = await pipeline.toBuffer({ resolveWithObject: true });
  } catch {
    throw mediaError('Không thể đọc hoặc tối ưu file ảnh này.', 400, 'BLOG_MEDIA_INVALID_IMAGE');
  }
  const put = options.blobPutImpl || (await import('@vercel/blob')).put;
  const baseName = slugifyBlogValue(media.fileName.replace(/\.[^.]+$/, '')) || 'blog-image';
  const id = (options.randomUUIDImpl || randomUUID)();
  const pathname = `blog/assets/${baseName}-${id}.webp`;
  const result = await put(pathname, processed.data, {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: false,
    contentType: 'image/webp',
    token
  });
  return {
    id,
    url: result.url,
    pathname: result.pathname || pathname,
    width: Number(processed.info?.width || 0),
    height: Number(processed.info?.height || 0),
    size: Number(processed.info?.size || processed.data.length),
    contentType: 'image/webp',
    alt: media.alt,
    uploadedBy: {
      id: String(actor.account?.id || actor.id || ''),
      email: String(actor.account?.email || actor.email || '').toLowerCase()
    }
  };
}

export const blogMediaInternals = { MAX_MEDIA_BYTES, ALLOWED_MEDIA_TYPES, mediaError };
