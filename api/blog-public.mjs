import { listBlogPosts } from '../src/blog-cms-store.mjs';
import { publicBlogSummary } from '../src/blog-public-data.mjs';

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).json({ error: 'Phương thức không được hỗ trợ.' });
  }
  try {
    const records = await listBlogPosts({ all: true });
    const posts = records.filter((meta) => meta.status === 'published').map(publicBlogSummary);
    const managedSlugs = [...new Set(records.flatMap((meta) => meta.managedSlugs || [meta.slug, meta.publishedSlug]).filter(Boolean))];
    response.setHeader('Cache-Control', 'public, s-maxage=30, must-revalidate');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return response.status(200).json({ posts, managedSlugs, cmsAvailable: true });
  } catch (error) {
    // The static library remains usable while CMS storage is unavailable.
    response.setHeader('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=60');
    return response.status(200).json({ posts: [], cmsAvailable: false });
  }
}
