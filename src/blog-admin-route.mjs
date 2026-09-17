import { readFile } from 'node:fs/promises';
import { requireBlogRole } from './blog-admin-auth.mjs';
import {
  adminErrorPayload,
  assertAdminSameOrigin,
  firstQueryValue,
  parseRequestBody,
  sendAdminJson
} from './blog-admin-http.mjs';
import {
  archiveBlogPost,
  createBlogPost,
  getBlogPost,
  listBlogAudit,
  listBlogPosts,
  listBlogRevisions,
  publishBlogPost,
  restoreBlogRevision,
  unpublishBlogPost,
  updateBlogPost
} from './blog-cms-store.mjs';
import { normalizeBlogPost, validateBlogPost } from './blog-post-model.mjs';
import { renderBlogPreviewDocument } from './blog-admin-preview.mjs';
import { saveBlogMedia } from './blog-media-store.mjs';
import { LEGACY_BLOG_SLUGS } from './blog-public-config.mjs';
import { restoreStaticBlogPresentation } from './blog-static-migration.mjs';

const legacySlugSet = new Set(LEGACY_BLOG_SLUGS);

async function withLegacyPresentation(value) {
  const post = value?.post && typeof value.post === 'object' ? value.post : value;
  const slug = String(post?.slug || '').trim();
  if (!legacySlugSet.has(slug)) return value;
  try {
    const html = await readFile(new URL(`../public/blog/${slug}.html`, import.meta.url), 'utf8');
    return restoreStaticBlogPresentation(value, html, { sourcePath: `public/blog/${slug}.html` });
  } catch {
    return value;
  }
}

function idFrom(request, body = {}) {
  return String(body.id || firstQueryValue(request.query?.id) || '').trim();
}

function revisionFrom(request, body = {}) {
  const raw = body.revision ?? firstQueryValue(request.query?.revision);
  return raw == null || raw === '' ? undefined : Number(raw);
}

function expectedRevision(body = {}) {
  const value = Number(body.expectedRevision);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

async function previewStored(request) {
  const id = idFrom(request);
  if (!id) {
    const error = new Error('Thiếu mã bài viết cần xem trước.');
    error.statusCode = 400;
    error.code = 'BLOG_POST_ID_REQUIRED';
    throw error;
  }
  const value = await withLegacyPresentation(await getBlogPost(id, { revision: revisionFrom(request) }));
  const preview = renderBlogPreviewDocument(value.post, {
    publishedAt: value.meta.publishedAt,
    updatedAt: value.meta.updatedAt
  });
  return {
    ...value,
    preview: preview.html,
    previewData: { toc: preview.toc, schemas: preview.schemas }
  };
}

async function handleGet(request, response, actor) {
  const action = String(firstQueryValue(request.query?.action) || 'list').trim().toLowerCase();
  if (action === 'list') {
    const posts = await listBlogPosts({
      status: firstQueryValue(request.query?.status),
      limit: firstQueryValue(request.query?.limit),
      offset: firstQueryValue(request.query?.offset)
    });
    return sendAdminJson(response, 200, { posts, items: posts, role: actor.role });
  }
  if (action === 'detail') {
    const id = idFrom(request);
    if (!id) return sendAdminJson(response, 400, { error: 'Thiếu mã bài viết.', code: 'BLOG_POST_ID_REQUIRED' });
    return sendAdminJson(response, 200, await withLegacyPresentation(await getBlogPost(id, { revision: revisionFrom(request) })));
  }
  if (action === 'revisions') {
    const id = idFrom(request);
    if (!id) return sendAdminJson(response, 400, { error: 'Thiếu mã bài viết.', code: 'BLOG_POST_ID_REQUIRED' });
    const [revisions, audit] = await Promise.all([
      listBlogRevisions(id, { limit: firstQueryValue(request.query?.limit) }),
      listBlogAudit(id, { limit: firstQueryValue(request.query?.limit) })
    ]);
    return sendAdminJson(response, 200, { revisions, audit });
  }
  if (action === 'preview') return sendAdminJson(response, 200, await previewStored(request));
  return sendAdminJson(response, 400, { error: 'Thao tác blog không hợp lệ.', code: 'INVALID_BLOG_ACTION' });
}

async function handlePost(request, response, body, actor) {
  const action = String(body.action || '').trim().toLowerCase().replace(/-/g, '_');
  if (action === 'save') {
    const id = idFrom(request, body);
    const presentedPost = (await withLegacyPresentation(body.post || {}))?.post || body.post || {};
    const result = id
      ? await updateBlogPost(id, presentedPost, expectedRevision(body), actor)
      : await createBlogPost(presentedPost, actor);
    return sendAdminJson(response, id ? 200 : 201, {
      id: result.meta.id,
      revision: result.revision,
      post: result.post,
      meta: result.meta,
      validation: result.validation
    });
  }
  if (action === 'preview') {
    const presentedPost = (await withLegacyPresentation(body.post || {}))?.post || body.post || {};
    const post = normalizeBlogPost(presentedPost, { fallbackSlug: 'ban-nhap-xem-truoc' });
    const validation = validateBlogPost(post, { forPublish: false });
    const preview = renderBlogPreviewDocument(post);
    return sendAdminJson(response, 200, {
      post,
      validation,
      preview: preview.html,
      previewData: { toc: preview.toc, schemas: preview.schemas }
    });
  }
  if (action === 'upload_media') {
    const asset = await saveBlogMedia(body, actor);
    return sendAdminJson(response, 201, { asset, url: asset.url });
  }
  if (action === 'restore') {
    const id = idFrom(request, body);
    if (!id) return sendAdminJson(response, 400, { error: 'Thiếu mã bài viết.', code: 'BLOG_POST_ID_REQUIRED' });
    const result = await restoreBlogRevision(id, body.revisionToRestore, expectedRevision(body), actor);
    return sendAdminJson(response, 200, result);
  }
  if (['publish', 'unpublish', 'archive'].includes(action)) {
    if (actor.role !== 'admin') {
      return sendAdminJson(response, 403, { error: 'Chỉ admin có quyền thay đổi trạng thái xuất bản.', code: 'BLOG_ADMIN_REQUIRED' });
    }
    const id = idFrom(request, body);
    if (!id) return sendAdminJson(response, 400, { error: 'Thiếu mã bài viết.', code: 'BLOG_POST_ID_REQUIRED' });
    const revision = expectedRevision(body);
    const result = action === 'publish'
      ? await publishBlogPost(id, revision, actor)
      : action === 'unpublish'
        ? await unpublishBlogPost(id, revision, actor)
        : await archiveBlogPost(id, revision, actor);
    return sendAdminJson(response, 200, result);
  }
  return sendAdminJson(response, 400, { error: 'Thao tác blog không hợp lệ.', code: 'INVALID_BLOG_ACTION' });
}

export default async function handler(request, response) {
  let body = {};
  try {
    if (!['GET', 'POST', 'DELETE'].includes(request.method)) {
      response.setHeader('Allow', 'GET, POST, DELETE');
      return sendAdminJson(response, 405, { error: 'Phương thức không được hỗ trợ.' });
    }
    if (request.method !== 'GET') assertAdminSameOrigin(request);
    body = request.method === 'GET' ? {} : parseRequestBody(request);
    const requestedAction = request.method === 'DELETE' ? 'archive' : String(body.action || '').toLowerCase();
    const minimumRole = ['publish', 'unpublish', 'archive'].includes(requestedAction) ? 'admin' : 'editor';
    const actor = await requireBlogRole(request, minimumRole);
    if (request.method === 'GET') return await handleGet(request, response, actor);
    if (request.method === 'DELETE') return await handlePost(request, response, { ...body, action: 'archive' }, actor);
    return await handlePost(request, response, body, actor);
  } catch (error) {
    const payload = adminErrorPayload(error, 'Không thể xử lý bài viết lúc này.');
    if (error?.code === 'BLOG_REVISION_CONFLICT') {
      payload.currentRevision = error.details?.currentRevision;
      const id = idFrom(request, body);
      if (id) {
        const current = await getBlogPost(id).catch(() => null);
        if (current) payload.currentPost = current.post;
      }
    }
    return sendAdminJson(response, error?.statusCode || 500, payload);
  }
}
