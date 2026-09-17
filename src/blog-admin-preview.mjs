import {
  createBlogSchemas,
  escapeHtml,
  renderBlogPreview as renderPublicBlogPreview
} from './blog-renderer.mjs';

export function createBlogPreviewSchemas(post, options = {}) {
  return createBlogSchemas({ post, meta: { publishedAt: options.publishedAt, updatedAt: options.updatedAt } }, options);
}

export function renderBlogPreview(post, options = {}) {
  return renderPublicBlogPreview({ post, meta: { publishedAt: options.publishedAt, updatedAt: options.updatedAt } }, options);
}

export function renderBlogPreviewDocument(post, options = {}) {
  const preview = renderBlogPreview(post, options);
  const title = post.seo.title || post.title || post.h1 || 'Xem trước bài viết';
  return {
    html: `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/blog.css"></head><body class="subpage blog-page article-page"><main class="article-main">${preview.html}</main></body></html>`,
    toc: preview.toc,
    schemas: preview.schemas
  };
}

export const blogAdminPreviewInternals = { escapeHtml };
