import { readFile } from 'node:fs/promises';
import { resolvePublishedBlogRoute } from './blog-cms-store.mjs';
import { LEGACY_BLOG_SLUGS, blogPublicBaseUrl } from './blog-public-config.mjs';
import { renderBlogPost } from './blog-renderer.mjs';
import { restoreStaticBlogPresentation } from './blog-static-migration.mjs';

const legacySlugSet = new Set(LEGACY_BLOG_SLUGS);

async function readLegacyBlogHtml(slug) {
  if (!legacySlugSet.has(slug)) return null;
  try {
    return await readFile(new URL(`../public/blog/${slug}.html`, import.meta.url), 'utf8');
  } catch {
    return null;
  }
}

function queryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function sendHtml(response, statusCode, body, cacheControl = 'public, s-maxage=30, must-revalidate') {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', cacheControl);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(body);
}

export default async function handler(request, response) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.setHeader('Allow', 'GET, HEAD');
    return sendHtml(response, 405, 'Phương thức không được hỗ trợ.', 'private, no-store');
  }
  const slug = String(queryValue(request.query?.slug) || '').trim();
  try {
    const route = await resolvePublishedBlogRoute(slug, { redisTimeoutMs: 1_200 });
    if (route.kind === 'redirect') {
      response.statusCode = 308;
      response.setHeader('Location', `/bai-viet/${encodeURIComponent(route.slug)}`);
      response.setHeader('Cache-Control', 'public, s-maxage=30, must-revalidate');
      return response.end();
    }
    const legacyHtml = await readLegacyBlogHtml(slug);
    const presentedRoute = legacyHtml
      ? restoreStaticBlogPresentation(route, legacyHtml, { sourcePath: `public/blog/${slug}.html` })
      : route;
    const html = renderBlogPost(presentedRoute, { baseUrl: blogPublicBaseUrl(), forPublish: true });
    if (request.method === 'HEAD') {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.setHeader('Cache-Control', 'public, s-maxage=30, must-revalidate');
      return response.end();
    }
    return sendHtml(response, 200, html);
  } catch (error) {
    const legacyHtml = error?.code === 'BLOG_POST_NOT_PUBLISHED'
      ? null
      : await readLegacyBlogHtml(slug);
    if (legacyHtml) {
      return sendHtml(
        response,
        200,
        request.method === 'HEAD' ? '' : legacyHtml,
        'public, s-maxage=300, stale-while-revalidate=3600'
      );
    }
    const status = Number(error?.statusCode) || 500;
    const message = status === 404 ? 'Không tìm thấy bài viết.' : 'Bài viết tạm thời chưa thể hiển thị.';
    response.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return sendHtml(response, status, message, 'private, no-store');
  }
}

export const blogPostHandlerInternals = { readLegacyBlogHtml };
