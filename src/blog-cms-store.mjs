import { randomUUID } from 'node:crypto';
import { isRedisConfigured, redisCommand, redisTransaction } from './redis-rest.mjs';
import {
  assertPublishableBlogPost,
  normalizeBlogPost,
  slugifyBlogValue,
  validateBlogPost
} from './blog-post-model.mjs';
import { LEGACY_BLOG_SLUGS, LEGACY_BLOG_SUMMARIES } from './blog-public-config.mjs';
import { createPublicBlogSummarySnapshot } from './blog-public-data.mjs';

const PREFIX = 'realview:blog:cms:v1';
const INDEX_KEY = `${PREFIX}:posts`;
const AUDIT_LIMIT = 200;
const LOCK_SECONDS = 20;
const LIST_PAGE_SIZE = 250;
const LIST_LIMIT = 500;
const LIST_ALL_LIMIT = 10_000;

function cmsError(message, statusCode = 400, code = 'BLOG_CMS_ERROR', details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function ensureStorage(options = {}) {
  if (!isRedisConfigured() && !options.redisFetchImpl) {
    throw cmsError('Kho quản trị blog chưa được cấu hình.', 503, 'BLOG_STORAGE_UNAVAILABLE');
  }
}

function metaKey(postId) { return `${PREFIX}:post:${postId}:meta`; }
function slugKey(slug) { return `${PREFIX}:slug:${slug}`; }
function revisionKey(postId, revision) { return `${PREFIX}:post:${postId}:revision:${revision}`; }
function revisionIndexKey(postId) { return `${PREFIX}:post:${postId}:revisions`; }
function auditKey(postId) { return `${PREFIX}:post:${postId}:audit`; }
function lockKey(postId) { return `${PREFIX}:post:${postId}:lock`; }
function redirectKey(slug) { return `${PREFIX}:redirect:${slug}`; }

function parseJson(value) {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}

function nowValue(options = {}) {
  const candidate = typeof options.now === 'function' ? options.now() : (options.now || new Date());
  return candidate instanceof Date ? candidate : new Date(candidate);
}

function actorValue(actor = {}) {
  return {
    id: String(actor.account?.id || actor.id || ''),
    username: String(actor.account?.username || actor.username || ''),
    email: String(actor.account?.email || actor.email || '').toLowerCase(),
    role: actor.role === 'admin' ? 'admin' : 'editor'
  };
}

function redisOptions(options = {}) {
  return {
    fetchImpl: options.redisFetchImpl,
    timeoutMs: options.redisTimeoutMs || 3_000
  };
}

async function acquirePostLock(postId, options = {}) {
  const owner = (options.randomUUIDImpl || randomUUID)();
  const claimed = await redisCommand(
    ['SET', lockKey(postId), owner, 'NX', 'EX', String(LOCK_SECONDS)],
    redisOptions(options)
  );
  if (!claimed) throw cmsError('Bài viết đang được chỉnh sửa bởi một yêu cầu khác. Vui lòng thử lại.', 409, 'BLOG_POST_BUSY');
  return owner;
}

async function releasePostLock(postId, owner, options = {}) {
  const active = await redisCommand(['GET', lockKey(postId)], redisOptions(options)).catch(() => null);
  if (active === owner) await redisCommand(['DEL', lockKey(postId)], redisOptions(options)).catch(() => null);
}

async function reserveSlug(slug, postId, options = {}) {
  const key = slugKey(slug);
  const active = await redisCommand(['GET', key], redisOptions(options));
  if (active === postId) return false;
  if (!options.allowLegacySlug && LEGACY_BLOG_SLUGS.includes(slug)) {
    throw cmsError('Slug này đang được một bài viết tĩnh hiện có sử dụng.', 409, 'BLOG_SLUG_RESERVED');
  }
  if (active) throw cmsError('Slug này đã được một bài viết khác sử dụng.', 409, 'BLOG_SLUG_EXISTS');
  const reserved = await redisCommand(['SET', key, postId, 'NX'], redisOptions(options));
  if (!reserved) throw cmsError('Slug này vừa được một bài viết khác sử dụng.', 409, 'BLOG_SLUG_EXISTS');
  return true;
}

async function writeRevision(postId, revision, document, options = {}) {
  const serialized = JSON.stringify(document);
  const blobToken = options.blobToken || process.env.BLOB_READ_WRITE_TOKEN;
  const useBlob = Boolean(options.blobPutImpl || blobToken);
  if (useBlob) {
    const put = options.blobPutImpl || (await import('@vercel/blob')).put;
    const pathname = `blog/posts/${postId}/revisions/${revision}.json`;
    const result = await put(pathname, serialized, {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: 'application/json; charset=utf-8',
      token: blobToken
    });
    return {
      storage: 'vercel-blob-private',
      pathname: result.pathname || pathname,
      url: result.url || '',
      savedAt: document.savedAt,
      savedBy: document.savedBy,
      bytes: Buffer.byteLength(serialized)
    };
  }
  return {
    storage: 'redis',
    document,
    savedAt: document.savedAt,
    savedBy: document.savedBy,
    bytes: Buffer.byteLength(serialized)
  };
}

async function readBlobDocument(pointer, options = {}) {
  const get = options.blobGetImpl || (await import('@vercel/blob')).get;
  const locator = pointer.pathname || pointer.url;
  const result = await get(locator, {
    access: 'private',
    token: options.blobToken || process.env.BLOB_READ_WRITE_TOKEN
  });
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  const text = await new Response(result.stream).text();
  return parseJson(text);
}

async function readMeta(postId, options = {}) {
  const meta = parseJson(await redisCommand(['GET', metaKey(postId)], redisOptions(options)));
  if (!meta) throw cmsError('Không tìm thấy bài viết.', 404, 'BLOG_POST_NOT_FOUND');
  return meta;
}

async function readRevisionDocument(postId, revision, options = {}) {
  const pointer = parseJson(await redisCommand(['GET', revisionKey(postId, revision)], redisOptions(options)));
  if (!pointer) throw cmsError('Không tìm thấy phiên bản bài viết.', 404, 'BLOG_REVISION_NOT_FOUND');
  const document = pointer.storage === 'redis' ? pointer.document : await readBlobDocument(pointer, options);
  if (!document?.post || Number(document.revision) !== Number(revision) || document.postId !== postId) {
    throw cmsError('Dữ liệu phiên bản bài viết không hợp lệ.', 500, 'BLOG_REVISION_CORRUPT');
  }
  // Older CMS revisions were stored before newer optional fields (TOC,
  // responsive image sources, galleries, settings...) existed. Always expose
  // the current model shape to validation and the editor without rewriting the
  // immutable stored revision.
  return {
    document: {
      ...document,
      post: normalizeBlogPost(document.post, { fallbackSlug: document.post.slug })
    },
    pointer
  };
}

async function nextRevisionNumber(postId, currentRevision, options = {}) {
  const latest = await redisCommand(['ZREVRANGE', revisionIndexKey(postId), '0', '0'], redisOptions(options));
  const latestStored = Number(Array.isArray(latest) ? latest[0] : 0);
  return Math.max(Number(currentRevision) || 0, Number.isInteger(latestStored) ? latestStored : 0) + 1;
}

function publishedMetaView(meta = {}) {
  const publishedUpdatedAt = meta.publishedUpdatedAt || meta.publishedSummary?.updatedAt || meta.updatedAt;
  return {
    ...meta,
    updatedAt: publishedUpdatedAt,
    publishedUpdatedAt
  };
}

function auditRecord(action, postId, revision, actor, at, detail = {}) {
  return {
    id: randomUUID(),
    action,
    postId,
    revision,
    actor: actorValue(actor),
    at,
    ...detail
  };
}

function metaFromPost(postId, post, revision, actor, at, previous = null) {
  const wasPublished = previous?.status === 'published';
  const wordCount = [post.h1, post.deck, ...post.blocks.flatMap((block) => {
    if (block.text) return [block.text];
    if (block.items) return block.items.flatMap((item) => typeof item === 'string' ? item : [item?.text, item?.question, item?.answer]);
    if (block.rows) return block.rows.flat();
    return [];
  })].join(' ').trim().split(/\s+/).filter(Boolean).length;
  const managedSlugs = [...new Set([
    ...(Array.isArray(previous?.managedSlugs) ? previous.managedSlugs : []),
    previous?.slug,
    previous?.publishedSlug,
    post.slug
  ].map(slugifyBlogValue).filter(Boolean))];
  return {
    id: postId,
    schemaVersion: '1.0.0',
    slug: post.slug,
    managedSlugs,
    title: post.title || post.h1 || 'Bản nháp chưa có tiêu đề',
    h1: post.h1,
    category: post.category,
    categoryLabel: post.categoryLabel,
    tags: post.tags,
    authors: post.authors,
    heroImage: post.heroImage,
    deck: post.deck,
    excerpt: post.excerpt,
    featured: post.featured,
    readingMinutes: Math.max(1, Math.round(wordCount / 220)),
    seo: {
      title: post.seo.title,
      metaDescription: post.seo.metaDescription,
      canonicalPath: post.seo.canonicalPath,
      robots: post.seo.robots
    },
    settings: {
      allowIndexing: post.settings.allowIndexing
    },
    status: previous?.status === 'archived' ? 'archived' : (wasPublished ? 'published' : 'draft'),
    revision,
    publishedRevision: previous?.publishedRevision || null,
    publishedSlug: previous?.publishedSlug || null,
    publishedSummary: previous?.publishedSummary || null,
    hasUnpublishedChanges: wasPublished,
    createdAt: previous?.createdAt || at,
    createdBy: previous?.createdBy || actorValue(actor),
    updatedAt: at,
    updatedBy: actorValue(actor),
    publishedAt: previous?.publishedAt || null,
    publishedUpdatedAt: previous?.publishedUpdatedAt || previous?.publishedSummary?.updatedAt || null,
    unpublishedAt: previous?.unpublishedAt || null,
    archivedAt: null
  };
}

function relatedSlugs(post = {}) {
  return [...new Set([
    ...(Array.isArray(post.relatedSlugs) ? post.relatedSlugs : []),
    ...(Array.isArray(post.blocks) ? post.blocks : [])
      .filter((block) => block?.type === 'relatedPosts')
      .flatMap((block) => Array.isArray(block.slugs) ? block.slugs : [])
  ].map(slugifyBlogValue).filter(Boolean))];
}

export async function resolveRelatedBlogPostTitles(post, options = {}) {
  ensureStorage(options);
  const slugs = relatedSlugs(post);
  if (!slugs.length) return {};
  const legacyTitles = new Map(LEGACY_BLOG_SUMMARIES.map((summary) => [summary.slug, summary.title]));
  const owners = await redisCommand(['MGET', ...slugs.map(slugKey)], redisOptions(options));
  const ownerIds = [...new Set((Array.isArray(owners) ? owners : []).filter(Boolean))];
  const serialized = ownerIds.length
    ? await redisCommand(['MGET', ...ownerIds.map(metaKey)], redisOptions(options))
    : [];
  const metasById = new Map(ownerIds.map((id, index) => [id, parseJson(serialized?.[index])]));
  return Object.fromEntries(slugs.flatMap((slug, index) => {
    const meta = metasById.get(owners?.[index]);
    const title = meta?.status === 'published' && meta?.publishedSlug === slug
      ? meta.title
      : legacyTitles.get(slug);
    return title ? [[slug, { title }]] : [];
  }));
}

async function assertRelatedPostsPublishable(post, postId, options = {}) {
  const slugs = relatedSlugs(post);
  if (!slugs.length) return;
  const owners = await redisCommand(['MGET', ...slugs.map(slugKey)], redisOptions(options));
  const ownerIds = [...new Set((Array.isArray(owners) ? owners : []).filter(Boolean))];
  const serialized = ownerIds.length
    ? await redisCommand(['MGET', ...ownerIds.map(metaKey)], redisOptions(options))
    : [];
  const metasById = new Map(ownerIds.map((id, index) => [id, parseJson(serialized?.[index])]));
  const invalid = slugs.filter((slug, index) => {
    const ownerId = owners?.[index];
    if (!ownerId) return !LEGACY_BLOG_SLUGS.includes(slug);
    if (ownerId === postId) return true;
    const meta = metasById.get(ownerId);
    return meta?.status !== 'published' || meta?.publishedSlug !== slug || !meta?.publishedRevision;
  });
  if (invalid.length) {
    throw cmsError(
      'Bài liên quan phải là bài đã xuất bản và không được trỏ về chính bài hiện tại.',
      422,
      'BLOG_RELATED_POST_NOT_PUBLISHED',
      { slugs: invalid }
    );
  }
}

function revisionPointerForStorage(pointer) {
  return JSON.stringify(pointer);
}

function auditCommands(postId, audit) {
  return [
    ['LPUSH', auditKey(postId), JSON.stringify(audit)],
    ['LTRIM', auditKey(postId), '0', String(AUDIT_LIMIT - 1)]
  ];
}

export async function createBlogPost(input = {}, actor = {}, options = {}) {
  ensureStorage(options);
  const postId = (options.randomUUIDImpl || randomUUID)();
  const at = nowValue(options).toISOString();
  const post = normalizeBlogPost(input, { fallbackSlug: `ban-nhap-${postId.slice(0, 8)}` });
  const validation = validateBlogPost(post);
  const revision = 1;
  const owner = await acquirePostLock(postId, options);
  let reserved = false;
  try {
    reserved = await reserveSlug(post.slug, postId, options);
    const document = { schemaVersion: '1.0.0', postId, revision, savedAt: at, savedBy: actorValue(actor), post };
    const pointer = await writeRevision(postId, revision, document, options);
    const meta = metaFromPost(postId, post, revision, actor, at);
    const audit = auditRecord('created', postId, revision, actor, at);
    await redisTransaction([
      ['SET', revisionKey(postId, revision), revisionPointerForStorage(pointer)],
      ['ZADD', revisionIndexKey(postId), String(revision), String(revision)],
      ['SET', metaKey(postId), JSON.stringify(meta)],
      ['ZADD', INDEX_KEY, String(Date.parse(at)), postId],
      ...auditCommands(postId, audit)
    ], redisOptions(options));
    return { meta, post, revision, validation };
  } catch (error) {
    if (reserved) await redisCommand(['DEL', slugKey(post.slug)], redisOptions(options)).catch(() => null);
    throw error;
  } finally {
    await releasePostLock(postId, owner, options);
  }
}

export async function updateBlogPost(postId, input = {}, expectedRevision, actor = {}, options = {}) {
  ensureStorage(options);
  if (!Number.isInteger(Number(expectedRevision))) {
    throw cmsError('Cần gửi expectedRevision khi lưu bài.', 428, 'BLOG_REVISION_REQUIRED');
  }
  const owner = await acquirePostLock(postId, options);
  let reservedNewSlug = false;
  let newSlug = '';
  try {
    const previous = await readMeta(postId, options);
    if (Number(previous.revision) !== Number(expectedRevision)) {
      throw cmsError('Bài viết đã có phiên bản mới hơn. Hãy tải lại trước khi lưu.', 409, 'BLOG_REVISION_CONFLICT', {
        expectedRevision: Number(expectedRevision),
        currentRevision: Number(previous.revision)
      });
    }
    const post = normalizeBlogPost(input, { fallbackSlug: previous.slug });
    newSlug = post.slug;
    const validation = validateBlogPost(post);
    if (post.slug !== previous.slug) reservedNewSlug = await reserveSlug(post.slug, postId, options);
    const revision = await nextRevisionNumber(postId, previous.revision, options);
    const at = nowValue(options).toISOString();
    const document = { schemaVersion: '1.0.0', postId, revision, savedAt: at, savedBy: actorValue(actor), post };
    const pointer = await writeRevision(postId, revision, document, options);
    const meta = metaFromPost(postId, post, revision, actor, at, previous);
    const audit = auditRecord('saved', postId, revision, actor, at, { previousRevision: previous.revision });
    await redisTransaction([
      ['SET', revisionKey(postId, revision), revisionPointerForStorage(pointer)],
      ['ZADD', revisionIndexKey(postId), String(revision), String(revision)],
      ['SET', metaKey(postId), JSON.stringify(meta)],
      ['ZADD', INDEX_KEY, String(Date.parse(at)), postId],
      ...auditCommands(postId, audit)
    ], redisOptions(options));
    if (post.slug !== previous.slug && previous.publishedSlug !== previous.slug) {
      const oldOwner = await redisCommand(['GET', slugKey(previous.slug)], redisOptions(options)).catch(() => null);
      if (oldOwner === postId) await redisCommand(['DEL', slugKey(previous.slug)], redisOptions(options)).catch(() => null);
    }
    return { meta, post, revision, validation };
  } catch (error) {
    if (reservedNewSlug) {
      const current = parseJson(await redisCommand(['GET', metaKey(postId)], redisOptions(options)).catch(() => null));
      if (!current || current.slug !== newSlug) {
        await redisCommand(['DEL', slugKey(newSlug)], redisOptions(options)).catch(() => null);
      }
    }
    throw error;
  } finally {
    await releasePostLock(postId, owner, options);
  }
}

export async function getBlogPost(postId, options = {}) {
  ensureStorage(options);
  const meta = await readMeta(postId, options);
  const revision = options.revision == null ? Number(meta.revision) : Number(options.revision);
  if (!Number.isInteger(revision) || revision < 1) throw cmsError('Số phiên bản không hợp lệ.', 400, 'INVALID_BLOG_REVISION');
  const { document } = await readRevisionDocument(postId, revision, options);
  return {
    meta,
    revision,
    post: document.post,
    validation: validateBlogPost(document.post, { forPublish: meta.publishedRevision === revision })
  };
}

export async function getBlogPostBySlug(slug, options = {}) {
  ensureStorage(options);
  const normalizedSlug = slugifyBlogValue(slug);
  if (!normalizedSlug) throw cmsError('Slug bài viết không hợp lệ.', 400, 'INVALID_BLOG_SLUG');
  const postId = await redisCommand(['GET', slugKey(normalizedSlug)], redisOptions(options));
  if (!postId) throw cmsError('Không tìm thấy bài viết.', 404, 'BLOG_POST_NOT_FOUND');
  return getBlogPost(postId, options);
}

export async function getPublishedBlogPostBySlug(slug, options = {}) {
  ensureStorage(options);
  const normalizedSlug = slugifyBlogValue(slug);
  if (!normalizedSlug) throw cmsError('Slug bài viết không hợp lệ.', 400, 'INVALID_BLOG_SLUG');
  const postId = await redisCommand(['GET', slugKey(normalizedSlug)], redisOptions(options));
  if (!postId) throw cmsError('Không tìm thấy bài viết đã xuất bản.', 404, 'BLOG_POST_NOT_FOUND');
  const meta = await readMeta(postId, options);
  if (meta.status !== 'published' || meta.publishedSlug !== normalizedSlug || !meta.publishedRevision) {
    throw cmsError('Bài viết hiện không được xuất bản.', 404, 'BLOG_POST_NOT_PUBLISHED');
  }
  const { document } = await readRevisionDocument(postId, Number(meta.publishedRevision), options);
  return { meta: publishedMetaView(meta), post: document.post, revision: Number(meta.publishedRevision) };
}

export async function resolvePublishedBlogRoute(slug, options = {}) {
  ensureStorage(options);
  const normalizedSlug = slugifyBlogValue(slug);
  if (!normalizedSlug) throw cmsError('Slug bài viết không hợp lệ.', 400, 'INVALID_BLOG_SLUG');
  try {
    const record = await getPublishedBlogPostBySlug(normalizedSlug, options);
    return { kind: 'post', ...record };
  } catch (error) {
    if (!['BLOG_POST_NOT_FOUND', 'BLOG_POST_NOT_PUBLISHED'].includes(error?.code)) throw error;
    if (error?.code === 'BLOG_POST_NOT_PUBLISHED') throw error;
  }
  const redirectedSlug = slugifyBlogValue(await redisCommand(['GET', redirectKey(normalizedSlug)], redisOptions(options)));
  if (redirectedSlug && redirectedSlug !== normalizedSlug) {
    try {
      await getPublishedBlogPostBySlug(redirectedSlug, options);
      return { kind: 'redirect', slug: redirectedSlug };
    } catch (error) {
      if (error?.code === 'BLOG_POST_NOT_PUBLISHED') throw error;
      if (error?.code !== 'BLOG_POST_NOT_FOUND') throw error;
    }
  }
  throw cmsError('Không tìm thấy bài viết đã xuất bản.', 404, 'BLOG_POST_NOT_FOUND');
}

export async function listBlogPosts(options = {}) {
  ensureStorage(options);
  const all = options.all === true;
  const limit = all
    ? LIST_ALL_LIMIT
    : Math.max(1, Math.min(LIST_LIMIT, Number.parseInt(options.limit, 10) || 50));
  let offset = Math.max(0, Number.parseInt(options.offset, 10) || 0);
  const status = String(options.status || '').trim();
  const results = [];
  while (results.length < limit) {
    const ids = await redisCommand(
      ['ZREVRANGE', INDEX_KEY, String(offset), String(offset + LIST_PAGE_SIZE - 1)],
      redisOptions(options)
    );
    if (!Array.isArray(ids) || !ids.length) break;
    const serialized = await redisCommand(['MGET', ...ids.map(metaKey)], redisOptions(options));
    for (const meta of (Array.isArray(serialized) ? serialized : []).map(parseJson).filter(Boolean)) {
      if (!status || meta.status === status) results.push(meta);
      if (results.length >= limit) break;
    }
    offset += ids.length;
    if (ids.length < LIST_PAGE_SIZE) break;
  }
  return results;
}

export async function listPublishedBlogSummaries(options = {}) {
  return listBlogPosts({ ...options, status: 'published' });
}

export async function listBlogRevisions(postId, options = {}) {
  ensureStorage(options);
  await readMeta(postId, options);
  const limit = Math.max(1, Math.min(100, Number.parseInt(options.limit, 10) || 30));
  const revisions = await redisCommand(['ZREVRANGE', revisionIndexKey(postId), '0', String(limit - 1)], redisOptions(options));
  if (!Array.isArray(revisions) || !revisions.length) return [];
  const pointers = await redisCommand(['MGET', ...revisions.map((revision) => revisionKey(postId, revision))], redisOptions(options));
  return revisions.map((revision, index) => {
    const pointer = parseJson(pointers?.[index]);
    return {
      revision: Number(revision),
      savedAt: pointer?.savedAt || null,
      savedBy: pointer?.savedBy || null,
      bytes: Number(pointer?.bytes || 0),
      storage: pointer?.storage || null
    };
  });
}

export async function listBlogAudit(postId, options = {}) {
  ensureStorage(options);
  await readMeta(postId, options);
  const limit = Math.max(1, Math.min(AUDIT_LIMIT, Number.parseInt(options.limit, 10) || 50));
  const values = await redisCommand(['LRANGE', auditKey(postId), '0', String(limit - 1)], redisOptions(options));
  return (Array.isArray(values) ? values : []).map(parseJson).filter(Boolean);
}

export async function publishBlogPost(postId, expectedRevision, actor = {}, options = {}) {
  ensureStorage(options);
  if (!Number.isInteger(Number(expectedRevision)) || Number(expectedRevision) < 1) {
    throw cmsError('Cần gửi expectedRevision khi xuất bản.', 428, 'BLOG_REVISION_REQUIRED');
  }
  const owner = await acquirePostLock(postId, options);
  try {
    const previous = await readMeta(postId, options);
    if (Number(previous.revision) !== Number(expectedRevision)) {
      throw cmsError('Bài viết đã thay đổi trước khi xuất bản. Hãy tải lại.', 409, 'BLOG_REVISION_CONFLICT', {
        expectedRevision: Number(expectedRevision),
        currentRevision: Number(previous.revision)
      });
    }
    const { document } = await readRevisionDocument(postId, previous.revision, options);
    const validation = assertPublishableBlogPost(document.post);
    await assertRelatedPostsPublishable(document.post, postId, options);
    const at = nowValue(options).toISOString();
    const importedPublishedAt = options.publishedAt && !Number.isNaN(Date.parse(options.publishedAt))
      ? new Date(options.publishedAt).toISOString()
      : null;
    const meta = {
      ...previous,
      status: 'published',
      publishedRevision: previous.revision,
      publishedSlug: document.post.slug,
      hasUnpublishedChanges: false,
      publishedAt: previous.publishedAt || importedPublishedAt || at,
      publishedUpdatedAt: at,
      updatedAt: at,
      updatedBy: actorValue(actor),
      unpublishedAt: null,
      archivedAt: null
    };
    meta.publishedSummary = createPublicBlogSummarySnapshot({ ...meta, publishedSummary: null });
    const audit = auditRecord('published', postId, previous.revision, actor, at);
    const commands = [
      ['SET', metaKey(postId), JSON.stringify(meta)],
      ['ZADD', INDEX_KEY, String(Date.parse(at)), postId],
      ...auditCommands(postId, audit)
    ];
    for (const oldSlug of meta.managedSlugs || []) {
      if (oldSlug && oldSlug !== meta.publishedSlug) {
        commands.push(['SET', redirectKey(oldSlug), meta.publishedSlug]);
      }
    }
    await redisTransaction(commands, redisOptions(options));
    if (previous.publishedSlug && previous.publishedSlug !== meta.publishedSlug) {
      const oldOwner = await redisCommand(['GET', slugKey(previous.publishedSlug)], redisOptions(options)).catch(() => null);
      if (oldOwner === postId) await redisCommand(['DEL', slugKey(previous.publishedSlug)], redisOptions(options)).catch(() => null);
    }
    return { meta, post: document.post, validation };
  } finally {
    await releasePostLock(postId, owner, options);
  }
}

export async function restoreBlogRevision(postId, revisionToRestore, expectedRevision, actor = {}, options = {}) {
  ensureStorage(options);
  const targetRevision = Number(revisionToRestore);
  if (!Number.isInteger(targetRevision) || targetRevision < 1) {
    throw cmsError('Phiên bản cần khôi phục không hợp lệ.', 400, 'INVALID_BLOG_REVISION');
  }
  if (!Number.isInteger(Number(expectedRevision)) || Number(expectedRevision) < 1) {
    throw cmsError('Cần gửi expectedRevision khi khôi phục.', 428, 'BLOG_REVISION_REQUIRED');
  }
  const owner = await acquirePostLock(postId, options);
  let reservedNewSlug = false;
  let reservedSlug = '';
  try {
    const previous = await readMeta(postId, options);
    if (Number(previous.revision) !== Number(expectedRevision)) {
      throw cmsError('Bài viết đã thay đổi trước khi khôi phục. Hãy tải lại.', 409, 'BLOG_REVISION_CONFLICT', {
        expectedRevision: Number(expectedRevision),
        currentRevision: Number(previous.revision)
      });
    }
    const { document: target } = await readRevisionDocument(postId, targetRevision, options);
    const post = normalizeBlogPost(target.post, { fallbackSlug: previous.slug });
    if (post.slug !== previous.slug) {
      reservedNewSlug = await reserveSlug(post.slug, postId, options);
      if (reservedNewSlug) reservedSlug = post.slug;
    }
    const revision = await nextRevisionNumber(postId, previous.revision, options);
    const at = nowValue(options).toISOString();
    const document = { schemaVersion: '1.0.0', postId, revision, savedAt: at, savedBy: actorValue(actor), post };
    const pointer = await writeRevision(postId, revision, document, options);
    const meta = metaFromPost(postId, post, revision, actor, at, previous);
    const audit = auditRecord('restored', postId, revision, actor, at, { restoredFromRevision: targetRevision });
    await redisTransaction([
      ['SET', revisionKey(postId, revision), revisionPointerForStorage(pointer)],
      ['ZADD', revisionIndexKey(postId), String(revision), String(revision)],
      ['SET', metaKey(postId), JSON.stringify(meta)],
      ['ZADD', INDEX_KEY, String(Date.parse(at)), postId],
      ...auditCommands(postId, audit)
    ], redisOptions(options));
    if (post.slug !== previous.slug && previous.publishedSlug !== previous.slug) {
      const oldOwner = await redisCommand(['GET', slugKey(previous.slug)], redisOptions(options)).catch(() => null);
      if (oldOwner === postId) await redisCommand(['DEL', slugKey(previous.slug)], redisOptions(options)).catch(() => null);
    }
    return { meta, post, revision, validation: validateBlogPost(post) };
  } catch (error) {
    if (reservedNewSlug) {
      const current = parseJson(await redisCommand(['GET', metaKey(postId)], redisOptions(options)).catch(() => null));
      if (!current || current.slug !== reservedSlug) await redisCommand(['DEL', slugKey(reservedSlug)], redisOptions(options)).catch(() => null);
    }
    throw error;
  } finally {
    await releasePostLock(postId, owner, options);
  }
}

export async function discardBlogDraft(postId, expectedRevision, actor = {}, options = {}) {
  ensureStorage(options);
  if (!Number.isInteger(Number(expectedRevision)) || Number(expectedRevision) < 1) {
    throw cmsError('Cần gửi expectedRevision khi bỏ bản nháp.', 428, 'BLOG_REVISION_REQUIRED');
  }
  const owner = await acquirePostLock(postId, options);
  try {
    const previous = await readMeta(postId, options);
    if (Number(previous.revision) !== Number(expectedRevision)) {
      throw cmsError('Bài viết đã thay đổi. Hãy tải lại trước khi bỏ bản nháp.', 409, 'BLOG_REVISION_CONFLICT', {
        expectedRevision: Number(expectedRevision),
        currentRevision: Number(previous.revision)
      });
    }
    const publishedRevision = Number(previous.publishedRevision);
    if (previous.status !== 'published' || !Number.isInteger(publishedRevision) || publishedRevision < 1) {
      throw cmsError('Bài viết chưa có phiên bản công khai để khôi phục.', 409, 'BLOG_PUBLISHED_REVISION_REQUIRED');
    }
    const { document } = await readRevisionDocument(postId, publishedRevision, options);
    const at = nowValue(options).toISOString();
    const resetMeta = metaFromPost(postId, document.post, publishedRevision, actor, at, previous);
    const meta = {
      ...resetMeta,
      status: 'published',
      revision: publishedRevision,
      publishedRevision,
      publishedSlug: previous.publishedSlug,
      publishedSummary: previous.publishedSummary,
      hasUnpublishedChanges: false,
      publishedAt: previous.publishedAt,
      publishedUpdatedAt: previous.publishedUpdatedAt,
      updatedAt: at,
      updatedBy: actorValue(actor)
    };
    const audit = auditRecord('draft_discarded', postId, publishedRevision, actor, at, {
      discardedRevision: Number(previous.revision)
    });
    await redisTransaction([
      ['SET', metaKey(postId), JSON.stringify(meta)],
      ['ZADD', INDEX_KEY, String(Date.parse(at)), postId],
      ...auditCommands(postId, audit)
    ], redisOptions(options));
    return { meta, post: document.post, revision: publishedRevision, validation: validateBlogPost(document.post) };
  } finally {
    await releasePostLock(postId, owner, options);
  }
}

export async function unpublishBlogPost(postId, expectedRevision, actor = {}, options = {}) {
  return changePublicationState('unpublished', postId, expectedRevision, actor, options);
}

export async function archiveBlogPost(postId, expectedRevision, actor = {}, options = {}) {
  return changePublicationState('archived', postId, expectedRevision, actor, options);
}

async function changePublicationState(action, postId, expectedRevision, actor, options) {
  ensureStorage(options);
  if (!Number.isInteger(Number(expectedRevision)) || Number(expectedRevision) < 1) {
    throw cmsError('Cần gửi expectedRevision khi thay đổi trạng thái.', 428, 'BLOG_REVISION_REQUIRED');
  }
  const owner = await acquirePostLock(postId, options);
  try {
    const previous = await readMeta(postId, options);
    if (Number(previous.revision) !== Number(expectedRevision)) {
      throw cmsError('Bài viết đã thay đổi. Hãy tải lại trước khi tiếp tục.', 409, 'BLOG_REVISION_CONFLICT', {
        expectedRevision: Number(expectedRevision),
        currentRevision: Number(previous.revision)
      });
    }
    const at = nowValue(options).toISOString();
    const archived = action === 'archived';
    const meta = {
      ...previous,
      status: archived ? 'archived' : 'draft',
      publishedRevision: null,
      publishedSlug: null,
      hasUnpublishedChanges: false,
      updatedAt: at,
      updatedBy: actorValue(actor),
      unpublishedAt: at,
      archivedAt: archived ? at : null
    };
    const audit = auditRecord(action, postId, previous.revision, actor, at);
    const commands = [
      ['SET', metaKey(postId), JSON.stringify(meta)],
      ['ZADD', INDEX_KEY, String(Date.parse(at)), postId],
      ...auditCommands(postId, audit)
    ];
    for (const oldSlug of previous.managedSlugs || []) {
      if (oldSlug && oldSlug !== meta.slug) {
        commands.push(['SET', redirectKey(oldSlug), meta.slug]);
      }
    }
    await redisTransaction(commands, redisOptions(options));
    if (previous.publishedSlug && previous.publishedSlug !== meta.slug) {
      const oldOwner = await redisCommand(['GET', slugKey(previous.publishedSlug)], redisOptions(options)).catch(() => null);
      if (oldOwner === postId) await redisCommand(['DEL', slugKey(previous.publishedSlug)], redisOptions(options)).catch(() => null);
    }
    return { meta };
  } finally {
    await releasePostLock(postId, owner, options);
  }
}

export const blogCmsInternals = {
  PREFIX,
  INDEX_KEY,
  LIST_PAGE_SIZE,
  LIST_ALL_LIMIT,
  metaKey,
  slugKey,
  revisionKey,
  revisionIndexKey,
  auditKey,
  lockKey,
  redirectKey,
  parseJson,
  cmsError,
  publishedMetaView,
  relatedSlugs
};
