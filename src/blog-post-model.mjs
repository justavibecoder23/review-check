const MAX_POST_BYTES = 750_000;
const MAX_BLOCKS = 300;
const MAX_FAQ_ITEMS = 30;
const MAX_TABLE_CELLS = 1_000;
const MAX_TOC_ENTRIES = 80;

function modelError(message, code = 'INVALID_BLOG_POST', details) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = code;
  if (details) error.details = details;
  return error;
}

function cleanText(value, maximum = 20_000) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, maximum);
}

export function slugifyBlogValue(value) {
  return cleanText(value, 240)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);
}

function cleanSlug(value, fallback = '') {
  return slugifyBlogValue(value) || slugifyBlogValue(fallback);
}

function safeUrl(value, { allowRelative = true, image = false } = {}) {
  const raw = cleanText(value, 2_048);
  if (!raw) return '';
  if (allowRelative && /^\/(?!\/)[^\s]*$/.test(raw)) return raw;
  try {
    const parsed = new URL(raw);
    if (!['https:', 'http:'].includes(parsed.protocol)) return '';
    if (image && parsed.protocol !== 'https:') return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function textList(value, maximum = 30, itemMaximum = 160) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => cleanText(item, itemMaximum))
    .filter(Boolean))]
    .slice(0, maximum);
}

function normalizedImage(value = {}) {
  const allowedVariants = new Set([
    'article-lead-image--seo07',
    'article-figure--seo07',
    'article-figure--seo08-source-crop',
    'article-figure--seo09',
    'article-figure--seo09-gallery',
    'article-figure--compact',
    'article-figure--reduced',
    'article-figure--smaller'
  ]);
  const responsiveSources = [...new Map((Array.isArray(value.responsiveSources) ? value.responsiveSources : [])
    .map((source) => ({
      url: safeUrl(source?.url, { allowRelative: true, image: true }),
      width: Math.max(0, Math.min(8_000, Number.parseInt(source?.width, 10) || 0)),
      height: Math.max(0, Math.min(8_000, Number.parseInt(source?.height, 10) || 0))
    }))
    .filter((source) => source.url && source.width)
    .sort((left, right) => left.width - right.width)
    .map((source) => [source.width, source])).values()].slice(0, 8);
  const galleryImages = (Array.isArray(value.galleryImages) ? value.galleryImages : [])
    .map((image) => ({
      url: safeUrl(image?.url, { allowRelative: true, image: true }),
      alt: cleanText(image?.alt, 300),
      width: Math.max(0, Math.min(8_000, Number.parseInt(image?.width, 10) || 0)),
      height: Math.max(0, Math.min(8_000, Number.parseInt(image?.height, 10) || 0))
    }))
    .filter((image) => image.url)
    .slice(0, 12);
  return {
    url: safeUrl(value.url, { allowRelative: true, image: true }),
    alt: cleanText(value.alt, 300),
    caption: cleanText(value.caption, 1_000),
    width: Math.max(0, Math.min(8_000, Number.parseInt(value.width, 10) || 0)),
    height: Math.max(0, Math.min(8_000, Number.parseInt(value.height, 10) || 0)),
    responsiveSources,
    galleryImages,
    display: ['wide', 'compact', 'reduced', 'smaller'].includes(value.display) ? value.display : 'wide',
    variants: [...new Set((Array.isArray(value.variants) ? value.variants : [])
      .map((item) => cleanText(item, 80))
      .filter((item) => allowedVariants.has(item)))],
    captionPlacement: value.captionPlacement === 'separate' ? 'separate' : 'inside'
  };
}

function normalizeAuthor(value) {
  if (typeof value === 'string') return { name: cleanText(value, 120), url: '', email: '' };
  return {
    name: cleanText(value?.name, 120),
    url: safeUrl(value?.url, { allowRelative: true }),
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value?.email || '').trim())
      ? cleanText(value.email, 254).toLowerCase()
      : ''
  };
}

function normalizeToc(value = {}) {
  const toc = value && typeof value === 'object' ? value : {};
  return {
    mode: toc.mode === 'manual' ? 'manual' : 'auto',
    title: cleanText(toc.title, 80) || 'Mục lục',
    entries: (Array.isArray(toc.entries) ? toc.entries : [])
      .map((entry) => ({
        anchor: cleanSlug(entry?.anchor || entry?.id),
        label: cleanText(entry?.label || entry?.text, 300),
        level: Number(entry?.level) === 3 ? 3 : 2
      }))
      .filter((entry) => entry.anchor && entry.label)
      .slice(0, MAX_TOC_ENTRIES)
  };
}

function normalizeBlock(block, index) {
  const value = block && typeof block === 'object' ? block : {};
  const requestedType = cleanText(value.type, 40);
  const type = requestedType;
  const base = { id: cleanText(value.id, 100) || `block-${index + 1}`, type };
  switch (type) {
    case 'paragraph':
      return {
        ...base,
        text: cleanText(value.text),
        textStyle: ['body', 'lead', 'small'].includes(value.textStyle) ? value.textStyle : 'body'
      };
    case 'heading':
    case 'subheading': {
      const text = cleanText(value.text, 300);
      const level = type === 'subheading' || Number(value.level) === 3 ? 3 : 2;
      return {
        ...base,
        level,
        text,
        anchor: cleanSlug(value.anchor || value.id, text),
        includeInToc: value.includeInToc !== false
      };
    }
    case 'list':
      return {
        ...base,
        style: value.style === 'ordered' ? 'ordered' : 'unordered',
        items: (Array.isArray(value.items) ? value.items : [])
          .map((item) => cleanText(item, 4_000))
          .filter(Boolean)
          .slice(0, 100)
      };
    case 'checklist':
      return {
        ...base,
        items: (Array.isArray(value.items) ? value.items : [])
          .map((item) => typeof item === 'string'
            ? { text: cleanText(item, 4_000), checked: false }
            : { text: cleanText(item?.text, 4_000), checked: item?.checked === true })
          .filter((item) => item.text)
          .slice(0, 100)
      };
    case 'image':
      return { ...base, ...normalizedImage(value) };
    case 'table': {
      const headers = (Array.isArray(value.headers) ? value.headers : [])
        .map((item) => cleanText(item, 500))
        .slice(0, 30);
      const rows = (Array.isArray(value.rows) ? value.rows : [])
        .map((row) => (Array.isArray(row) ? row : [])
          .slice(0, Math.max(1, headers.length || 30))
          .map((cell) => cleanText(cell, 2_000)))
        .slice(0, Math.max(1, Math.floor(MAX_TABLE_CELLS / Math.max(1, headers.length))));
      return { ...base, caption: cleanText(value.caption, 500), headers, rows };
    }
    case 'callout':
      return {
        ...base,
        tone: ['info', 'success', 'warning', 'danger', 'neutral'].includes(value.tone) ? value.tone : 'info',
        title: cleanText(value.title, 300),
        text: cleanText(value.text)
      };
    case 'quote':
      return { ...base, text: cleanText(value.text), cite: cleanText(value.cite, 300) };
    case 'formula':
      return { ...base, text: cleanText(value.text, 4_000), ariaLabel: cleanText(value.ariaLabel, 500) };
    case 'cta':
      return {
        ...base,
        eyebrow: cleanText(value.eyebrow, 120),
        title: cleanText(value.title, 300),
        text: cleanText(value.text, 2_000),
        label: cleanText(value.label, 120),
        href: safeUrl(value.href || value.url, { allowRelative: true }),
        url: safeUrl(value.href || value.url, { allowRelative: true })
      };
    case 'faq':
      return {
        ...base,
        items: (Array.isArray(value.items) ? value.items : [])
          .map((item) => ({
            question: cleanText(item?.question, 500),
            answer: cleanText(item?.answer, 8_000)
          }))
          .filter((item) => item.question || item.answer)
          .slice(0, MAX_FAQ_ITEMS)
      };
    case 'relatedPosts':
      return { ...base, slugs: textList(value.slugs, 12, 160).map((item) => cleanSlug(item)).filter(Boolean) };
    case 'sources':
      return {
        ...base,
        items: (Array.isArray(value.items) ? value.items : [])
          .map((item) => ({ label: cleanText(item?.label, 500), href: safeUrl(item?.href, { allowRelative: true }) }))
          .filter((item) => item.label || item.href)
          .slice(0, 50)
      };
    case 'divider':
      return base;
    default:
      throw modelError(`Loại nội dung không được hỗ trợ tại block ${index + 1}.`, 'UNSUPPORTED_BLOG_BLOCK', { index, type });
  }
}

export function normalizeBlogPost(input = {}, options = {}) {
  let inputBytes = 0;
  try { inputBytes = Buffer.byteLength(JSON.stringify(input)); } catch { inputBytes = MAX_POST_BYTES + 1; }
  if (inputBytes > MAX_POST_BYTES) {
    throw modelError('Bài viết vượt quá giới hạn 750 KB.', 'BLOG_POST_TOO_LARGE');
  }
  const rawBlocks = Array.isArray(input.blocks) ? input.blocks : [];
  if (rawBlocks.length > MAX_BLOCKS) {
    throw modelError(`Bài viết chỉ được chứa tối đa ${MAX_BLOCKS} block.`, 'TOO_MANY_BLOG_BLOCKS');
  }
  const title = cleanText(input.title, 300);
  const h1 = cleanText(input.h1, 300) || title;
  const slug = cleanSlug(input.slug, title || h1 || options.fallbackSlug);
  const seoInput = input.seo && typeof input.seo === 'object' ? input.seo : {};
  const canonicalValue = seoInput.canonicalUrl || seoInput.canonicalPath || (slug ? `/bai-viet/${slug}` : '');
  const ogImageInput = seoInput.ogImageUrl
    ? { ...(seoInput.ogImage || {}), url: seoInput.ogImageUrl, alt: seoInput.ogImage?.alt || input.heroImage?.alt }
    : (seoInput.ogImage || input.heroImage);
  const post = {
    schemaVersion: '1.0.0',
    title,
    h1,
    slug,
    deck: cleanText(input.deck, 3_000),
    excerpt: cleanText(input.excerpt, 1_000),
    category: cleanSlug(input.category) || 'general',
    categoryLabel: cleanText(input.categoryLabel, 120),
    tags: textList(input.tags, 20, 100),
    authors: (Array.isArray(input.authors) ? input.authors : [])
      .map(normalizeAuthor)
      .filter((author) => author.name)
      .slice(0, 10),
    heroImage: normalizedImage(input.heroImage),
    readingMinutes: Math.max(0, Math.min(180, Number.parseInt(input.readingMinutes, 10) || 0)),
    featured: input.featured === true,
    seo: {
      title: cleanText(seoInput.title, 300),
      metaDescription: cleanText(seoInput.metaDescription, 500),
      canonicalPath: safeUrl(canonicalValue, { allowRelative: true }),
      canonicalUrl: safeUrl(canonicalValue, { allowRelative: true }),
      primaryKeyword: cleanText(seoInput.primaryKeyword, 200),
      secondaryKeywords: textList(seoInput.secondaryKeywords, 20, 200),
      searchIntent: cleanText(seoInput.searchIntent, 80),
      robots: ['index,follow,max-image-preview:large', 'noindex,nofollow'].includes(seoInput.robots)
        ? seoInput.robots
        : 'index,follow,max-image-preview:large',
      ogTitle: cleanText(seoInput.ogTitle, 300),
      ogDescription: cleanText(seoInput.ogDescription, 500),
      ogImage: normalizedImage(ogImageInput),
      ogImageUrl: safeUrl(seoInput.ogImageUrl || seoInput.ogImage?.url || input.heroImage?.url, { allowRelative: true, image: true })
    },
    blocks: rawBlocks.map(normalizeBlock),
    toc: normalizeToc(input.toc),
    relatedSlugs: textList(input.relatedSlugs || input.relatedPostIds, 12, 160).map((item) => cleanSlug(item)).filter(Boolean),
    relatedPostIds: textList(input.relatedPostIds || input.relatedSlugs, 12, 160).map((item) => cleanSlug(item)).filter(Boolean),
    settings: {
      includeFaqSchema: input.settings?.includeFaqSchema !== false,
      allowIndexing: input.settings?.allowIndexing !== false
    }
  };
  if (!post.settings.allowIndexing) post.seo.robots = 'noindex,nofollow';
  return post;
}

function issue(level, code, path, message) {
  return { level, code, path, message };
}

export function validateBlogPost(post, options = {}) {
  const issues = [];
  const forPublish = options.forPublish === true;
  const required = (condition, code, path, message) => {
    if (!condition) issues.push(issue(forPublish ? 'error' : 'warning', code, path, message));
  };
  required(post.title, 'TITLE_REQUIRED', 'title', 'Bài viết chưa có tiêu đề nội bộ.');
  required(post.h1, 'H1_REQUIRED', 'h1', 'Bài viết chưa có H1.');
  required(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(post.slug), 'SLUG_REQUIRED', 'slug', 'Slug chưa hợp lệ.');
  required(post.seo.title, 'SEO_TITLE_REQUIRED', 'seo.title', 'Chưa có SEO title.');
  required(post.seo.metaDescription, 'META_DESCRIPTION_REQUIRED', 'seo.metaDescription', 'Chưa có meta description.');
  required(post.seo.canonicalPath, 'CANONICAL_REQUIRED', 'seo.canonicalPath', 'Chưa có canonical hợp lệ.');
  required(post.heroImage.url, 'HERO_IMAGE_REQUIRED', 'heroImage.url', 'Chưa có ảnh đại diện.');
  required(post.heroImage.alt, 'HERO_ALT_REQUIRED', 'heroImage.alt', 'Ảnh đại diện chưa có alt text.');
  required(post.authors.length > 0, 'AUTHOR_REQUIRED', 'authors', 'Bài viết chưa có tác giả.');
  required(post.blocks.some((block) => block.type === 'heading' && block.level === 2), 'H2_REQUIRED', 'blocks', 'Bài viết cần ít nhất một H2.');

  if (post.settings?.allowIndexing !== false && post.seo.canonicalPath && post.slug) {
    try {
      const canonical = new URL(post.seo.canonicalPath, 'https://www.realview.com.vn');
      const allowedHost = ['realview.com.vn', 'www.realview.com.vn'].includes(canonical.hostname);
      const exactPath = canonical.pathname.replace(/\/$/, '') === `/bai-viet/${post.slug}`;
      if (canonical.protocol !== 'https:' || !allowedHost || !exactPath || canonical.search || canonical.hash) {
        issues.push(issue(forPublish ? 'error' : 'warning', 'CANONICAL_MISMATCH', 'seo.canonicalPath', 'Canonical của bài index phải trỏ đúng URL bài viết hiện tại.'));
      }
    } catch {
      issues.push(issue(forPublish ? 'error' : 'warning', 'CANONICAL_INVALID', 'seo.canonicalPath', 'Canonical chưa phải URL hợp lệ.'));
    }
  }

  if (post.seo.title && (post.seo.title.length < 30 || post.seo.title.length > 65)) {
    issues.push(issue('warning', 'SEO_TITLE_LENGTH', 'seo.title', 'SEO title nên dài khoảng 30–65 ký tự.'));
  }
  if (post.seo.metaDescription && (post.seo.metaDescription.length < 110 || post.seo.metaDescription.length > 170)) {
    issues.push(issue('warning', 'META_DESCRIPTION_LENGTH', 'seo.metaDescription', 'Meta description nên dài khoảng 110–170 ký tự.'));
  }
  if (post.seo.primaryKeyword && !post.h1.toLocaleLowerCase('vi').includes(post.seo.primaryKeyword.toLocaleLowerCase('vi'))) {
    issues.push(issue('warning', 'PRIMARY_KEYWORD_NOT_IN_H1', 'h1', 'Từ khóa chính chưa xuất hiện tự nhiên trong H1.'));
  }
  if (post.heroImage.url && (!post.heroImage.width || !post.heroImage.height)) {
    issues.push(issue('warning', 'HERO_IMAGE_DIMENSIONS_MISSING', 'heroImage', 'Ảnh đại diện nên có width và height để tránh dịch chuyển bố cục và tạo schema ảnh đầy đủ.'));
  } else if (post.heroImage.width * post.heroImage.height < 50_000) {
    issues.push(issue('warning', 'HERO_IMAGE_TOO_SMALL', 'heroImage', 'Ảnh đại diện nên có ít nhất 50.000 pixel để phù hợp yêu cầu hình ảnh bài viết của Google.'));
  }

  const headingAnchors = new Set();
  const blockIds = new Set();
  let relatedBlockCount = 0;
  let sawH2 = false;
  for (const [index, block] of post.blocks.entries()) {
    if (blockIds.has(block.id)) issues.push(issue('error', 'DUPLICATE_BLOCK_ID', `blocks.${index}.id`, 'Hai block đang dùng cùng mã định danh.'));
    blockIds.add(block.id);
    if (['heading', 'subheading'].includes(block.type)) {
      if (!block.text) issues.push(issue('error', 'EMPTY_HEADING', `blocks.${index}.text`, 'Heading không được để trống.'));
      if (!block.anchor) issues.push(issue('error', 'HEADING_ANCHOR_REQUIRED', `blocks.${index}.anchor`, 'Heading chưa có anchor.'));
      if (headingAnchors.has(block.anchor)) issues.push(issue('error', 'DUPLICATE_HEADING_ANCHOR', `blocks.${index}.anchor`, 'Hai heading đang dùng cùng anchor.'));
      headingAnchors.add(block.anchor);
      if (block.level === 2) sawH2 = true;
      if (block.level === 3 && !sawH2) issues.push(issue('error', 'HEADING_ORDER', `blocks.${index}.level`, 'H3 phải nằm sau một H2.'));
    }
    if (block.type === 'image') {
      if (!block.url) issues.push(issue('error', 'IMAGE_URL_REQUIRED', `blocks.${index}.url`, 'Ảnh chưa có URL HTTPS hoặc đường dẫn nội bộ hợp lệ.'));
      if (!block.alt) issues.push(issue(forPublish ? 'error' : 'warning', 'IMAGE_ALT_REQUIRED', `blocks.${index}.alt`, 'Ảnh chưa có alt text.'));
      block.galleryImages.forEach((image, imageIndex) => {
        if (!image.alt) issues.push(issue(forPublish ? 'error' : 'warning', 'IMAGE_ALT_REQUIRED', `blocks.${index}.galleryImages.${imageIndex}.alt`, 'Ảnh trong nhóm chưa có alt text.'));
      });
    }
    if (block.type === 'faq') {
      block.items.forEach((item, itemIndex) => {
        if (!item.question || !item.answer) issues.push(issue('error', 'FAQ_INCOMPLETE', `blocks.${index}.items.${itemIndex}`, 'Mỗi FAQ cần đủ câu hỏi và câu trả lời.'));
      });
    }
    if (block.type === 'cta' && (!block.label || !block.href)) {
      issues.push(issue(forPublish ? 'error' : 'warning', 'CTA_INCOMPLETE', `blocks.${index}`, 'CTA cần có nhãn và đường dẫn hợp lệ.'));
    }
    if (block.type === 'relatedPosts') relatedBlockCount += 1;
  }
  if (relatedBlockCount > 1) {
    issues.push(issue('error', 'MULTIPLE_RELATED_POST_BLOCKS', 'blocks', 'Mỗi bài chỉ nên có một khối bài viết liên quan.'));
  }

  if (post.toc.mode === 'manual') {
    const tocAnchors = new Set();
    post.toc.entries.forEach((entry, index) => {
      if (tocAnchors.has(entry.anchor)) {
        issues.push(issue('error', 'DUPLICATE_TOC_ANCHOR', `toc.entries.${index}.anchor`, 'Hai mục lục đang trỏ đến cùng một phần.'));
      }
      tocAnchors.add(entry.anchor);
    });
    if (!post.toc.entries.length) {
      issues.push(issue(forPublish ? 'error' : 'warning', 'MANUAL_TOC_EMPTY', 'toc.entries', 'Mục lục chỉnh tay chưa có mục nào.'));
    }
  }

  const hasInternalLink = post.blocks.some((block) =>
    (block.type === 'cta' && block.href.startsWith('/'))
    || (block.type === 'sources' && block.items.some((item) => item.href.startsWith('/')))
    || block.type === 'relatedPosts'
  ) || post.relatedSlugs.length > 0;
  if (!hasInternalLink) issues.push(issue('warning', 'INTERNAL_LINK_MISSING', 'blocks', 'Bài viết chưa có internal link hoặc bài liên quan.'));
  if (!post.blocks.some((block) => block.type === 'sources')) {
    issues.push(issue('warning', 'SOURCES_MISSING', 'blocks', 'Bài viết chưa có khối nguồn tham khảo.'));
  }

  return {
    valid: !issues.some((item) => item.level === 'error'),
    errors: issues.filter((item) => item.level === 'error'),
    warnings: issues.filter((item) => item.level === 'warning'),
    issues
  };
}

export function assertPublishableBlogPost(post) {
  const validation = validateBlogPost(post, { forPublish: true });
  if (!validation.valid) {
    throw modelError('Bài viết chưa đáp ứng các điều kiện bắt buộc để xuất bản.', 'BLOG_VALIDATION_FAILED', validation.errors);
  }
  return validation;
}

export const blogPostModelInternals = {
  MAX_POST_BYTES,
  MAX_BLOCKS,
  MAX_TOC_ENTRIES,
  cleanText,
  safeUrl,
  normalizedImage,
  normalizeBlock,
  normalizeToc
};
