import { readFile } from 'node:fs/promises';
import { listBlogPosts } from './blog-cms-store.mjs';
import { LEGACY_BLOG_SUMMARIES, blogPublicBaseUrl } from './blog-public-config.mjs';
import { publicBlogSummary, summaryToBlogRecord } from './blog-public-data.mjs';
import { renderBlogIndexTemplate } from './blog-renderer.mjs';

async function readTemplate() {
  return readFile(new URL('../public/blog.html', import.meta.url), 'utf8');
}

export default async function handler(request, response) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.setHeader('Allow', 'GET, HEAD');
    response.statusCode = 405;
    return response.end('Phương thức không được hỗ trợ.');
  }
  const template = await readTemplate();
  let html = template;
  try {
    const metas = await listBlogPosts({ all: true });
    const managedSlugs = new Set(metas.flatMap((meta) => meta.managedSlugs || [meta.slug, meta.publishedSlug]).filter(Boolean));
    const summariesBySlug = new Map(
      LEGACY_BLOG_SUMMARIES
        .filter((summary) => !managedSlugs.has(summary.slug))
        .map((summary) => [summary.slug, summary])
    );
    metas
      .filter((meta) => meta.status === 'published')
      .map(publicBlogSummary)
      .forEach((summary) => summariesBySlug.set(summary.slug, summary));
    html = renderBlogIndexTemplate(
      template,
      [...summariesBySlug.values()].map(summaryToBlogRecord),
      { baseUrl: blogPublicBaseUrl() }
    );
  } catch {
    // The static six-article hub remains available during a temporary CMS outage.
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'public, s-maxage=30, must-revalidate');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  return response.end(request.method === 'HEAD' ? undefined : html);
}

export const blogIndexHandlerInternals = { readTemplate };
