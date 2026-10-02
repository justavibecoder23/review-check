import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { currentAccount } from '../api/auth.mjs';
import { signBlogRequest } from '../cloudflare/blog-preview/request-auth.mjs';
import { normalizeBlogPost, validateBlogPost } from './blog-post-model.mjs';
import { renderBlogPreviewDocument } from './blog-admin-preview.mjs';
import { parseRequestBody, firstQueryValue, sendAdminJson } from './blog-admin-http.mjs';

function error(code, statusCode) { return Object.assign(new Error(code), { code, statusCode }); }
export function cloudflarePreviewEnabled(env = process.env) {
  if (env.BLOG_STORAGE_BACKEND !== 'cloudflare-preview') return false;
  if (env.VERCEL_ENV !== 'preview') throw error('BLOG_PREVIEW_ONLY', 503);
  return true;
}
function assertOrigin(request) {
  const host = String(request.headers?.['x-forwarded-host'] || request.headers?.host || '').split(',')[0].trim();
  const origin = request.headers?.origin;
  try {
    const parsed = new URL(origin);
    if (!host || parsed.host !== host || parsed.protocol !== 'https:' || origin !== parsed.origin
      || request.headers?.['sec-fetch-site'] === 'cross-site') throw new Error();
  } catch { throw error('INVALID_ORIGIN', 403); }
}
export async function previewWorkerCall(path, payload, actorId, options = {}) {
  const env = options.env || process.env;
  if (!cloudflarePreviewEnabled(env)) throw error('BLOG_PREVIEW_DISABLED', 503);
  const configured = env.BLOG_PREVIEW_WORKER_URL;
  const url = new URL(configured);
  // Fixed service allowlist: NEVER sign arbitrary destinations or redirects.
  if (url.origin !== 'https://realview-blog-preview.wwpk-cloudflare-relay.workers.dev'
    || url.pathname !== '/' || url.search || url.hash) throw error('BLOG_WORKER_URL_INVALID', 503);
  const target = new URL(path, url).toString();
  const body = new TextEncoder().encode(JSON.stringify(payload));
  if (body.length > 4_300_000) throw error('BLOG_BODY_TOO_LARGE', 413);
  const headers = await signBlogRequest({ secret: env.BLOG_PREVIEW_HMAC_SECRET, environment: 'preview', method: 'POST',
    url: target, timestamp: Math.floor(Date.now() / 1000), requestId: randomUUID(), actorId,
    idempotencyKey: options.idempotencyKey || randomUUID(), contentType: 'application/json', body });
  let response;
  try { response = await (options.fetchImpl || fetch)(target, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(24_000) }); }
  catch { throw error('BLOG_WORKER_RETRY', 503); }
  if (options.raw && response.ok) return response;
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(error(result.code || 'BLOG_WORKER_RETRY', response.status), result);
  return result;
}

export async function preparePreviewMedia(input, options = {}) {
  const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
  if (!allowed.has(input.contentType)) throw error('BLOG_MEDIA_TYPE_UNSUPPORTED', 415);
  const value = String(input.data || '');
  if (value.length > 4_194_304 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(value) || value.length % 4) throw error('BLOG_MEDIA_INVALID_BASE64', 400);
  const buffer = Buffer.from(value, 'base64');
  if (!buffer.length || buffer.length > 3 * 1024 * 1024 || buffer.toString('base64') !== value) throw error('BLOG_MEDIA_TOO_LARGE', 413);
  const factory = options.sharpImpl || sharp;
  const decoder = factory(buffer, { failOn: 'error', animated: false, limitInputPixels: 40_000_000 });
  let metadata;
  try { metadata = await decoder.metadata(); } catch { throw error('BLOG_MEDIA_INVALID_IMAGE', 400); }
  const types = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif', heif: 'image/avif' };
  if (types[metadata.format] !== input.contentType || metadata.pages > 1 || !metadata.width || !metadata.height
    || metadata.width * metadata.height > 40_000_000) throw error('BLOG_MEDIA_INVALID_IMAGE', 400);
  const variants = [];
  try {
    for (const width of [480, 960, 1600]) {
      const result = await factory(buffer, { failOn: 'error', animated: false, limitInputPixels: 40_000_000 })
        .rotate().resize({ width, fit: 'inside', withoutEnlargement: true }).webp({ quality: 84, effort: 4 }).toBuffer({ resolveWithObject: true });
      if (!variants.some(item => item.width === result.info.width)) variants.push({ width: result.info.width,
        height: result.info.height, data: result.data.toString('base64') });
    }
  } catch { throw error('BLOG_MEDIA_INVALID_IMAGE', 400); }
  return { sourceHash: createHash('sha256').update(buffer).digest('hex'), variants };
}

export function createCloudflarePreviewHandler(options = {}) {
  return async (request, response) => {
    try {
      const env = options.env || process.env;
      if (!cloudflarePreviewEnabled(env)) throw error('BLOG_PREVIEW_DISABLED', 503);
      // Fail closed if an inherited Vercel integration reintroduces a Blob token.
      if (['BLOB_READ_WRITE_TOKEN', 'BLOG_MEDIA_BLOB_TOKEN', 'BLOG_MEDIA_READ_WRITE_TOKEN'].some(key => String(env[key] || '').trim())) {
        throw error('BLOG_PREVIEW_STORAGE_NOT_ISOLATED', 503);
      }
      response.setHeader('X-Blog-Storage-Backend', 'cloudflare-preview');
      if (!['GET', 'POST'].includes(request.method)) throw error('METHOD_NOT_ALLOWED', 405);
      if (request.method === 'POST') assertOrigin(request);
      // This reads the existing session/user via GET only; does NOT resolve legacy Redis grants.
      const account = await (options.currentAccountImpl || currentAccount)(request);
      if (!account?.id) throw error('AUTH_REQUIRED', 401);
      const call = (path, data, extras = {}) => previewWorkerCall(path, data, account.id, { ...options, env, ...extras });
      const body = request.method === 'GET' ? request.query || {} : parseRequestBody(request);
      if (Buffer.byteLength(JSON.stringify(body)) > 4_300_000) throw error('BLOG_BODY_TOO_LARGE', 413);
      const action = String(firstQueryValue(body.action) || 'list');
      let result;
      if (request.method === 'GET' && request.query?.route === 'cloudflare-media') {
        const raw = await call('/v1/media/read', { hash: firstQueryValue(body.hash), width: firstQueryValue(body.width) }, { raw: true });
        response.setHeader('Content-Type', 'image/webp'); response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Cache-Control', 'private, no-store');
        return response.status(200).end(Buffer.from(await raw.arrayBuffer()));
      }
      if (request.method === 'GET') result = await call('/v1/read', {
        action, id: firstQueryValue(body.id), revision: firstQueryValue(body.revision)
      });
      else if (action === 'save') {
        if (!/^[a-zA-Z0-9:_-]{16,128}$/.test(body.idempotencyKey || '')) throw error('BLOG_IDEMPOTENCY_REQUIRED', 400);
        const post = normalizeBlogPost(body.post || {});
        const validation = validateBlogPost(post, { forPublish: false });
        result = await call('/v1/save', { id: body.id || null, expectedRevision: body.expectedRevision || 0, post }, { idempotencyKey: body.idempotencyKey });
        result.validation = validation;
      } else if (action === 'upload_media') {
        // Authorize BEFORE spending sharp CPU; worker checks again at R2/D1 commit.
        const access = await call('/v1/read', { action: 'access' });
        if (access.readOnly) throw error('BLOG_READ_ONLY', 503);
        const processed = await preparePreviewMedia(body, options);
        result = await call('/v1/media/upload', processed, { idempotencyKey: body.idempotencyKey || randomUUID() });
        result.asset.alt = String(body.alt || '').slice(0, 300); result.url = result.asset.url;
      } else if (action === 'preview') {
        await call('/v1/read', { action: 'access' });
        const post = normalizeBlogPost(body.post || {}, { fallbackSlug: 'ban-nhap-xem-truoc' });
        const rendered = renderBlogPreviewDocument(post, { relatedPosts: {} });
        result = { post, validation: validateBlogPost(post, { forPublish: false }), preview: rendered.html, previewData: { toc: rendered.toc, schemas: rendered.schemas } };
      } else throw error('BLOG_PREVIEW_ACTION_DISABLED', 409);
      if (request.method === 'GET' && action === 'preview') {
        const rendered = renderBlogPreviewDocument(result.post, { relatedPosts: {} }); result.preview = rendered.html;
      }
      return sendAdminJson(response, 200, result);
    } catch (err) {
      return sendAdminJson(response, err.statusCode || 503, { error: err.code || 'BLOG_WORKER_RETRY', code: err.code || 'BLOG_WORKER_RETRY',
        ...(err.currentRevision != null ? { currentRevision: err.currentRevision } : {}) });
    }
  };
}
export default createCloudflarePreviewHandler();
