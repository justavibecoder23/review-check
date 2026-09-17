import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveBlogRole, hasBlogRole } from '../src/blog-admin-auth.mjs';
import {
  createBlogPost,
  getBlogPost,
  getBlogPostBySlug,
  getPublishedBlogPostBySlug,
  listBlogAudit,
  listBlogPosts,
  listBlogRevisions,
  publishBlogPost,
  resolvePublishedBlogRoute,
  restoreBlogRevision,
  unpublishBlogPost,
  updateBlogPost,
  blogCmsInternals
} from '../src/blog-cms-store.mjs';
import blogPostHandler from '../src/blog-post-route.mjs';
import { blogPostHandlerInternals } from '../src/blog-post-route.mjs';
import { decodeBlogMedia } from '../src/blog-media-store.mjs';
import { normalizeBlogPost, validateBlogPost } from '../src/blog-post-model.mjs';
import { renderBlogPreview } from '../src/blog-admin-preview.mjs';
import { publicBlogSummary, summaryToBlogRecord } from '../src/blog-public-data.mjs';
import { renderBlogIndexTemplate, renderBlogPost, renderSitemap } from '../src/blog-renderer.mjs';
import { migrateStaticBlogHtml, restoreStaticBlogPresentation } from '../src/blog-static-migration.mjs';

function redisMock() {
  const strings = new Map();
  const sorted = new Map();
  const lists = new Map();

  function range(values, startValue, stopValue, reverse = false) {
    const ordered = [...values.entries()]
      .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
      .map(([member]) => member);
    if (reverse) ordered.reverse();
    const start = Number(startValue);
    const stopValueNumber = Number(stopValue);
    const stop = stopValueNumber < 0 ? ordered.length + stopValueNumber : stopValueNumber;
    return ordered.slice(start, stop + 1);
  }

  function listRange(value, startValue, stopValue) {
    const start = Number(startValue);
    const stopValueNumber = Number(stopValue);
    const stop = stopValueNumber < 0 ? value.length + stopValueNumber : stopValueNumber;
    return value.slice(start, stop + 1);
  }

  function command(parts) {
    const [rawName, ...args] = parts;
    const name = String(rawName).toUpperCase();
    if (name === 'SET') {
      const [key, value] = args;
      if (args.includes('NX') && strings.has(key)) return null;
      strings.set(key, String(value));
      return 'OK';
    }
    if (name === 'GET') return strings.get(args[0]) ?? null;
    if (name === 'DEL') {
      let deleted = 0;
      for (const key of args) {
        deleted += strings.delete(key) ? 1 : 0;
        deleted += sorted.delete(key) ? 1 : 0;
        deleted += lists.delete(key) ? 1 : 0;
      }
      return deleted;
    }
    if (name === 'ZADD') {
      const [key, score, member] = args;
      const values = sorted.get(key) || new Map();
      values.set(String(member), Number(score));
      sorted.set(key, values);
      return 1;
    }
    if (name === 'ZREVRANGE') return range(sorted.get(args[0]) || new Map(), args[1], args[2], true);
    if (name === 'MGET') return args.map((key) => strings.get(key) ?? null);
    if (name === 'LPUSH') {
      const [key, ...members] = args;
      const values = lists.get(key) || [];
      members.forEach((member) => values.unshift(String(member)));
      lists.set(key, values);
      return values.length;
    }
    if (name === 'LTRIM') {
      const [key, start, stop] = args;
      lists.set(key, listRange(lists.get(key) || [], start, stop));
      return 'OK';
    }
    if (name === 'LRANGE') return listRange(lists.get(args[0]) || [], args[1], args[2]);
    throw new Error(`Unsupported Redis command: ${name}`);
  }

  return {
    strings,
    sorted,
    fetchImpl: async (url, options) => {
      const input = JSON.parse(options.body);
      const body = url.endsWith('/multi-exec')
        ? input.map((parts) => ({ result: command(parts) }))
        : { result: command(input) };
      return { ok: true, json: async () => body };
    }
  };
}

function completePost(overrides = {}) {
  return {
    title: 'Cách đọc review sản phẩm trước khi mua hàng',
    h1: 'Cách đọc review sản phẩm trước khi mua hàng',
    slug: 'cach-doc-review-san-pham',
    deck: 'Hướng dẫn thực tế giúp người mua đánh giá review dễ dàng hơn.',
    category: 'doc-review',
    categoryLabel: 'Đọc review',
    authors: [{ name: 'RealView', email: 'editor@realview.com.vn' }],
    heroImage: { url: '/assets/blog/review.webp', alt: 'Người mua đang đọc review', width: 1200, height: 630 },
    seo: {
      title: 'Cách đọc review sản phẩm chính xác trước khi mua hàng',
      metaDescription: 'Hướng dẫn cách đọc review sản phẩm, nhận biết phản hồi có ích và hạn chế review thiếu thông tin trước khi quyết định mua hàng trực tuyến.',
      canonicalUrl: '/bai-viet/cach-doc-review-san-pham',
      primaryKeyword: 'cách đọc review sản phẩm',
      ogImageUrl: '/assets/blog/review.webp'
    },
    blocks: [
      { id: 'mo-dau', type: 'heading', text: 'Vì sao cần đọc review?', anchor: 'vi-sao-can-doc-review', includeInToc: true },
      { id: 'noi-dung', type: 'paragraph', text: 'Review giúp người mua biết trải nghiệm thực tế.' },
      { id: 'luu-y', type: 'subheading', text: 'Dấu hiệu cần lưu ý', anchor: 'dau-hieu-can-luu-y', includeInToc: true },
      { id: 'faq', type: 'faq', items: [{ question: 'Nên đọc bao nhiêu review?', answer: 'Nên đọc nhiều mức sao và ưu tiên nội dung cụ thể.' }] },
      { id: 'cta', type: 'cta', title: 'Kiểm tra bằng RealView', label: 'Dùng RealView', url: '/' },
      { id: 'nguon', type: 'sources', items: [{ label: 'RealView', href: '/bai-viet' }] }
    ],
    relatedPostIds: ['kiem-tra-do-tin-cay-review-truoc-khi-mua-hang'],
    settings: { includeFaqSchema: true, allowIndexing: true },
    ...overrides
  };
}

test('migration và renderer giữ nguyên format ảnh riêng của bài blog hiện có', async () => {
  const sourcePath = new URL('../public/blog/review-san-pham-co-dang-tin-khong.html', import.meta.url);
  const sourceHtml = await readFile(sourcePath, 'utf8');
  const migrated = migrateStaticBlogHtml(sourceHtml, { sourcePath: 'public/blog/review-san-pham-co-dang-tin-khong.html' });
  assert.deepEqual(migrated.post.heroImage.variants, ['article-lead-image--seo07']);
  assert.deepEqual(
    migrated.post.blocks.find((block) => block.url === '/assets/blog/seo08-27-image5.jpg').variants,
    ['article-figure--seo07']
  );
  assert.deepEqual(
    migrated.post.blocks.find((block) => block.url === '/assets/blog/seo08-53-image1.jpg').variants,
    ['article-figure--seo08-source-crop']
  );
  assert.equal(migrated.post.readingMinutes, 9);

  const lossy = normalizeBlogPost(migrated.post);
  lossy.heroImage.variants = [];
  lossy.readingMinutes = 0;
  lossy.blocks.forEach((block) => {
    if (block.type === 'image') {
      block.variants = [];
      block.captionPlacement = 'inside';
    }
  });
  const restored = restoreStaticBlogPresentation({
    post: lossy,
    meta: migrated.meta
  }, sourceHtml, { sourcePath: 'public/blog/review-san-pham-co-dang-tin-khong.html' });
  const output = renderBlogPost(restored);
  assert.match(output, /class="article-lead-image article-lead-image--seo07"/);
  assert.match(output, /class="article-figure article-figure--seo07"[^>]*><img[^>]*seo08-27-image5\.jpg/);
  assert.match(output, /class="article-figure article-figure--seo08-source-crop"[^>]*><img[^>]*seo08-53-image1\.jpg/);
  assert.match(output, /<\/figure><p class="article-caption">Hình 3:/);
  assert.match(output, />9 phút đọc</);
  assert.doesNotMatch(output, /<p class="article-deck"><\/p>/);
  assert.equal(blogPostHandlerInternals.isUnchangedLegacyImport({
    post: migrated.post,
    meta: migrated.meta
  }, sourceHtml, migrated.post.slug), true);
  assert.equal(blogPostHandlerInternals.isUnchangedLegacyImport({
    post: migrated.post,
    meta: { ...migrated.meta, updatedAt: '2026-09-17T10:00:00.000Z' }
  }, sourceHtml, migrated.post.slug), false);
});

function htmlResponseMock() {
  const headers = new Map();
  return {
    statusCode: 200,
    body: '',
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    end(value = '') { this.body += value || ''; },
    headers
  };
}

test('phân quyền blog dựa trên allowlist tài khoản, không nâng quyền client-side', () => {
  const env = {
    BLOG_ADMIN_EMAILS: 'admin@realview.com.vn',
    BLOG_EDITOR_EMAILS: 'editor@realview.com.vn',
    BLOG_ADMIN_USER_IDS: '',
    BLOG_EDITOR_USER_IDS: ''
  };
  assert.equal(resolveBlogRole({ id: '1', email: 'ADMIN@realview.com.vn' }, env), 'admin');
  assert.equal(resolveBlogRole({ id: '2', email: 'editor@realview.com.vn' }, env), 'editor');
  assert.equal(resolveBlogRole({ id: '3', email: 'buyer@example.com', role: 'admin' }, env), null);
  assert.equal(hasBlogRole('admin', 'editor'), true);
  assert.equal(hasBlogRole('editor', 'admin'), false);
});

test('chuẩn hóa block có cấu trúc, tạo schema FAQ và escape nội dung khi preview', () => {
  const post = normalizeBlogPost(completePost({
    blocks: [
      ...completePost().blocks,
      { id: 'xss', type: 'paragraph', text: '<script>alert(1)</script>' }
    ]
  }));
  const validation = validateBlogPost(post, { forPublish: true });
  const preview = renderBlogPreview(post);
  assert.equal(validation.valid, true);
  assert.equal(post.blocks.find((block) => block.type === 'subheading').level, 3);
  assert.equal(post.seo.canonicalUrl, '/bai-viet/cach-doc-review-san-pham');
  assert.equal(preview.schemas.faq['@type'], 'FAQPage');
  assert.match(preview.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(preview.html, /<script>alert/);
  const invalidCanonical = normalizeBlogPost(completePost({
    seo: { ...completePost().seo, canonicalUrl: 'http://www.realview.com.vn/bai-viet/cach-doc-review-san-pham?ref=tracking' }
  }));
  assert.equal(validateBlogPost(invalidCanonical, { forPublish: true }).errors.some((item) => item.code === 'CANONICAL_MISMATCH'), true);
});

test('CMS giữ revision bất biến, chặn ghi đè cũ và ghi audit khi publish', async () => {
  const previousUrl = process.env.UPSTASH_REDIS_REST_URL;
  const previousToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const mock = redisMock();
  const actor = { role: 'admin', account: { id: 'admin-1', username: 'Admin', email: 'admin@realview.com.vn' } };
  const options = {
    redisFetchImpl: mock.fetchImpl,
    randomUUIDImpl: () => 'post-1',
    now: () => new Date('2026-09-16T08:00:00.000Z')
  };

  try {
    const created = await createBlogPost(completePost(), actor, options);
    assert.equal(created.meta.id, 'post-1');
    assert.equal(created.revision, 1);
    assert.equal(created.meta.status, 'draft');

    const updated = await updateBlogPost('post-1', completePost({ title: 'Tiêu đề đã chỉnh sửa' }), 1, actor, {
      ...options,
      now: () => new Date('2026-09-16T08:05:00.000Z')
    });
    assert.equal(updated.revision, 2);
    assert.equal((await getBlogPost('post-1', { ...options, revision: 1 })).post.title, completePost().title);
    assert.equal((await getBlogPost('post-1', options)).post.title, 'Tiêu đề đã chỉnh sửa');

    await assert.rejects(
      updateBlogPost('post-1', completePost(), 1, actor, options),
      (error) => error.code === 'BLOG_REVISION_CONFLICT' && error.details.currentRevision === 2
    );

    const published = await publishBlogPost('post-1', 2, actor, {
      ...options,
      now: () => new Date('2026-09-16T08:10:00.000Z')
    });
    assert.equal(published.meta.status, 'published');
    assert.equal(published.meta.publishedRevision, 2);
    assert.equal((await listBlogPosts({ ...options, status: 'published' })).length, 1);
    assert.deepEqual((await listBlogRevisions('post-1', options)).map((item) => item.revision), [2, 1]);
    assert.deepEqual((await listBlogAudit('post-1', options)).map((item) => item.action), ['published', 'saved', 'created']);
  } finally {
    if (previousUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = previousUrl;
    if (previousToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = previousToken;
  }
});

test('upload ảnh từ chối MIME không an toàn trước khi chạm kho Blob', () => {
  assert.throws(
    () => decodeBlogMedia({ contentType: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') }),
    (error) => error.code === 'BLOG_MEDIA_TYPE_UNSUPPORTED'
  );
});

test('public renderer giữ H3, bài liên quan, canonical mới và không chèn HTML thô', () => {
  const post = normalizeBlogPost(completePost({
    seo: {
      ...completePost().seo,
      canonicalPath: '/bai-viet/duong-dan-cu',
      canonicalUrl: '/bai-viet/cach-doc-review-san-pham',
      ogImage: { url: '/assets/blog/old.webp' },
      ogImageUrl: '/assets/blog/review.webp'
    }
  }));
  const html = renderBlogPost({
    post,
    meta: { status: 'published', publishedAt: '2026-09-16T08:00:00.000Z', updatedAt: '2026-09-16T08:00:00.000Z' }
  });
  assert.equal(post.seo.canonicalPath, '/bai-viet/cach-doc-review-san-pham');
  assert.equal(post.seo.ogImage.url, '/assets/blog/review.webp');
  assert.match(html, /<h3[^>]*>Dấu hiệu cần lưu ý<\/h3>/);
  assert.match(html, /\/bai-viet\/kiem-tra-do-tin-cay-review-truoc-khi-mua-hang/);
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.realview\.com\.vn\/bai-viet\/cach-doc-review-san-pham"/);
});

test('đổi slug tạo redirect 308 logic và khôi phục revision luôn sinh revision mới', async () => {
  const previousUrl = process.env.UPSTASH_REDIS_REST_URL;
  const previousToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const mock = redisMock();
  const actor = { role: 'admin', account: { id: 'admin-1', username: 'Admin', email: 'admin@realview.com.vn' } };
  const baseOptions = { redisFetchImpl: mock.fetchImpl, randomUUIDImpl: () => 'post-route-1' };
  try {
    const created = await createBlogPost(completePost(), actor, { ...baseOptions, now: () => new Date('2026-09-16T08:00:00.000Z') });
    await publishBlogPost(created.meta.id, 1, actor, { ...baseOptions, now: () => new Date('2026-09-16T08:01:00.000Z') });
    const updatedInput = completePost({
      title: 'Cách đọc review sản phẩm phiên bản mới',
      h1: 'Cách đọc review sản phẩm phiên bản mới',
      slug: 'cach-doc-review-san-pham-moi',
      seo: { ...completePost().seo, canonicalUrl: '/bai-viet/cach-doc-review-san-pham-moi' }
    });
    await updateBlogPost(created.meta.id, updatedInput, 1, actor, { ...baseOptions, now: () => new Date('2026-09-16T08:02:00.000Z') });
    await publishBlogPost(created.meta.id, 2, actor, { ...baseOptions, now: () => new Date('2026-09-16T08:03:00.000Z') });
    assert.deepEqual(await resolvePublishedBlogRoute('cach-doc-review-san-pham', baseOptions), {
      kind: 'redirect', slug: 'cach-doc-review-san-pham-moi'
    });
    assert.equal((await resolvePublishedBlogRoute('cach-doc-review-san-pham-moi', baseOptions)).post.title, updatedInput.title);

    const restored = await restoreBlogRevision(created.meta.id, 1, 2, actor, { ...baseOptions, now: () => new Date('2026-09-16T08:04:00.000Z') });
    assert.equal(restored.revision, 3);
    assert.equal(restored.post.title, completePost().title);
    assert.equal(restored.meta.hasUnpublishedChanges, true);
    assert.deepEqual((await listBlogAudit(created.meta.id, baseOptions)).map((item) => item.action).slice(0, 2), ['restored', 'published']);
  } finally {
    if (previousUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = previousUrl;
    if (previousToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = previousToken;
  }
});

test('sitemap hợp nhất URL tĩnh và CMS mà không tạo URL trùng', () => {
  const record = {
    post: normalizeBlogPost(completePost()),
    meta: { status: 'published', publishedAt: '2026-09-16T08:00:00.000Z', updatedAt: '2026-09-16T08:00:00.000Z' }
  };
  const xml = renderSitemap([record], [
    { path: '/', lastmod: '2026-09-16' },
    { path: '/bai-viet/cach-doc-review-san-pham', lastmod: '2026-09-15' }
  ]);
  assert.equal((xml.match(/<loc>https:\/\/www\.realview\.com\.vn\/bai-viet\/cach-doc-review-san-pham<\/loc>/g) || []).length, 1);
  assert.match(xml, /cach-doc-review-san-pham<\/loc><lastmod>2026-09-16<\/lastmod>/);
  assert.doesNotMatch(xml, /image:caption/);
});

test('danh sách public phân trang qua toàn bộ index thay vì dừng ở 100 record mới nhất', async () => {
  const previousUrl = process.env.UPSTASH_REDIS_REST_URL;
  const previousToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const mock = redisMock();
  const index = new Map();
  for (let indexNumber = 0; indexNumber < 320; indexNumber += 1) {
    const id = `post-page-${indexNumber}`;
    const status = indexNumber >= 220 ? 'draft' : 'published';
    index.set(id, indexNumber);
    mock.strings.set(blogCmsInternals.metaKey(id), JSON.stringify({ id, status }));
  }
  mock.sorted.set(blogCmsInternals.INDEX_KEY, index);
  try {
    const firstPage = await listBlogPosts({ status: 'published', limit: 50, redisFetchImpl: mock.fetchImpl });
    const allPublished = await listBlogPosts({ status: 'published', all: true, redisFetchImpl: mock.fetchImpl });
    assert.equal(firstPage.length, 50);
    assert.equal(allPublished.length, 220);
  } finally {
    if (previousUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = previousUrl;
    if (previousToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = previousToken;
  }
});

test('hub server-rendered đưa bài public và CollectionPage schema vào HTML ban đầu', () => {
  const template = '<html><head><!-- BLOG_COLLECTION_SCHEMA_START --><script type="application/ld+json">{}</script><!-- BLOG_COLLECTION_SCHEMA_END --></head><body><!-- BLOG_FEATURED_START --><!-- BLOG_FEATURED_END --><div class="post-grid"><!-- BLOG_GRID_START --><!-- BLOG_GRID_END --></div></body></html>';
  const record = {
    post: normalizeBlogPost(completePost({ featured: true })),
    meta: { status: 'published', publishedAt: '2026-09-16T08:00:00.000Z', updatedAt: '2026-09-16T08:00:00.000Z' }
  };
  const html = renderBlogIndexTemplate(template, [record]);
  assert.match(html, /data-blog-card/);
  assert.match(html, /Cách đọc review sản phẩm trước khi mua hàng/);
  assert.match(html, /"@type":"CollectionPage"/);
  assert.match(html, /"numberOfItems":1/);
});

test('summary public không làm lộ email tác giả nhưng vẫn giữ URL hồ sơ', () => {
  const summary = publicBlogSummary({
    ...completePost(),
    status: 'published',
    publishedAt: '2026-09-16T08:00:00.000Z',
    updatedAt: '2026-09-16T08:00:00.000Z',
    authors: [{ name: 'RealView', email: 'private@realview.com.vn', url: '/tac-gia/realview' }]
  });
  assert.deepEqual(summary.authors, [{ name: 'RealView', url: '/tac-gia/realview' }]);
});

test('publish từ chối bài liên quan chưa xuất bản hoặc không tồn tại', async () => {
  const previousUrl = process.env.UPSTASH_REDIS_REST_URL;
  const previousToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const mock = redisMock();
  const actor = { role: 'admin', account: { id: 'admin-1', email: 'admin@realview.com.vn' } };
  const options = { redisFetchImpl: mock.fetchImpl, randomUUIDImpl: () => 'post-invalid-related' };
  try {
    const created = await createBlogPost(completePost({ relatedPostIds: ['bai-chua-xuat-ban'], relatedSlugs: ['bai-chua-xuat-ban'] }), actor, options);
    await assert.rejects(
      publishBlogPost(created.meta.id, created.revision, actor, options),
      (error) => error.code === 'BLOG_RELATED_POST_NOT_PUBLISHED' && error.details.slugs.includes('bai-chua-xuat-ban')
    );
  } finally {
    if (previousUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = previousUrl;
    if (previousToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = previousToken;
  }
});

test('route bài legacy luôn fallback về HTML tĩnh khi CMS chưa cấu hình', async () => {
  const previousUrl = process.env.UPSTASH_REDIS_REST_URL;
  const previousToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  try {
    const response = htmlResponseMock();
    await blogPostHandler({ method: 'GET', query: { slug: 'trustscore-la-gi' } }, response);
    assert.equal(response.statusCode, 200);
    assert.match(response.getHeader('content-type'), /text\/html/);
    assert.match(response.body, /TrustScore là gì/i);

    const headResponse = htmlResponseMock();
    await blogPostHandler({ method: 'HEAD', query: { slug: 'trustscore-la-gi' } }, headResponse);
    assert.equal(headResponse.statusCode, 200);
    assert.equal(headResponse.body, '');
  } finally {
    if (previousUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = previousUrl;
    if (previousToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = previousToken;
  }
});

test('migration nội bộ có thể nhận slug legacy nhưng thao tác admin thông thường vẫn bị chặn', async () => {
  const previousUrl = process.env.UPSTASH_REDIS_REST_URL;
  const previousToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const mock = redisMock();
  const actor = { role: 'admin', account: { id: 'migration', username: 'Migration', email: 'system@realview.com.vn' } };
  const legacyPost = completePost({
    slug: 'trustscore-la-gi',
    seo: { ...completePost().seo, canonicalUrl: '/bai-viet/trustscore-la-gi' }
  });
  try {
    await assert.rejects(
      createBlogPost(legacyPost, actor, { redisFetchImpl: mock.fetchImpl, randomUUIDImpl: () => 'blocked-legacy' }),
      (error) => error.code === 'BLOG_SLUG_RESERVED'
    );
    const created = await createBlogPost(legacyPost, actor, {
      redisFetchImpl: mock.fetchImpl,
      randomUUIDImpl: () => 'imported-legacy',
      allowLegacySlug: true
    });
    const found = await getBlogPostBySlug('trustscore-la-gi', { redisFetchImpl: mock.fetchImpl });
    assert.equal(found.meta.id, created.meta.id);
    await publishBlogPost(created.meta.id, created.revision, actor, {
      redisFetchImpl: mock.fetchImpl,
      publishedAt: '2026-09-11T00:00:00.000Z'
    });
    await unpublishBlogPost(created.meta.id, created.revision, actor, { redisFetchImpl: mock.fetchImpl });
    await assert.rejects(
      resolvePublishedBlogRoute('trustscore-la-gi', { redisFetchImpl: mock.fetchImpl }),
      (error) => error.code === 'BLOG_POST_NOT_PUBLISHED' && error.statusCode === 404
    );
  } finally {
    if (previousUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = previousUrl;
    if (previousToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = previousToken;
  }
});

test('lưu nháp sau khi xuất bản không làm lộ metadata, slug hoặc canonical mới ra public', async () => {
  const previousUrl = process.env.UPSTASH_REDIS_REST_URL;
  const previousToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const mock = redisMock();
  const actor = { role: 'admin', account: { id: 'admin-1', username: 'Admin', email: 'admin@realview.com.vn' } };
  const options = { redisFetchImpl: mock.fetchImpl, randomUUIDImpl: () => 'post-public-snapshot' };
  try {
    const original = completePost();
    const created = await createBlogPost(original, actor, {
      ...options,
      now: () => new Date('2026-09-16T08:00:00.000Z')
    });
    await publishBlogPost(created.meta.id, 1, actor, {
      ...options,
      now: () => new Date('2026-09-16T08:01:00.000Z')
    });
    const draft = completePost({
      title: 'Tiêu đề nháp chưa xuất bản',
      h1: 'Tiêu đề nháp chưa xuất bản',
      slug: 'duong-dan-nhap-chua-xuat-ban',
      heroImage: { ...original.heroImage, url: '/assets/blog/draft-only.webp' },
      seo: {
        ...original.seo,
        title: 'SEO nháp chưa xuất bản',
        canonicalUrl: '/bai-viet/duong-dan-nhap-chua-xuat-ban'
      }
    });
    const saved = await updateBlogPost(created.meta.id, draft, 1, actor, {
      ...options,
      now: () => new Date('2026-09-16T08:02:00.000Z')
    });
    const summaryBeforePublish = publicBlogSummary(saved.meta);
    assert.equal(summaryBeforePublish.slug, original.slug);
    assert.equal(summaryBeforePublish.title, original.title);
    assert.equal(summaryBeforePublish.heroImage.url, original.heroImage.url);
    assert.equal(summaryBeforePublish.seo.canonicalPath, `/bai-viet/${original.slug}`);
    assert.equal(summaryBeforePublish.updatedAt, '2026-09-16T08:01:00.000Z');

    const sitemapBeforePublish = renderSitemap([summaryToBlogRecord(summaryBeforePublish)], []);
    assert.match(sitemapBeforePublish, new RegExp(`/bai-viet/${original.slug}`));
    assert.doesNotMatch(sitemapBeforePublish, /duong-dan-nhap-chua-xuat-ban/);
    const publishedRoute = await resolvePublishedBlogRoute(original.slug, options);
    assert.equal(publishedRoute.post.title, original.title);
    assert.equal(publishedRoute.meta.updatedAt, '2026-09-16T08:01:00.000Z');
    assert.equal((await getPublishedBlogPostBySlug(original.slug, options)).meta.publishedUpdatedAt, '2026-09-16T08:01:00.000Z');
    const publicHtml = renderBlogPost(publishedRoute);
    assert.match(publicHtml, /article:modified_time" content="2026-09-16T08:01:00.000Z/);
    assert.doesNotMatch(publicHtml, /article:modified_time" content="2026-09-16T08:02:00.000Z/);
    await assert.rejects(
      resolvePublishedBlogRoute(draft.slug, options),
      (error) => error.code === 'BLOG_POST_NOT_PUBLISHED'
    );

    const republished = await publishBlogPost(created.meta.id, 2, actor, {
      ...options,
      now: () => new Date('2026-09-16T08:03:00.000Z')
    });
    const summaryAfterPublish = publicBlogSummary(republished.meta);
    assert.equal(summaryAfterPublish.slug, draft.slug);
    assert.equal(summaryAfterPublish.title, draft.title);
    assert.equal(summaryAfterPublish.heroImage.url, draft.heroImage.url);
    assert.equal(summaryAfterPublish.seo.canonicalPath, `/bai-viet/${draft.slug}`);
  } finally {
    if (previousUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = previousUrl;
    if (previousToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = previousToken;
  }
});

test('slug legacy và toàn bộ redirect lịch sử không sống lại sau khi gỡ xuất bản', async () => {
  const previousUrl = process.env.UPSTASH_REDIS_REST_URL;
  const previousToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const mock = redisMock();
  const actor = { role: 'admin', account: { id: 'admin-1', username: 'Admin', email: 'admin@realview.com.vn' } };
  const options = { redisFetchImpl: mock.fetchImpl, randomUUIDImpl: () => 'post-legacy-redirects' };
  const legacy = completePost({
    slug: 'trustscore-la-gi',
    seo: { ...completePost().seo, canonicalUrl: '/bai-viet/trustscore-la-gi' }
  });
  try {
    const created = await createBlogPost(legacy, actor, { ...options, allowLegacySlug: true });
    await publishBlogPost(created.meta.id, 1, actor, options);

    const second = completePost({
      title: 'TrustScore phiên bản hai',
      h1: 'TrustScore phiên bản hai',
      slug: 'trustscore-phien-ban-hai',
      seo: { ...completePost().seo, canonicalUrl: '/bai-viet/trustscore-phien-ban-hai' }
    });
    await updateBlogPost(created.meta.id, second, 1, actor, options);
    await publishBlogPost(created.meta.id, 2, actor, options);

    const third = completePost({
      title: 'TrustScore phiên bản ba',
      h1: 'TrustScore phiên bản ba',
      slug: 'trustscore-phien-ban-ba',
      seo: { ...completePost().seo, canonicalUrl: '/bai-viet/trustscore-phien-ban-ba' }
    });
    await updateBlogPost(created.meta.id, third, 2, actor, options);
    await publishBlogPost(created.meta.id, 3, actor, options);

    assert.deepEqual(await resolvePublishedBlogRoute(legacy.slug, options), {
      kind: 'redirect', slug: third.slug
    });
    assert.deepEqual(await resolvePublishedBlogRoute(second.slug, options), {
      kind: 'redirect', slug: third.slug
    });

    await unpublishBlogPost(created.meta.id, 3, actor, options);
    for (const slug of [legacy.slug, second.slug, third.slug]) {
      await assert.rejects(
        resolvePublishedBlogRoute(slug, options),
        (error) => error.code === 'BLOG_POST_NOT_PUBLISHED' && error.statusCode === 404
      );
    }
  } finally {
    if (previousUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = previousUrl;
    if (previousToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = previousToken;
  }
});
