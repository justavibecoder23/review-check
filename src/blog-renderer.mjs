import {
  normalizeBlogPost,
  slugifyBlogValue,
  validateBlogPost
} from './blog-post-model.mjs';

const DEFAULT_BASE_URL = 'https://www.realview.com.vn';
const DEFAULT_LOGO_PATH = '/assets/realview-logo-v1.webp';

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const escapeXml = escapeHtml;

function safeInlineHref(value) {
  const raw = String(value || '').trim();
  if (/^\/(?!\/)[^\s]*$/.test(raw)) return raw;
  try {
    const parsed = new URL(raw);
    return ['https:', 'http:'].includes(parsed.protocol) ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function textHtml(value) {
  const input = String(value ?? '');
  const pattern = /\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  let output = '';
  let cursor = 0;
  let match;
  const escapedText = (text) => escapeHtml(text).replace(/\n/g, '<br>');
  while ((match = pattern.exec(input))) {
    output += escapedText(input.slice(cursor, match.index));
    if (match[1] !== undefined) output += `<strong>${escapeHtml(match[1])}</strong>`;
    else if (match[2] !== undefined) output += `<em>${escapeHtml(match[2])}</em>`;
    else {
      const href = safeInlineHref(match[4]);
      output += href
        ? `<a href="${escapeHtml(href)}"${/^https?:/i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : ''}>${escapeHtml(match[3])}</a>`
        : escapeHtml(match[3]);
    }
    cursor = pattern.lastIndex;
  }
  return output + escapedText(input.slice(cursor));
}

function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function normalizedBaseUrl(value) {
  try {
    const url = new URL(value || DEFAULT_BASE_URL);
    return `${url.protocol}//${url.host}`;
  } catch {
    return DEFAULT_BASE_URL;
  }
}

function absoluteUrl(value, baseUrl = DEFAULT_BASE_URL) {
  try {
    return new URL(String(value || '/'), `${normalizedBaseUrl(baseUrl)}/`).href;
  } catch {
    return `${normalizedBaseUrl(baseUrl)}/`;
  }
}

function attrs(values = {}) {
  return Object.entries(values)
    .filter(([, value]) => value !== '' && value !== null && value !== undefined && value !== false)
    .map(([name, value]) => value === true ? ` ${name}` : ` ${name}="${escapeHtml(value)}"`)
    .join('');
}

function dateOnly(value) {
  return String(value || '').slice(0, 10);
}

function formatVietnameseDate(value) {
  if (!value || Number.isNaN(Date.parse(value))) return '';
  return new Intl.DateTimeFormat('vi-VN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Ho_Chi_Minh'
  }).format(new Date(value));
}

function recordParts(value, options = {}) {
  const rawPost = value?.post && typeof value.post === 'object' ? value.post : value;
  const meta = value?.meta && typeof value.meta === 'object' ? value.meta : {};
  const post = normalizeBlogPost(rawPost || {}, options);
  return {
    post,
    meta: {
      status: meta.status || value?.status || options.status || '',
      publishedAt: meta.publishedAt || value?.publishedAt || options.publishedAt || '',
      updatedAt: meta.updatedAt || value?.updatedAt || value?.modifiedAt || options.updatedAt || ''
    }
  };
}

function readMinutes(post) {
  if (Number(post.readingMinutes) > 0) return Number(post.readingMinutes);
  const words = [post.h1, post.deck, ...post.blocks.flatMap((block) => {
    if (block.text) return [block.text];
    if (block.items) return block.items.flatMap((item) => typeof item === 'string' ? item : [item.text, item.question, item.answer]);
    if (block.rows) return block.rows.flat();
    return [];
  })].join(' ').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}

function imageVariantClasses(image, baseClass) {
  const variants = Array.isArray(image?.variants) ? image.variants : [];
  const fallback = image?.display && image.display !== 'wide' ? [`${baseClass}--${image.display}`] : [];
  return [baseClass, ...(variants.length ? variants : fallback)].join(' ');
}

function relatedTitle(slug, options) {
  const related = options.relatedPosts;
  if (related instanceof Map) return related.get(slug)?.title || related.get(slug) || slug;
  if (related && typeof related === 'object') return related[slug]?.title || related[slug] || slug;
  return slug.replace(/-/g, ' ');
}

function renderBlock(block, options = {}) {
  switch (block.type) {
    case 'paragraph':
      return `<p>${textHtml(block.text)}</p>`;
    case 'heading':
    case 'subheading': {
      const tag = block.level === 3 || block.type === 'subheading' ? 'h3' : 'h2';
      return `<${tag}${attrs({ id: block.anchor, 'data-toc-entry': block.includeInToc })}>${escapeHtml(block.text)}</${tag}>`;
    }
    case 'list': {
      const tag = block.style === 'ordered' ? 'ol' : 'ul';
      return `<${tag}>${block.items.map((item) => `<li>${textHtml(item)}</li>`).join('')}</${tag}>`;
    }
    case 'checklist':
      return `<ul class="article-checklist">${block.items.map((item) => `<li data-checked="${item.checked ? 'true' : 'false'}"><span aria-hidden="true">${item.checked ? '✓' : '○'}</span> ${textHtml(item.text)}</li>`).join('')}</ul>`;
    case 'image':
      return block.caption && block.captionPlacement === 'separate'
        ? `<figure class="${escapeHtml(imageVariantClasses(block, 'article-figure'))}"><img${attrs({ src: block.url, alt: block.alt, width: block.width || null, height: block.height || null, loading: 'lazy', decoding: 'async' })}></figure><p class="article-caption">${textHtml(block.caption)}</p>`
        : `<figure class="${escapeHtml(imageVariantClasses(block, 'article-figure'))}"><img${attrs({ src: block.url, alt: block.alt, width: block.width || null, height: block.height || null, loading: 'lazy', decoding: 'async' })}>${block.caption ? `<figcaption>${textHtml(block.caption)}</figcaption>` : ''}</figure>`;
    case 'table':
      return `<figure class="article-table-wrap">${block.caption ? `<figcaption>${textHtml(block.caption)}</figcaption>` : ''}<div class="article-table-scroll"><table class="article-table">${block.headers.length ? `<thead><tr>${block.headers.map((item) => `<th scope="col">${textHtml(item)}</th>`).join('')}</tr></thead>` : ''}<tbody>${block.rows.map((row) => `<tr>${row.map((item) => `<td>${textHtml(item)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></figure>`;
    case 'callout':
      return `<aside class="article-source-callout article-source-callout--${escapeHtml(block.tone)}">${block.title ? `<p class="article-source-callout-title">${escapeHtml(block.title)}</p>` : ''}${block.text ? `<p>${textHtml(block.text)}</p>` : ''}</aside>`;
    case 'quote':
      return `<blockquote><p>${textHtml(block.text)}</p>${block.cite ? `<cite>${escapeHtml(block.cite)}</cite>` : ''}</blockquote>`;
    case 'formula':
      return `<div class="article-math" role="img"${attrs({ 'aria-label': block.ariaLabel || block.text })}>${escapeHtml(block.text)}</div>`;
    case 'cta':
      return `<aside class="article-source-cta">${block.eyebrow ? `<span>${escapeHtml(block.eyebrow)}</span>` : ''}${block.title ? `<h2>${escapeHtml(block.title)}</h2>` : ''}${block.text ? `<p>${textHtml(block.text)}</p>` : ''}<a href="${escapeHtml(block.href)}">${escapeHtml(block.label)} <span aria-hidden="true">→</span></a></aside>`;
    case 'faq': {
      const id = slugifyBlogValue(block.id === 'block-1' ? 'cau-hoi-thuong-gap' : block.id) || 'cau-hoi-thuong-gap';
      return `<section class="article-faq" aria-labelledby="${escapeHtml(id)}"><h2 id="${escapeHtml(id)}" data-toc-entry>Câu hỏi thường gặp</h2>${block.items.map((item, index) => `<h3 id="${escapeHtml(`${id}-${index + 1}-${slugifyBlogValue(item.question)}`)}">${escapeHtml(item.question)}</h3><p>${textHtml(item.answer)}</p>`).join('')}</section>`;
    }
    case 'relatedPosts': {
      const id = 'bai-viet-lien-quan';
      return `<section class="article-related" aria-labelledby="${id}"><h2 id="${id}" data-toc-entry>Bài viết liên quan</h2><ul>${block.slugs.map((slug) => `<li><a href="/bai-viet/${escapeHtml(slug)}">${escapeHtml(relatedTitle(slug, options))}</a></li>`).join('')}</ul></section>`;
    }
    case 'sources':
      return `<section class="article-sources"><h2>Nguồn tham khảo</h2><ol>${block.items.map((item) => `<li>${item.href ? `<a href="${escapeHtml(item.href)}" rel="noopener noreferrer">${escapeHtml(item.label || item.href)}</a>` : escapeHtml(item.label)}</li>`).join('')}</ol></section>`;
    case 'divider':
      return '<hr>';
    default:
      return '';
  }
}

export function renderBlogBody(value, options = {}) {
  const { post } = recordParts(value, options);
  return post.blocks.map((block) => renderBlock(block, options)).join('\n');
}

export function createBlogSchemas(value, options = {}) {
  const { post, meta } = recordParts(value, options);
  const siteUrl = normalizedBaseUrl(options.baseUrl || options.siteUrl || process.env.SITE_URL);
  const canonical = absoluteUrl(post.seo.canonicalPath, siteUrl);
  const image = post.seo.ogImage.url ? post.seo.ogImage : post.heroImage;
  const blogPosting = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.h1,
    description: post.seo.metaDescription,
    inLanguage: 'vi-VN',
    mainEntityOfPage: canonical,
    image: image.url ? {
      '@type': 'ImageObject',
      url: absoluteUrl(image.url, siteUrl),
      ...(image.width ? { width: image.width } : {}),
      ...(image.height ? { height: image.height } : {})
    } : undefined,
    author: post.authors.map((author) => ({ '@type': 'Person', name: author.name, ...(author.url ? { url: absoluteUrl(author.url, siteUrl) } : {}) })),
    publisher: {
      '@type': 'Organization',
      name: 'RealView',
      url: `${siteUrl}/`,
      logo: { '@type': 'ImageObject', url: absoluteUrl(options.logoPath || DEFAULT_LOGO_PATH, siteUrl), width: 128, height: 75 }
    },
    isPartOf: { '@type': 'Blog', name: 'Blog RealView', url: `${siteUrl}/bai-viet` },
    ...(meta.publishedAt ? { datePublished: meta.publishedAt } : {}),
    ...(meta.updatedAt || meta.publishedAt ? { dateModified: meta.updatedAt || meta.publishedAt } : {})
  };
  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Trang chủ', item: `${siteUrl}/` },
      { '@type': 'ListItem', position: 2, name: 'Blog', item: `${siteUrl}/bai-viet` },
      { '@type': 'ListItem', position: 3, name: post.h1, item: canonical }
    ]
  };
  const faqItems = post.blocks.filter((block) => block.type === 'faq').flatMap((block) => block.items);
  const faq = faqItems.length && post.settings.includeFaqSchema !== false ? {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqItems.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer }
    }))
  } : null;
  return { blogPosting, breadcrumb, faq };
}

export function buildBlogSchemas(value, options = {}) {
  const schemas = createBlogSchemas(value, options);
  return [schemas.blogPosting, schemas.breadcrumb, ...(schemas.faq ? [schemas.faq] : [])];
}

function renderSchemaScripts(value, options) {
  return buildBlogSchemas(value, options).map((schema) => `<script type="application/ld+json">${jsonForScript(schema)}</script>`).join('\n');
}

export function renderBlogPreview(value, options = {}) {
  const { post } = recordParts(value, options);
  const schemas = createBlogSchemas(value, options);
  const toc = post.blocks
    .filter((block) => ['heading', 'subheading'].includes(block.type) && block.includeInToc)
    .map((block) => ({ level: block.level, id: block.anchor, text: block.text }));
  const hero = post.heroImage.url
    ? `<figure class="article-lead-image"><img${attrs({ src: post.heroImage.url, alt: post.heroImage.alt, width: post.heroImage.width || null, height: post.heroImage.height || null, decoding: 'async' })}>${post.heroImage.caption ? `<figcaption>${textHtml(post.heroImage.caption)}</figcaption>` : ''}</figure>`
    : '';
  const html = `<article class="container article-shell" data-blog-preview><header><h1 class="article-title">${escapeHtml(post.h1)}</h1>${post.deck ? `<p class="article-deck">${textHtml(post.deck)}</p>` : ''}</header>${hero}<div class="article-content">${post.blocks.map((block) => renderBlock(block, options)).join('')}</div></article>`;
  return { html, toc, schemas };
}

function renderSharedHeader() {
  return `<a class="skip-link" href="#noi-dung-chinh">Đi đến nội dung chính</a><header class="site-header"><div class="container header-inner"><a class="brand" href="/#trang-chu" aria-label="RealView - Trang chủ"><span class="brand-mark" aria-hidden="true"><img src="/assets/realview-logo-v1.webp" alt="" width="128" height="75" /></span><span><b>REAL</b>VIEW</span></a><nav id="main-navigation" class="main-nav" aria-label="Điều hướng chính"></nav><div class="header-utilities"><a class="header-contact" href="/lien-he" aria-label="Mở trang Liên hệ RealView"><span>Liên hệ</span></a></div><button class="nav-toggle" type="button" aria-expanded="false" aria-controls="main-navigation"><span class="nav-toggle-label sr-only">Mở menu</span><span class="nav-toggle-lines" aria-hidden="true"><i></i><i></i></span></button></div></header>`;
}

function renderSharedFooter() {
  return `<footer class="site-footer"><div class="container footer-grid"><div class="footer-brand"><a class="brand" href="/#trang-chu"><span class="brand-mark" aria-hidden="true"><img src="/assets/realview-logo-v1.webp" alt="" width="128" height="75" /></span><span><b>REAL</b>VIEW</span></a><p>“Tiết kiệm cho quyết định đúng.”</p></div><div class="footer-menu-group"><div class="footer-social"><h2>Kết nối</h2><a href="https://www.facebook.com/profile.php?id=61594093477895" target="_blank" rel="noopener noreferrer"><span>Facebook</span></a><a href="https://www.tiktok.com/@realviewueh" target="_blank" rel="noopener noreferrer"><span>TikTok</span></a></div><div class="footer-links"><div><h2>Về RealView</h2><a href="/#trang-chu">Trang chủ</a><a href="/#ve-realview">Câu chuyện dự án</a><a href="/bai-viet">Blog</a></div><div><h2>Hỗ trợ</h2><a href="/#cach-su-dung">Cách dùng</a><a href="/lien-he">Liên hệ</a></div><div><h2>Minh bạch</h2><a href="/tieu-chi-loc">Tiêu chí lọc</a><span>Chỉ dùng dữ liệu công khai</span></div></div></div></div><div class="container footer-bottom"><span>© 2026 RealView. Dự án học thuật của sinh viên UEH.</span><span>Nội dung hỗ trợ tham khảo trước khi mua.</span></div></footer>`;
}

function renderScripts({ article = false, blog = false } = {}) {
  return `<button class="back-to-top" type="button" aria-label="Về đầu trang"></button><script src="/nav.js" defer></script>${article ? '<script src="/blog-post.js" defer></script>' : ''}${blog ? '<script src="/blog.js" defer></script>' : ''}<script type="module" src="/auth.js"></script><script type="module" src="/history-ui.js"></script><script type="module" src="/app.js"></script><script src="/chatbot.js" defer></script>`;
}

function imageMimeType(url = '') {
  const pathname = String(url).split(/[?#]/, 1)[0].toLowerCase();
  if (pathname.endsWith('.webp')) return 'image/webp';
  if (pathname.endsWith('.png')) return 'image/png';
  if (pathname.endsWith('.avif')) return 'image/avif';
  if (pathname.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

function renderArticleHead(value, options) {
  const { post, meta } = recordParts(value, options);
  const baseUrl = normalizedBaseUrl(options.baseUrl || options.siteUrl);
  const canonical = absoluteUrl(post.seo.canonicalPath, baseUrl);
  const image = post.seo.ogImage.url ? post.seo.ogImage : post.heroImage;
  const ogTitle = post.seo.ogTitle || post.seo.title || post.title;
  const ogDescription = post.seo.ogDescription || post.seo.metaDescription || post.deck;
  const imageUrl = absoluteUrl(image.url, baseUrl);
  const imageMetadata = `${image.width ? `<meta property="og:image:width" content="${escapeHtml(image.width)}" />` : ''}${image.height ? `<meta property="og:image:height" content="${escapeHtml(image.height)}" />` : ''}<meta property="og:image:type" content="${imageMimeType(image.url)}" />`;
  return `<head><script defer src="/analytics.js"></script><script defer src="/_vercel/insights/script.js"></script><script defer src="/_vercel/speed-insights/script.js"></script><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><meta name="description" content="${escapeHtml(post.seo.metaDescription)}" /><meta name="robots" content="${escapeHtml(post.settings.allowIndexing ? post.seo.robots : 'noindex,nofollow')}" /><meta name="theme-color" content="#EFEFEB" /><link rel="canonical" href="${escapeHtml(canonical)}" /><link rel="alternate" type="application/rss+xml" title="Blog RealView" href="/bai-viet/rss.xml" /><meta property="og:locale" content="vi_VN" /><meta property="og:type" content="article" /><meta property="og:site_name" content="RealView" /><meta property="og:title" content="${escapeHtml(ogTitle)}" /><meta property="og:description" content="${escapeHtml(ogDescription)}" /><meta property="og:url" content="${escapeHtml(canonical)}" /><meta property="og:image" content="${escapeHtml(imageUrl)}" />${imageMetadata}<meta property="og:image:alt" content="${escapeHtml(image.alt || post.h1)}" /><meta name="twitter:card" content="summary_large_image" /><meta name="twitter:title" content="${escapeHtml(ogTitle)}" /><meta name="twitter:description" content="${escapeHtml(ogDescription)}" /><meta name="twitter:image" content="${escapeHtml(imageUrl)}" /><meta name="twitter:image:alt" content="${escapeHtml(image.alt || post.h1)}" />${meta.publishedAt ? `<meta property="article:published_time" content="${escapeHtml(meta.publishedAt)}" />` : ''}${meta.updatedAt ? `<meta property="article:modified_time" content="${escapeHtml(meta.updatedAt)}" /><meta property="og:updated_time" content="${escapeHtml(meta.updatedAt)}" />` : ''}<title>${escapeHtml(post.seo.title || `${post.title} | RealView`)}</title><link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-v1-32.png" /><link rel="icon" type="image/png" sizes="48x48" href="/assets/favicon-v1-48.png" /><link rel="apple-touch-icon" sizes="180x180" href="/assets/apple-touch-icon-v1.png" /><link rel="stylesheet" href="/styles.css" /><link rel="stylesheet" href="/history.css" /><link rel="stylesheet" href="/auth.css" /><link rel="stylesheet" href="/chatbot.css" /><link rel="stylesheet" href="/blog.css" />${renderSchemaScripts(value, options)}</head>`;
}

export function renderBlogPost(value, options = {}) {
  const { post, meta } = recordParts(value, options);
  const validation = validateBlogPost(post, { forPublish: options.forPublish !== false });
  if (!validation.valid && options.skipValidation !== true) {
    const error = new Error('Bài viết chưa đáp ứng điều kiện để render công khai.');
    error.code = 'BLOG_VALIDATION_FAILED';
    error.details = validation.errors;
    throw error;
  }
  const authorNames = post.authors.map((author) => author.url
    ? `<a href="${escapeHtml(author.url)}" rel="author">${escapeHtml(author.name)}</a>`
    : escapeHtml(author.name)).join(' và ');
  const dateLabel = formatVietnameseDate(meta.publishedAt);
  const modifiedLabel = meta.updatedAt && dateOnly(meta.updatedAt) !== dateOnly(meta.publishedAt)
    ? formatVietnameseDate(meta.updatedAt)
    : '';
  const hero = post.heroImage;
  const bodyBlocks = post.blocks.map((block) => renderBlock(block, options)).join('\n');
  const hasRelatedBlock = post.blocks.some((block) => block.type === 'relatedPosts');
  const related = !hasRelatedBlock && post.relatedSlugs.length
    ? renderBlock({ type: 'relatedPosts', slugs: post.relatedSlugs }, options)
    : '';
  const body = `${bodyBlocks}${related}`;
  return `<!doctype html><html lang="vi">${renderArticleHead(value, options)}<body class="subpage blog-page article-page">${renderSharedHeader()}<main id="noi-dung-chinh" class="article-main"><article class="container article-shell"><nav class="article-breadcrumb" aria-label="Đường dẫn trang"><a href="/">Trang chủ</a><span aria-hidden="true">/</span><a href="/bai-viet">Blog</a><span aria-hidden="true">/</span><span>${escapeHtml(post.title)}</span></nav><div class="article-reading-grid"><h1 class="article-title">${escapeHtml(post.h1)}</h1><aside class="article-sidebar" aria-label="Thông tin và mục lục bài viết"><div class="article-metadata"><span class="article-category">${escapeHtml(post.categoryLabel || post.category)}</span><p class="article-author">${authorNames}</p><div class="article-date">${dateLabel ? `<time datetime="${escapeHtml(dateOnly(meta.publishedAt))}">${escapeHtml(dateLabel)}</time>` : ''}${modifiedLabel ? `<time datetime="${escapeHtml(dateOnly(meta.updatedAt))}">Cập nhật ${escapeHtml(modifiedLabel)}</time>` : ''}<span>${readMinutes(post)} phút đọc</span></div></div><details class="article-toc" data-article-toc><summary>Mục lục</summary><nav class="article-toc-links" aria-label="Mục lục bài viết"><ol></ol></nav></details><a class="article-sidebar-cta" href="/#trang-chu">Sử dụng RealView ngay <span aria-hidden="true">→</span></a></aside>${post.deck ? `<p class="article-deck">${textHtml(post.deck)}</p>` : ''}<div class="article-body-column"><img class="${escapeHtml(imageVariantClasses(hero, 'article-lead-image'))}"${attrs({ src: hero.url, alt: hero.alt, width: hero.width || null, height: hero.height || null, fetchpriority: 'high', loading: 'eager', decoding: 'async' })}><div class="article-content">${body}</div></div></div></article></main>${renderSharedFooter()}${renderScripts({ article: true })}</body></html>`;
}

export function renderBlogCard(value, options = {}) {
  const { post, meta } = recordParts(value, options);
  const href = post.seo.canonicalPath;
  const featured = options.featured === true;
  const search = [post.title, post.seo.metaDescription, ...post.tags].join(' ').toLocaleLowerCase('vi');
  const image = `<img${attrs({ src: post.heroImage.url, alt: post.heroImage.alt, width: post.heroImage.width || null, height: post.heroImage.height || null, loading: 'lazy', decoding: 'async' })}>`;
  const common = `<div class="post-meta"><span>${escapeHtml(post.categoryLabel || post.category)}</span>${meta.publishedAt ? `<time datetime="${escapeHtml(dateOnly(meta.publishedAt))}">${escapeHtml(formatVietnameseDate(meta.publishedAt))}</time>` : ''}<span>${readMinutes(post)} phút đọc</span></div><h3><a href="${escapeHtml(href)}">${escapeHtml(post.title)}</a></h3><p>${escapeHtml(post.excerpt || post.seo.metaDescription)}</p><a class="read-more" href="${escapeHtml(href)}">Đọc bài viết <span aria-hidden="true">→</span></a>`;
  return featured
    ? `<div class="blog-list-item" data-blog-card data-category="${escapeHtml(post.category)}" data-search="${escapeHtml(search)}"><article class="featured-post"><a class="featured-post-image" href="${escapeHtml(href)}" aria-label="Đọc bài ${escapeHtml(post.title)}">${image}</a><div class="featured-post-copy">${common}</div></article></div>`
    : `<div class="blog-list-item" data-blog-card data-category="${escapeHtml(post.category)}" data-search="${escapeHtml(search)}"><article class="post-card"><a href="${escapeHtml(href)}" aria-label="Đọc bài ${escapeHtml(post.title)}">${image}</a><div class="post-card-body">${common}</div></article></div>`;
}

function publishedRecords(records) {
  return (Array.isArray(records) ? records : [])
    .map((record) => ({ source: record, ...recordParts(record) }))
    .filter(({ post, meta }) => meta.status === 'published' && post.settings.allowIndexing && post.seo.robots.startsWith('index'))
    .sort((left, right) => String(right.meta.publishedAt).localeCompare(String(left.meta.publishedAt)));
}

export function renderBlogIndex(records, options = {}) {
  const entries = publishedRecords(records);
  const featuredIndex = Math.max(0, entries.findIndex(({ post }) => post.featured));
  const featured = entries[featuredIndex];
  const remaining = entries.filter((_, index) => index !== featuredIndex);
  const baseUrl = normalizedBaseUrl(options.baseUrl || options.siteUrl);
  const schema = { '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Blog RealView', url: `${baseUrl}/bai-viet`, mainEntity: { '@type': 'ItemList', numberOfItems: entries.length, itemListElement: entries.map(({ post }, index) => ({ '@type': 'ListItem', position: index + 1, name: post.title, url: absoluteUrl(post.seo.canonicalPath, baseUrl) })) } };
  return `<!doctype html><html lang="vi"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><meta name="description" content="Kiến thức giúp người mua đọc review và mua hàng thông minh." /><meta name="robots" content="index,follow,max-image-preview:large" /><link rel="canonical" href="${baseUrl}/bai-viet" /><title>Blog RealView | Đọc review và mua hàng thông minh</title><link rel="stylesheet" href="/styles.css" /><link rel="stylesheet" href="/history.css" /><link rel="stylesheet" href="/auth.css" /><link rel="stylesheet" href="/chatbot.css" /><link rel="stylesheet" href="/blog.css" /><script type="application/ld+json">${jsonForScript(schema)}</script></head><body class="subpage blog-page">${renderSharedHeader()}<main id="noi-dung-chinh"><section class="blog-hero"><div class="container blog-hero-inner"><div><p class="blog-eyebrow">Góc nhìn thật · Lựa chọn đúng</p><h1>Đọc review thông minh trước khi mua hàng</h1><p>Hướng dẫn thực tế để nhận biết tín hiệu đáng tin và đưa ra quyết định mua hàng có cơ sở.</p></div></div></section><section id="thu-vien-bai-viet" class="blog-library"><div class="container"><div class="library-heading"><div><p class="blog-eyebrow">Kiến thức dành cho người mua</p><h2>Bài viết mới từ RealView</h2></div></div><div class="blog-tools"><div class="blog-filters" role="group" aria-label="Lọc theo chủ đề"><button class="is-active" type="button" data-blog-filter="all" aria-pressed="true">Tất cả</button><button type="button" data-blog-filter="doc-review" aria-pressed="false">Đọc review</button><button type="button" data-blog-filter="nen-tang" aria-pressed="false">Nền tảng mua sắm</button><button type="button" data-blog-filter="realview" aria-pressed="false">RealView</button></div><label class="blog-search" for="blog-search-input"><span class="sr-only">Tìm kiếm bài viết</span><input id="blog-search-input" type="search" placeholder="Tìm bài viết..." autocomplete="off"></label></div><div class="blog-feed">${featured ? renderBlogCard(featured.source, { featured: true }) : ''}<div class="post-grid">${remaining.map((entry) => renderBlogCard(entry.source)).join('')}</div><p class="blog-empty" data-blog-empty hidden>Chưa có bài viết phù hợp.</p></div></div></section></main>${renderSharedFooter()}${renderScripts({ blog: true })}</body></html>`;
}

export function renderBlogIndexTemplate(template, records, options = {}) {
  const entries = publishedRecords(records);
  const featuredIndex = Math.max(0, entries.findIndex(({ post }) => post.featured));
  const featured = entries[featuredIndex];
  const remaining = entries.filter((_, index) => index !== featuredIndex);
  const baseUrl = normalizedBaseUrl(options.baseUrl || options.siteUrl);
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'Blog RealView',
    description: 'Kiến thức đọc review và mua sắm trực tuyến có chọn lọc.',
    url: `${baseUrl}/bai-viet`,
    inLanguage: 'vi-VN',
    publisher: { '@type': 'Organization', name: 'RealView', url: `${baseUrl}/` },
    isPartOf: { '@type': 'WebSite', name: 'RealView', url: `${baseUrl}/` },
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: entries.length,
      itemListElement: entries.map(({ post }, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: post.title,
        url: absoluteUrl(post.seo.canonicalPath, baseUrl)
      }))
    }
  };
  const featuredHtml = featured ? renderBlogCard(featured.source, { featured: true }) : '';
  const gridHtml = remaining.map((entry) => renderBlogCard(entry.source)).join('\n');
  return String(template)
    .replace(
      /<!-- BLOG_COLLECTION_SCHEMA_START -->[\s\S]*?<!-- BLOG_COLLECTION_SCHEMA_END -->/,
      `<!-- BLOG_COLLECTION_SCHEMA_START --><script type="application/ld+json">${jsonForScript(schema)}</script><!-- BLOG_COLLECTION_SCHEMA_END -->`
    )
    .replace(
      /<!-- BLOG_FEATURED_START -->[\s\S]*?<!-- BLOG_FEATURED_END -->/,
      `<!-- BLOG_FEATURED_START -->${featuredHtml}<!-- BLOG_FEATURED_END -->`
    )
    .replace(
      /<!-- BLOG_GRID_START -->[\s\S]*?<!-- BLOG_GRID_END -->/,
      `<!-- BLOG_GRID_START -->${gridHtml}<!-- BLOG_GRID_END -->`
    );
}

export function renderSitemap(records, staticUrls = [], options = {}) {
  const baseUrl = normalizedBaseUrl(options.baseUrl || options.siteUrl);
  const fixed = (Array.isArray(staticUrls) ? staticUrls : []).map((entry) => typeof entry === 'string' ? { path: entry } : entry);
  const dynamic = publishedRecords(records).map(({ post, meta }) => ({ path: post.seo.canonicalPath, lastmod: meta.updatedAt || meta.publishedAt, image: post.heroImage }));
  const urlsByPath = new Map();
  for (const entry of [...fixed, ...dynamic]) {
    const key = String(entry.path || entry.url || '').replace(/\/$/, '') || '/';
    urlsByPath.set(key, entry);
  }
  const urls = [...urlsByPath.values()];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${urls.map((entry) => `  <url><loc>${escapeXml(absoluteUrl(entry.path || entry.url, baseUrl))}</loc>${entry.lastmod ? `<lastmod>${escapeXml(dateOnly(entry.lastmod))}</lastmod>` : ''}${entry.image?.url ? `<image:image><image:loc>${escapeXml(absoluteUrl(entry.image.url, baseUrl))}</image:loc></image:image>` : ''}</url>`).join('\n')}\n</urlset>`;
}

export function renderRss(records, options = {}) {
  const baseUrl = normalizedBaseUrl(options.baseUrl || options.siteUrl);
  const entries = publishedRecords(records).slice(0, Math.max(1, Number(options.limit) || 50));
  const buildDate = entries[0]?.meta.updatedAt || entries[0]?.meta.publishedAt || new Date(0).toISOString();
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>Blog RealView</title><link>${escapeXml(`${baseUrl}/bai-viet`)}</link><description>Kiến thức giúp người mua đọc review và mua hàng thông minh.</description><language>vi-VN</language><lastBuildDate>${escapeXml(new Date(buildDate).toUTCString())}</lastBuildDate>${entries.map(({ post, meta }) => `<item><title>${escapeXml(post.title)}</title><link>${escapeXml(absoluteUrl(post.seo.canonicalPath, baseUrl))}</link><guid isPermaLink="true">${escapeXml(absoluteUrl(post.seo.canonicalPath, baseUrl))}</guid><description>${escapeXml(post.excerpt || post.seo.metaDescription)}</description><pubDate>${escapeXml(new Date(meta.publishedAt).toUTCString())}</pubDate></item>`).join('')}</channel></rss>`;
}

export const normalizePost = normalizeBlogPost;
export const validatePost = validateBlogPost;

export const blogRendererInternals = {
  absoluteUrl,
  attrs,
  dateOnly,
  formatVietnameseDate,
  jsonForScript,
  publishedRecords,
  readMinutes,
  recordParts,
  renderBlock,
  textHtml
};
