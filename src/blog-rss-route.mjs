import { listBlogPosts } from './blog-cms-store.mjs';
import { LEGACY_BLOG_SUMMARIES, blogPublicBaseUrl } from './blog-public-config.mjs';
import { publicBlogSummary, summaryToBlogRecord } from './blog-public-data.mjs';
import { renderRss } from './blog-renderer.mjs';

export default async function handler(request, response) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.setHeader('Allow', 'GET, HEAD');
    response.statusCode = 405;
    return response.end('Phương thức không được hỗ trợ.');
  }
  let summaries = [...LEGACY_BLOG_SUMMARIES];
  try {
    const metas = await listBlogPosts({ all: true });
    const managedSlugs = new Set(metas.flatMap((meta) => meta.managedSlugs || [meta.slug, meta.publishedSlug]).filter(Boolean));
    const dynamic = metas.filter((meta) => meta.status === 'published').map(publicBlogSummary);
    const bySlug = new Map(summaries.map((post) => [post.slug, post]));
    managedSlugs.forEach((slug) => bySlug.delete(slug));
    dynamic.forEach((post) => bySlug.set(post.slug, post));
    summaries = [...bySlug.values()];
  } catch {}
  const records = summaries.map(summaryToBlogRecord);
  const xml = renderRss(records, { baseUrl: blogPublicBaseUrl(), limit: 50 });
  response.statusCode = 200;
  response.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
  response.setHeader('Cache-Control', 'public, s-maxage=60, must-revalidate');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(request.method === 'HEAD' ? undefined : xml);
}
