function buildPublicBlogSummary(source = {}, envelope = source) {
  return {
    id: envelope.id || source.id,
    slug: source.slug || envelope.publishedSlug || envelope.slug,
    title: source.title,
    h1: source.h1 || source.title,
    deck: source.deck || '',
    excerpt: source.excerpt || source.seo?.metaDescription || source.deck || '',
    category: source.category || 'general',
    categoryLabel: source.categoryLabel || source.category || 'Kiến thức',
    tags: Array.isArray(source.tags) ? source.tags : [],
    authors: Array.isArray(source.authors)
      ? source.authors.map((author) => ({
          name: String(author?.name || '').trim(),
          ...(author?.url ? { url: author.url } : {})
        })).filter((author) => author.name)
      : [],
    heroImage: source.heroImage || {},
    featured: source.featured === true,
    readingMinutes: Math.max(1, Number(source.readingMinutes) || 1),
    seo: {
      title: source.seo?.title || source.title || '',
      metaDescription: source.seo?.metaDescription || source.excerpt || source.deck || '',
      canonicalPath: source.seo?.canonicalPath || `/bai-viet/${source.slug || envelope.publishedSlug || envelope.slug || ''}`,
      robots: source.seo?.robots || 'index,follow,max-image-preview:large'
    },
    settings: {
      allowIndexing: source.settings?.allowIndexing !== false
    },
    status: envelope.status,
    publishedAt: envelope.publishedAt,
    updatedAt: source.publishedUpdatedAt || source.updatedAt || envelope.publishedUpdatedAt || envelope.updatedAt
  };
}

export function createPublicBlogSummarySnapshot(meta = {}) {
  return buildPublicBlogSummary(meta, meta);
}

export function publicBlogSummary(meta = {}) {
  const snapshot = meta.publishedSummary && typeof meta.publishedSummary === 'object'
    ? meta.publishedSummary
    : meta;
  return buildPublicBlogSummary(snapshot, meta);
}

export function summaryToBlogRecord(summary) {
  return {
    post: {
      ...summary,
      blocks: [],
      relatedSlugs: [],
      settings: summary.settings,
      seo: summary.seo
    },
    meta: {
      status: summary.status,
      publishedAt: summary.publishedAt,
      updatedAt: summary.updatedAt
    }
  };
}
