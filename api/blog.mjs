import adminBlogHandler from '../src/blog-admin-route.mjs';
import blogIndexHandler from '../src/blog-index-route.mjs';
import blogPostHandler from '../src/blog-post-route.mjs';
import blogPublicHandler from '../src/blog-public-route.mjs';
import blogRssHandler from '../src/blog-rss-route.mjs';
import blogSitemapHandler from '../src/blog-sitemap-route.mjs';

const handlers = new Map([
  ['admin', adminBlogHandler],
  ['index', blogIndexHandler],
  ['post', blogPostHandler],
  ['public', blogPublicHandler],
  ['rss', blogRssHandler],
  ['sitemap', blogSitemapHandler]
]);

function firstQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(request, response) {
  // `route` selects the top-level blog handler. Keep `action` available for
  // handler-specific commands such as admin access/list/detail.
  const route = String(firstQueryValue(request.query?.route) || firstQueryValue(request.query?.action) || '').trim();
  const routeHandler = handlers.get(route);
  if (!routeHandler) {
    response.statusCode = 404;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'private, no-store');
    return response.end(JSON.stringify({ error: 'Blog API không tồn tại.' }));
  }
  return routeHandler(request, response);
}

export const blogRouterInternals = { handlers, firstQueryValue };
