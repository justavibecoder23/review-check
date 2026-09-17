import { listBlogPosts } from './blog-cms-store.mjs';
import { STATIC_SITEMAP_ENTRIES, blogPublicBaseUrl } from './blog-public-config.mjs';
import { publicBlogSummary, summaryToBlogRecord } from './blog-public-data.mjs';
import { renderSitemap } from './blog-renderer.mjs';

export default async function handler(request, response) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.setHeader('Allow', 'GET, HEAD');
    response.statusCode = 405;
    return response.end('Phương thức không được hỗ trợ.');
  }
  let records = [];
  let staticEntries = STATIC_SITEMAP_ENTRIES;
  try {
    const metas = await listBlogPosts({ all: true });
    const managedSlugs = new Set(metas.flatMap((meta) => meta.managedSlugs || [meta.slug, meta.publishedSlug]).filter(Boolean));
    staticEntries = STATIC_SITEMAP_ENTRIES.filter((entry) => {
      const match = String(entry.path || '').match(/^\/bai-viet\/([^/]+)$/);
      return !match || !managedSlugs.has(match[1]);
    });
    const summaries = metas
      .filter((meta) => meta.status === 'published')
      .map(publicBlogSummary);
    const newestBlogUpdate = summaries
      .map((summary) => summary.updatedAt || summary.publishedAt)
      .filter(Boolean)
      .sort()
      .at(-1);
    if (newestBlogUpdate) {
      staticEntries = staticEntries.map((entry) => entry.path === '/bai-viet'
        ? { ...entry, lastmod: newestBlogUpdate }
        : entry);
    }
    records = summaries.map(summaryToBlogRecord);
  } catch {
    records = [];
  }
  const xml = renderSitemap(records, staticEntries, { baseUrl: blogPublicBaseUrl() });
  response.statusCode = 200;
  response.setHeader('Content-Type', 'application/xml; charset=utf-8');
  response.setHeader('Cache-Control', 'public, s-maxage=60, must-revalidate');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(request.method === 'HEAD' ? undefined : xml);
}
