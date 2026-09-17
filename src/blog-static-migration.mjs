import { createHash } from 'node:crypto';
import { normalizeBlogPost, validateBlogPost } from './blog-post-model.mjs';

function decodeHtml(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function stripTags(value) {
  return decodeHtml(String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim());
}

function inlineMarkdown(value) {
  const source = String(value || '')
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => `[${stripTags(label)}](${decodeHtml(href)})`)
    .replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, (_, text) => `**${stripTags(text)}**`)
    .replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, (_, text) => `*${stripTags(text)}*`);
  return stripTags(source);
}

function tagAttribute(tag, name) {
  return decodeHtml(tag.match(new RegExp(`\\s${name}=["']([^"']*)["']`, 'i'))?.[1] || '');
}

function firstMatch(html, pattern) {
  return html.match(pattern)?.[1] || '';
}

function metaContent(html, key, value) {
  const tag = (html.match(/<meta\b[^>]*>/gi) || [])
    .find((item) => tagAttribute(item, key).toLowerCase() === value.toLowerCase());
  return tag ? tagAttribute(tag, 'content') : '';
}

function linkHref(html, rel) {
  const tag = (html.match(/<link\b[^>]*>/gi) || [])
    .find((item) => tagAttribute(item, 'rel').toLowerCase() === rel.toLowerCase());
  return tag ? tagAttribute(tag, 'href') : '';
}

function extractBalancedInner(html, marker, tagName = 'div') {
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return '';
  const openStart = html.lastIndexOf(`<${tagName}`, markerIndex);
  const openEnd = html.indexOf('>', markerIndex);
  if (openStart < 0 || openEnd < 0) return '';
  const tokens = new RegExp(`<${tagName}\\b[^>]*>|<\\/${tagName}\\s*>`, 'gi');
  tokens.lastIndex = openStart;
  let depth = 0;
  let token;
  while ((token = tokens.exec(html))) {
    depth += token[0][1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(openEnd + 1, token.index).trim();
  }
  return '';
}

function jsonLdItems(html) {
  return [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .flatMap((match) => {
      try {
        const value = JSON.parse(match[1]);
        return Array.isArray(value) ? value : [value];
      } catch {
        return [];
      }
    });
}

function canonicalSlug(canonical, fallback = '') {
  try {
    return new URL(canonical).pathname.split('/').filter(Boolean).at(-1) || fallback;
  } catch {
    return fallback;
  }
}

function directNodes(html) {
  const nodes = [];
  let cursor = 0;
  const opening = /<(h2|h3|p|ul|ol|figure|aside|div)\b[^>]*>/gi;
  while (cursor < html.length) {
    opening.lastIndex = cursor;
    const match = opening.exec(html);
    if (!match) break;
    const tagName = match[1].toLowerCase();
    const start = match.index;
    const tokens = new RegExp(`<${tagName}\\b[^>]*>|<\\/${tagName}\\s*>`, 'gi');
    tokens.lastIndex = start;
    let depth = 0;
    let token;
    let end = opening.lastIndex;
    while ((token = tokens.exec(html))) {
      depth += token[0][1] === '/' ? -1 : 1;
      if (depth === 0) {
        end = tokens.lastIndex;
        break;
      }
    }
    nodes.push({ tagName, html: html.slice(start, end), opening: match[0] });
    cursor = end;
  }
  return nodes;
}

function listItems(html) {
  return [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((match) => inlineMarkdown(match[1])).filter(Boolean);
}

function links(html) {
  return [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => ({ href: decodeHtml(match[1]), label: stripTags(match[2]) }));
}

function imageBlock(html) {
  const tag = html.match(/<img\b[^>]*>/i)?.[0] || '';
  if (!tag) return null;
  const className = tagAttribute(html.match(/<figure\b[^>]*>/i)?.[0] || '', 'class');
  const variants = className.split(/\s+/).filter((item) => item.startsWith('article-figure--'));
  let display = 'wide';
  if (className.includes('--smaller')) display = 'smaller';
  else if (className.includes('--reduced')) display = 'reduced';
  else if (className.includes('--compact')) display = 'compact';
  return {
    type: 'image',
    url: tagAttribute(tag, 'src'),
    alt: tagAttribute(tag, 'alt'),
    width: Number(tagAttribute(tag, 'width')) || 0,
    height: Number(tagAttribute(tag, 'height')) || 0,
    caption: stripTags(firstMatch(html, /<(?:figcaption|p)\b[^>]*>([\s\S]*?)<\/(?:figcaption|p)>/i)),
    display,
    variants,
    captionPlacement: 'separate'
  };
}

function tableBlock(html) {
  const headHtml = firstMatch(html, /<thead\b[^>]*>([\s\S]*?)<\/thead>/i);
  const bodyHtml = firstMatch(html, /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i) || html;
  const headers = [...headHtml.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((match) => inlineMarkdown(match[1]));
  const rows = [...bodyHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((match) => [...match[1].matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)].map((cell) => inlineMarkdown(cell[1])))
    .filter((row) => row.length);
  return headers.length || rows.length ? { type: 'table', headers, rows, caption: '' } : null;
}

function readMinutesFromHtml(html) {
  const articleDate = firstMatch(html, /<div\b[^>]*class=["'][^"']*article-date[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  const match = stripTags(articleDate).match(/(\d+)\s*phút\s*đọc/i);
  return Number(match?.[1]) || 0;
}

function basicBlocks(contentHtml) {
  const blocks = [];
  for (const node of directNodes(contentHtml)) {
    const className = tagAttribute(node.opening, 'class');
    if (node.tagName === 'h2' || node.tagName === 'h3') {
      blocks.push({
        type: 'heading',
        level: node.tagName === 'h3' ? 3 : 2,
        text: stripTags(node.html),
        anchor: tagAttribute(node.opening, 'id'),
        includeInToc: /\bdata-toc-entry\b/i.test(node.opening)
      });
      continue;
    }
    if (node.tagName === 'p') {
      const text = inlineMarkdown(node.html);
      if (!text) continue;
      if (className.includes('article-caption') && blocks.at(-1)?.type === 'image') {
        blocks.at(-1).caption = text;
        continue;
      }
      const nodeLinks = links(node.html);
      if (className.includes('article-source-cta') && nodeLinks[0]) {
        blocks.push({ type: 'cta', label: nodeLinks[0].label, href: nodeLinks[0].href, text: '', title: '', eyebrow: '' });
      } else {
        blocks.push({ type: 'paragraph', text, _links: nodeLinks });
      }
      continue;
    }
    if (node.tagName === 'ul' || node.tagName === 'ol') {
      blocks.push({ type: 'list', style: node.tagName === 'ol' ? 'ordered' : 'unordered', items: listItems(node.html), _links: links(node.html) });
      continue;
    }
    if (node.tagName === 'figure') {
      const image = imageBlock(node.html);
      if (image) blocks.push(image);
      continue;
    }
    if (node.tagName === 'div' && className.includes('article-table-wrap')) {
      const table = tableBlock(node.html);
      if (table) blocks.push(table);
      continue;
    }
    if (node.tagName === 'aside') {
      const title = stripTags(firstMatch(node.html, /<p\b[^>]*class=["'][^"']*article-source-callout-title[^"']*["'][^>]*>([\s\S]*?)<\/p>/i));
      const paragraphs = [...node.html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((match) => stripTags(match[1])).filter((text) => text && text !== title);
      blocks.push({ type: 'callout', tone: 'info', title, text: paragraphs.join('\n') || stripTags(node.html) });
    }
  }
  return blocks;
}

function consolidateSemanticBlocks(blocks) {
  const output = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const headingKey = block.type === 'heading' ? `${block.anchor} ${block.text}`.toLocaleLowerCase('vi') : '';
    if (block.type === 'heading' && block.level === 2 && /(^|\s)(faq|câu hỏi thường gặp|cau hoi thuong gap)/i.test(headingKey)) {
      const items = [];
      let cursor = index + 1;
      while (cursor < blocks.length && !(blocks[cursor].type === 'heading' && blocks[cursor].level === 2)) {
        if (blocks[cursor].type === 'heading' && blocks[cursor].level === 3) {
          const answerParts = [];
          let answerCursor = cursor + 1;
          while (answerCursor < blocks.length && blocks[answerCursor].type !== 'heading') {
            if (blocks[answerCursor].type === 'paragraph') answerParts.push(blocks[answerCursor].text);
            answerCursor += 1;
          }
          items.push({ question: blocks[cursor].text, answer: answerParts.join('\n') });
          cursor = answerCursor;
        } else cursor += 1;
      }
      if (items.length) {
        output.push({ type: 'faq', items });
        index = cursor - 1;
        continue;
      }
    }
    if (block.type === 'heading' && block.level === 2 && /bai-viet-lien-quan|bài viết liên quan/i.test(headingKey)) {
      const slugs = [];
      let cursor = index + 1;
      while (cursor < blocks.length && !(blocks[cursor].type === 'heading' && blocks[cursor].level === 2)) {
        for (const link of blocks[cursor]._links || []) {
          const match = link.href.match(/^\/bai-viet\/([^/?#]+)/);
          if (match) slugs.push(match[1]);
        }
        cursor += 1;
      }
      if (slugs.length) {
        output.push({ type: 'relatedPosts', slugs: [...new Set(slugs)] });
        index = cursor - 1;
        continue;
      }
    }
    if (block.type === 'heading' && block.level === 2 && /nguon-tham-khao|nguồn tham khảo/i.test(headingKey)) {
      const items = [];
      let cursor = index + 1;
      while (cursor < blocks.length && !(blocks[cursor].type === 'heading' && blocks[cursor].level === 2)) {
        for (const link of blocks[cursor]._links || []) items.push({ label: link.label, href: link.href });
        cursor += 1;
      }
      if (items.length) {
        output.push({ type: 'sources', items });
        index = cursor - 1;
        continue;
      }
    }
    const clean = { ...block };
    delete clean._links;
    output.push(clean);
  }
  return output;
}

export function migrateStaticBlogHtml(html, options = {}) {
  const sourceHtml = String(html || '');
  const schemas = jsonLdItems(sourceHtml);
  const blogPosting = schemas.find((item) => item?.['@type'] === 'BlogPosting') || {};
  const faqSchema = schemas.find((item) => item?.['@type'] === 'FAQPage');
  const canonical = linkHref(sourceHtml, 'canonical');
  const fallbackSlug = String(options.sourcePath || '').split('/').at(-1)?.replace(/\.html$/i, '') || '';
  const slug = canonicalSlug(canonical, fallbackSlug);
  const h1 = stripTags(firstMatch(sourceHtml, /<h1\b[^>]*class=["'][^"']*article-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i)) || String(blogPosting.headline || '');
  const documentTitle = stripTags(firstMatch(sourceHtml, /<title>([\s\S]*?)<\/title>/i));
  const deck = stripTags(firstMatch(sourceHtml, /<p\b[^>]*class=["'][^"']*article-deck[^"']*["'][^>]*>([\s\S]*?)<\/p>/i));
  const categoryLabel = stripTags(firstMatch(sourceHtml, /<span\b[^>]*class=["'][^"']*article-category[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)) || 'Kiến thức';
  const heroTag = sourceHtml.match(/<img\b[^>]*class=["'][^"']*article-lead-image[^"']*["'][^>]*>/i)?.[0] || '';
  const marker = sourceHtml.match(/<div\b[^>]*class=["'][^"']*article-content[^"']*["'][^>]*>/i)?.[0] || '';
  const contentHtml = extractBalancedInner(sourceHtml, marker);
  const blocks = consolidateSemanticBlocks(basicBlocks(contentHtml));
  const heroImage = {
    url: tagAttribute(heroTag, 'src'),
    alt: tagAttribute(heroTag, 'alt'),
    width: Number(tagAttribute(heroTag, 'width')) || 0,
    height: Number(tagAttribute(heroTag, 'height')) || 0,
    display: 'wide',
    variants: tagAttribute(heroTag, 'class').split(/\s+/).filter((item) => item.startsWith('article-lead-image--'))
  };
  const authors = Array.isArray(blogPosting.author)
    ? blogPosting.author.map((author) => ({ name: author?.name, url: author?.url })).filter((author) => author.name)
    : blogPosting.author?.name ? [{ name: blogPosting.author.name, url: blogPosting.author.url }] : [];
  const post = normalizeBlogPost({
    title: h1,
    h1,
    slug,
    deck,
    excerpt: metaContent(sourceHtml, 'name', 'description') || deck,
    category: categoryLabel,
    categoryLabel,
    authors,
    heroImage,
    readingMinutes: readMinutesFromHtml(sourceHtml),
    blocks,
    seo: {
      title: documentTitle,
      metaDescription: metaContent(sourceHtml, 'name', 'description') || blogPosting.description,
      canonicalPath: `/bai-viet/${slug}`,
      ogTitle: metaContent(sourceHtml, 'property', 'og:title') || h1,
      ogDescription: metaContent(sourceHtml, 'property', 'og:description') || deck,
      ogImage: { ...heroImage, url: metaContent(sourceHtml, 'property', 'og:image') || heroImage.url },
      robots: metaContent(sourceHtml, 'name', 'robots') || 'index,follow,max-image-preview:large'
    },
    settings: { includeFaqSchema: true, allowIndexing: true }
  });
  const validation = validateBlogPost(post, { forPublish: true });
  return {
    post,
    meta: {
      status: options.status || 'published',
      publishedAt: blogPosting.datePublished || metaContent(sourceHtml, 'property', 'article:published_time'),
      updatedAt: blogPosting.dateModified || metaContent(sourceHtml, 'property', 'article:modified_time')
    },
    migration: {
      format: 'realview-static-html-v1',
      sourcePath: String(options.sourcePath || ''),
      sourceHash: createHash('sha256').update(sourceHtml).digest('hex'),
      originalCanonical: canonical,
      originalWordCount: Number(marker.match(/data-source-word-count=["'](\d+)["']/i)?.[1]) || 0,
      hadFaqSchema: Boolean(faqSchema)
    },
    migrationValidation: validation
  };
}

export function restoreStaticBlogPresentation(value, html, options = {}) {
  const source = migrateStaticBlogHtml(html, options).post;
  const record = value?.post && typeof value.post === 'object' ? value : { post: value };
  const post = record.post || {};
  const imageByUrl = new Map(source.blocks
    .filter((block) => block.type === 'image' && block.url)
    .map((block) => [block.url, block]));
  const sourceTables = source.blocks.filter((block) => block.type === 'table');
  let tableIndex = 0;
  const blocks = (Array.isArray(post.blocks) ? post.blocks : []).map((block) => {
    if (block.type === 'image') {
      const presentation = imageByUrl.get(block.url);
      return presentation ? {
        ...block,
        variants: presentation.variants,
        captionPlacement: presentation.captionPlacement
      } : block;
    }
    if (block.type === 'table') {
      const presentation = sourceTables[tableIndex++];
      const currentColumns = Math.max(block.headers?.length || 0, ...(block.rows || []).map((row) => row.length));
      const sourceColumns = Math.max(presentation?.headers?.length || 0, ...(presentation?.rows || []).map((row) => row.length));
      if (presentation && currentColumns < sourceColumns) return { ...presentation, id: block.id };
    }
    return block;
  });
  return {
    ...record,
    post: {
      ...post,
      readingMinutes: source.readingMinutes || post.readingMinutes,
      heroImage: {
        ...post.heroImage,
        variants: source.heroImage.variants
      },
      blocks
    }
  };
}

export const blogStaticMigrationInternals = {
  basicBlocks,
  canonicalSlug,
  consolidateSemanticBlocks,
  decodeHtml,
  directNodes,
  extractBalancedInner,
  jsonLdItems,
  metaContent,
  stripTags,
  inlineMarkdown,
  tagAttribute
};
