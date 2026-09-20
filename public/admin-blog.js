import { getCurrentUser, openAuthDialog } from '/auth.js';

const API_URL = '/api/admin-blog';
const STATUS_LABELS = {
  draft: 'Bản nháp', published: 'Đã xuất bản', archived: 'Lưu trữ'
};
const CATEGORY_LABELS = {
  'doc-review': 'Đọc review', 'nen-tang': 'Nền tảng mua sắm', realview: 'RealView',
  'huong-dan': 'Hướng dẫn', 'so-sanh': 'So sánh'
};
const BLOCK_LABELS = {
  paragraph: 'Đoạn văn', heading: 'Tiêu đề H2', subheading: 'Tiêu đề H3', list: 'Danh sách',
  checklist: 'Checklist', image: 'Hình ảnh', callout: 'Ghi chú', quote: 'Trích dẫn', table: 'Bảng',
  formula: 'Công thức', faq: 'FAQ', relatedPosts: 'Bài liên quan', sources: 'Nguồn tham khảo', cta: 'CTA', divider: 'Đường phân cách'
};

const state = {
  posts: [], currentPost: null, filter: 'all', query: '', dirty: false, saving: false,
  autosaveTimer: null, conflict: null, user: null, authorized: false, role: null
};

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const uid = () => globalThis.crypto?.randomUUID?.() || `b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

class ApiError extends Error {
  constructor(message, status, payload = {}) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

async function apiGet(action, params = {}) {
  const url = new URL(API_URL, window.location.origin);
  url.searchParams.set('action', action);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  });
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(payload.error || payload.message || 'Không thể tải dữ liệu.', response.status, payload);
  return payload;
}

async function apiPost(body) {
  const response = await fetch(API_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    credentials: 'same-origin', body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(payload.error || payload.message || 'Không thể xử lý yêu cầu.', response.status, payload);
  return payload;
}

function emptyPost() {
  return {
    id: null, revision: 0, publishedRevision: null, hasUnpublishedChanges: false, status: 'draft', slug: '', title: '', h1: '', deck: '',
    category: 'doc-review', categoryLabel: 'Đọc review', tags: [], authors: [{ name: 'Nhóm RealView', email: '' }],
    featured: false, publishedAt: '', modifiedAt: '',
    seo: { title: '', metaDescription: '', canonicalUrl: '', primaryKeyword: '', searchIntent: 'informational', robots: 'index,follow,max-image-preview:large', ogTitle: '', ogDescription: '', ogImageUrl: '' },
    heroImage: { url: '', alt: '', caption: '' },
    blocks: [createBlock('paragraph')], relatedSlugs: [],
    toc: { mode: 'auto', title: 'Mục lục', entries: [] },
    settings: { includeFaqSchema: true, allowIndexing: true }
  };
}

function createBlock(type) {
  const base = { id: uid(), type };
  const values = {
    paragraph: { text: '', textStyle: 'body' },
    heading: { text: '', anchor: '', includeInToc: true },
    subheading: { text: '', anchor: '', includeInToc: false },
    list: { style: 'unordered', items: ['', ''] },
    checklist: { items: [{ text: '', checked: false }] },
    image: { url: '', alt: '', caption: '', display: 'wide' },
    callout: { tone: 'info', title: '', text: '' },
    quote: { text: '', cite: '' },
    formula: { text: '', ariaLabel: '' },
    table: { caption: '', headers: ['Tiêu chí', 'Thông tin'], rows: [['', '']] },
    faq: { description: '', items: [{ question: '', answer: '' }] },
    sources: { items: [{ label: '', href: '' }] },
    relatedPosts: { slugs: [] },
    divider: {},
    cta: { eyebrow: 'THỬ VỚI SẢN PHẨM BẠN QUAN TÂM', title: 'Đọc review rõ hơn cùng RealView', text: '', label: 'Phân tích sản phẩm', url: '/#trang-chu' }
  };
  return { ...base, ...(values[type] || values.paragraph) };
}

function foldLegacyFaqBlocks(inputBlocks) {
  const output = [];
  for (let index = 0; index < inputBlocks.length; index += 1) {
    const block = inputBlocks[index];
    const faqHeading = ['heading', 'subheading'].includes(block.type)
      && ['faq', 'cau-hoi-thuong-gap', 'faq-cau-hoi-thuong-gap'].includes(slugify(block.text));
    if (faqHeading) {
      let faqIndex = index + 1;
      while (inputBlocks[faqIndex]?.type === 'paragraph') faqIndex += 1;
      const faq = inputBlocks[faqIndex];
      if (faq?.type === 'faq') {
        const descriptions = [
          ...inputBlocks.slice(index + 1, faqIndex).map((item) => item.text),
          faq.description
        ].filter(Boolean);
        output.push({ ...faq, description: [...new Set(descriptions)].join('\n\n') });
        index = faqIndex;
        continue;
      }
    }
    output.push(block);
  }
  return output;
}

function normalizePost(raw = {}) {
  const source = raw.post || raw;
  const author = source.authors?.[0] || source.author || {};
  const seo = source.seo || {};
  const normalizedBlocks = Array.isArray(source.blocks) && source.blocks.length
    ? source.blocks.map((value) => {
        const block = { ...value, id: value.id || uid() };
        if (block.type === 'heading' && Number(block.level) === 3) block.type = 'subheading';
        if (block.type === 'cta') block.url = block.url || block.href || '';
        if (block.type === 'image') {
          block.responsiveSources = Array.isArray(block.responsiveSources) ? block.responsiveSources : [];
          block.galleryImages = Array.isArray(block.galleryImages) ? block.galleryImages : [];
          block.variants = Array.isArray(block.variants) ? block.variants : [];
        }
        return block;
      })
    : [createBlock('paragraph')];
  const blocks = foldLegacyFaqBlocks(normalizedBlocks);
  return {
    ...emptyPost(), ...source,
    id: source.id || source.postId || null,
    revision: Number(source.revision || source.version || 0),
    seo: {
      ...emptyPost().seo,
      ...seo,
      canonicalUrl: seo.canonicalUrl || seo.canonicalPath || '',
      ogImageUrl: seo.ogImageUrl || seo.ogImage?.url || ''
    },
    heroImage: { ...emptyPost().heroImage, ...(source.heroImage || source.image || {}) },
    authors: source.authors?.length ? source.authors : [{ name: author.name || 'Nhóm RealView', email: author.email || '', url: author.url || '' }],
    tags: Array.isArray(source.tags) ? source.tags : String(source.tags || '').split(',').map((item) => item.trim()).filter(Boolean),
    blocks,
    toc: {
      ...emptyPost().toc,
      ...(source.toc || {}),
      mode: source.toc?.mode === 'manual' ? 'manual' : 'auto',
      entries: Array.isArray(source.toc?.entries) ? source.toc.entries.map((entry) => ({
        anchor: slugify(entry.anchor || entry.id),
        label: String(entry.label || entry.text || '').trim(),
        level: Number(entry.level) === 3 ? 3 : 2
      })).filter((entry) => entry.anchor && entry.label) : []
    },
    relatedSlugs: [...new Set([
      ...(source.relatedSlugs || source.relatedPostIds || []),
      ...blocks.filter((block) => block.type === 'relatedPosts').flatMap((block) => block.slugs || [])
    ])],
    settings: { ...emptyPost().settings, ...(source.settings || {}) }
  };
}

function normalizeApiPost(payload = {}, fallback = {}) {
  if (!payload?.post) {
    const meta = payload.meta || {};
    return normalizePost({
      ...fallback, ...payload, ...meta,
      id: meta.id || payload.id || fallback.id,
      revision: meta.revision ?? payload.revision ?? fallback.revision,
      publishedRevision: meta.publishedRevision ?? payload.publishedRevision ?? fallback.publishedRevision,
      hasUnpublishedChanges: meta.hasUnpublishedChanges ?? payload.hasUnpublishedChanges ?? fallback.hasUnpublishedChanges,
      status: meta.status || payload.status || fallback.status,
      publishedAt: meta.publishedAt || payload.publishedAt || fallback.publishedAt,
      modifiedAt: meta.publishedUpdatedAt || meta.publishedSummary?.updatedAt || payload.modifiedAt || fallback.modifiedAt
    });
  }
  const meta = payload.meta || {};
  return normalizePost({
    ...payload.post,
    id: payload.id || meta.id || fallback.id,
    revision: payload.revision ?? meta.revision ?? fallback.revision,
    publishedRevision: meta.publishedRevision ?? payload.post.publishedRevision ?? fallback.publishedRevision,
    hasUnpublishedChanges: meta.hasUnpublishedChanges ?? payload.post.hasUnpublishedChanges ?? fallback.hasUnpublishedChanges,
    status: meta.status || fallback.status || payload.post.status,
    publishedAt: meta.publishedAt || payload.post.publishedAt || fallback.publishedAt,
    modifiedAt: meta.publishedUpdatedAt || meta.publishedSummary?.updatedAt || payload.post.modifiedAt || fallback.modifiedAt,
    updatedAt: meta.updatedAt || fallback.updatedAt,
    createdAt: meta.createdAt || fallback.createdAt
  });
}

function slugify(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
}

function toLocalInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 16);
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function fromLocalInput(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function formatDate(value) {
  if (!value) return 'Chưa cập nhật';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Chưa cập nhật';
  return new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function sameDateTime(left, right) {
  const leftTime = Date.parse(left || '');
  const rightTime = Date.parse(right || '');
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime;
}

function setAccess(title, message, { login = false } = {}) {
  const access = $('[data-access-state]');
  $('h1', access).textContent = title;
  $('[data-access-message]', access).textContent = message;
  $('[data-access-login]', access).hidden = !login;
  access.hidden = false;
  $$('[data-view]').forEach((view) => { view.hidden = true; });
}

function showView(name) {
  $('[data-access-state]').hidden = true;
  $$('[data-view]').forEach((view) => { view.hidden = view.dataset.view !== name; });
  $$('[data-view-link]').forEach((button) => {
    const active = name === button.dataset.viewLink || (name === 'editor' && button.dataset.viewLink === 'new' && !state.currentPost?.id);
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function toast(message, type = 'success') {
  const item = document.createElement('div');
  item.className = `admin-toast${type === 'error' ? ' is-error' : ''}`;
  const icon = document.createElement('span');
  icon.textContent = type === 'error' ? '!' : '✓';
  const text = document.createElement('div');
  text.textContent = message;
  item.append(icon, text);
  $('[data-toast-region]').append(item);
  window.setTimeout(() => item.remove(), 4200);
}

function setSaveState(label, kind = '') {
  const element = $('[data-save-state]');
  element.textContent = label;
  element.className = `admin-save-state${kind ? ` is-${kind}` : ''}`;
}

async function loadPosts() {
  $('[data-list-loading]').hidden = false;
  try {
    const payload = await apiGet('list', { limit: 200 });
    state.posts = (payload.posts || payload.items || payload.data || []).map(normalizePost);
    state.role = payload.role || state.role;
    state.authorized = true;
    renderPosts();
    renderStats();
    renderRelatedPicker();
    $('[data-total-badge]').textContent = String(state.posts.length);
    applyRolePermissions();
  } finally {
    $('[data-list-loading]').hidden = true;
  }
}

function renderStats() {
  ['all', 'published', 'draft', 'archived'].forEach((status) => {
    const count = status === 'all' ? state.posts.length : state.posts.filter((post) => post.status === status).length;
    $(`[data-stat="${status}"]`).textContent = String(count);
  });
}

function searchableText(post) {
  return [post.title, post.slug, post.categoryLabel, ...(post.authors || []).map((author) => author.name), ...(post.tags || [])].join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function renderPosts() {
  const tbody = $('[data-post-list]');
  tbody.replaceChildren();
  const query = state.query.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const filtered = state.posts.filter((post) => (state.filter === 'all' || post.status === state.filter) && (!query || searchableText(post).includes(query)));
  filtered.forEach((post) => {
    const row = $('#post-row-template').content.firstElementChild.cloneNode(true);
    row.dataset.postId = post.id;
    const thumb = $('.post-table-thumb', row);
    if (post.heroImage?.url) {
      const image = new Image();
      image.src = post.heroImage.url;
      image.alt = '';
      thumb.replaceChildren(image);
    }
    $('.post-table-title strong', row).textContent = post.title || 'Bài viết chưa đặt tên';
    $('.post-table-title small', row).textContent = `/bai-viet/${post.slug || 'chua-co-slug'}`;
    const status = $('.status-pill', row);
    status.textContent = STATUS_LABELS[post.status] || post.status || 'Bản nháp';
    status.className = `status-pill status-${post.status || 'draft'}`;
    const publishedAt = post.publishedAt || post.updatedAt || post.modifiedAt;
    const updatedAt = post.modifiedAt || post.publishedUpdatedAt || post.updatedAt;
    const time = $('time', row);
    time.dateTime = publishedAt || '';
    time.textContent = `Xuất bản ${formatDate(publishedAt)}`;
    const details = [];
    if (updatedAt && !sameDateTime(publishedAt, updatedAt)) details.push(`Cập nhật ${formatDate(updatedAt)}`);
    details.push(post.isStaticFallback ? 'Nguồn main · chưa nhập CMS' : `Revision ${post.revision || 0}`);
    $('.post-table-revision', row).textContent = details.join(' · ');
    $('.post-table-author', row).textContent = post.authors?.[0]?.name || 'Nhóm RealView';
    const viewLink = $('[data-view-row]', row);
    viewLink.href = post.status === 'published' && post.slug ? `/bai-viet/${post.slug}` : `/api/admin-blog?action=preview&id=${encodeURIComponent(post.id || '')}`;
    const canManagePosts = ['admin', 'editor'].includes(state.role);
    $('[data-unpublish-row]', row).hidden = post.isStaticFallback || !canManagePosts || post.status !== 'published';
    $('[data-archive-row]', row).hidden = post.isStaticFallback || !canManagePosts || post.status === 'archived';
    tbody.append(row);
  });
  $('[data-list-empty]').hidden = filtered.length > 0;
  $('.admin-post-table').hidden = filtered.length === 0;
}

function applyRolePermissions() {
  const isAdmin = state.role === 'admin';
  const canManagePosts = isAdmin || state.role === 'editor';
  $('[data-publish-post]').hidden = !canManagePosts;
  $('[data-unpublish-post]').hidden = !canManagePosts || state.currentPost?.status !== 'published';
  $('[data-access-management]').hidden = !isAdmin;
}

function switchEditorTab(name) {
  $$('[data-editor-tab]').forEach((button) => {
    const active = button.dataset.editorTab === name;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  $$('[data-editor-panel]').forEach((panel) => { panel.hidden = panel.dataset.editorPanel !== name; });
}

function setFormValue(name, value) {
  const input = $(`[name="${name}"]`, $('[data-editor-form]'));
  if (!input) return;
  if (input.type === 'checkbox') input.checked = Boolean(value);
  else input.value = value ?? '';
}

function openEditor(post = emptyPost()) {
  clearTimeout(state.autosaveTimer);
  state.currentPost = normalizePost(post);
  state.dirty = false;
  setFormValue('title', state.currentPost.title);
  setFormValue('deck', state.currentPost.deck);
  setFormValue('seoTitle', state.currentPost.seo.title);
  setFormValue('metaDescription', state.currentPost.seo.metaDescription);
  setFormValue('slug', state.currentPost.slug);
  setFormValue('primaryKeyword', state.currentPost.seo.primaryKeyword);
  setFormValue('searchIntent', state.currentPost.seo.searchIntent);
  setFormValue('canonicalUrl', state.currentPost.seo.canonicalUrl);
  setFormValue('ogTitle', state.currentPost.seo.ogTitle);
  setFormValue('ogDescription', state.currentPost.seo.ogDescription);
  setFormValue('heroImageUrl', state.currentPost.heroImage.url);
  setFormValue('heroImageAlt', state.currentPost.heroImage.alt);
  setFormValue('heroImageCaption', state.currentPost.heroImage.caption);
  setFormValue('ogImageUrl', state.currentPost.seo.ogImageUrl);
  setFormValue('category', state.currentPost.category);
  setFormValue('categoryLabel', state.currentPost.categoryLabel || CATEGORY_LABELS[state.currentPost.category]);
  setFormValue('tags', state.currentPost.tags.join(', '));
  setFormValue('publishedAt', toLocalInput(state.currentPost.publishedAt));
  setFormValue('modifiedAt', toLocalInput(state.currentPost.modifiedAt));
  setFormValue('featured', state.currentPost.featured);
  setFormValue('includeFaqSchema', state.currentPost.settings.includeFaqSchema);
  setFormValue('allowIndexing', state.currentPost.settings.allowIndexing);
  renderBlocks();
  renderHeroPreview();
  renderRelatedPicker();
  renderAuthors(state.currentPost.authors);
  renderTocEditor(state.currentPost.toc);
  updateEditorMeta();
  updateChecks();
  switchEditorTab('content');
  $('[data-editor-kicker]').textContent = state.currentPost.id ? 'CHỈNH SỬA BÀI VIẾT' : 'BÀI VIẾT MỚI';
  $('[data-editor-title]').textContent = state.currentPost.id ? 'Biên tập nội dung' : 'Soạn bài viết';
  $('[data-unpublish-post]').hidden = state.currentPost.status !== 'published';
  $('[data-discard-draft]').hidden = !state.currentPost.hasUnpublishedChanges;
  $('[data-publish-post]').textContent = state.currentPost.status === 'published' ? 'Cập nhật bài viết →' : 'Xuất bản →';
  applyRolePermissions();
  setSaveState('Chưa có thay đổi');
  showView('editor');
}

async function editPost(id) {
  showView('editor');
  setSaveState('Đang tải bài viết…', 'saving');
  try {
    const staticPrefix = 'static:';
    const isStaticFallback = String(id || '').startsWith(staticPrefix);
    const payload = isStaticFallback
      ? await apiPost({ action: 'import_legacy', slug: String(id).slice(staticPrefix.length) })
      : await apiGet('detail', { id });
    openEditor(normalizeApiPost(payload));
    if (isStaticFallback) await loadPosts();
  } catch (error) {
    toast(error.message, 'error');
    showView('posts');
  }
}

function blockShell(block) {
  const element = document.createElement('article');
  element._originalBlock = typeof structuredClone === 'function' ? structuredClone(block) : JSON.parse(JSON.stringify(block));
  element.className = 'admin-block';
  element.dataset.blockId = block.id;
  element.dataset.blockType = block.type;
  element.innerHTML = `
    <div class="admin-block-handle"><span aria-hidden="true">⠿</span><div class="admin-block-order"><button type="button" data-move-block="up" title="Di chuyển lên" aria-label="Di chuyển khối lên">↑</button><button type="button" data-move-block="down" title="Di chuyển xuống" aria-label="Di chuyển khối xuống">↓</button></div></div>
    <div class="admin-block-toolbar"><span class="admin-block-type"></span><div class="admin-block-actions"><button type="button" data-duplicate-block title="Nhân bản khối" aria-label="Nhân bản khối">⧉</button><button type="button" data-remove-block title="Xóa khối" aria-label="Xóa khối">×</button></div></div>
    <div class="admin-block-fields"></div>`;
  $('.admin-block-type', element).textContent = BLOCK_LABELS[block.type] || block.type;
  return element;
}

function addField(container, { tag = 'input', field, value = '', placeholder = '', className = '', type = 'text', rows = 3 } = {}) {
  const input = document.createElement(tag);
  input.dataset.blockField = field;
  input.className = className;
  if (tag === 'textarea') { input.rows = rows; input.value = value || ''; }
  else { input.type = type; input.value = value ?? ''; }
  if (placeholder) input.placeholder = placeholder;
  container.append(input);
  return input;
}

function addSelect(container, field, options, value) {
  const select = document.createElement('select');
  select.dataset.blockField = field;
  options.forEach(([optionValue, label]) => {
    const option = document.createElement('option'); option.value = optionValue; option.textContent = label; select.append(option);
  });
  select.value = value;
  container.append(select);
  return select;
}

function applyInlineFormat(textarea, format) {
  const start = Number.isFinite(textarea.selectionStart) ? textarea.selectionStart : textarea.value.length;
  const end = Number.isFinite(textarea.selectionEnd) ? textarea.selectionEnd : start;
  const selected = textarea.value.slice(start, end);
  const formats = {
    bold: { prefix: '**', suffix: '**', fallback: 'chữ đậm' },
    italic: { prefix: '*', suffix: '*', fallback: 'chữ nghiêng' },
    link: { prefix: '[', suffix: '](https://)', fallback: 'văn bản liên kết' }
  };
  const spec = formats[format];
  if (!spec) return;
  const content = selected || spec.fallback;
  const replacement = `${spec.prefix}${content}${spec.suffix}`;
  textarea.setRangeText(replacement, start, end, 'end');
  const selectionStart = start + spec.prefix.length;
  textarea.setSelectionRange(selectionStart, selectionStart + content.length);
  textarea.focus();
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function addInlineToolbar(container, textarea) {
  const toolbar = document.createElement('div');
  toolbar.className = 'admin-inline-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Định dạng nội dung');
  [
    ['bold', 'B', 'In đậm'],
    ['italic', 'I', 'In nghiêng'],
    ['link', '↗', 'Chèn liên kết']
  ].forEach(([format, label, title]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.inlineFormat = format;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.textContent = label;
    if (format === 'bold') button.classList.add('is-bold');
    if (format === 'italic') button.classList.add('is-italic');
    button.addEventListener('click', () => applyInlineFormat(textarea, format));
    toolbar.append(button);
  });
  const hint = document.createElement('span');
  hint.textContent = 'Preview và bài đã xuất bản dùng cùng định dạng';
  toolbar.append(hint);
  container.insertBefore(toolbar, textarea);
}

function addRichTextField(container, options = {}) {
  const textarea = addField(container, { tag: 'textarea', ...options });
  addInlineToolbar(container, textarea);
  return textarea;
}

function addTocOption(container, checked) {
  const label = document.createElement('label'); label.className = 'admin-block-option';
  const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.blockField = 'includeInToc'; input.checked = Boolean(checked);
  label.append(input, document.createTextNode(' Hiển thị trong mục lục'));
  container.append(label);
}

function renderFaqItems(container, items = []) {
  const list = document.createElement('div'); list.className = 'admin-block-fields'; list.dataset.faqItems = '';
  (items.length ? items : [{ question: '', answer: '' }]).forEach((item) => {
    const row = document.createElement('div'); row.className = 'admin-block-fields'; row.dataset.faqItem = '';
    addField(row, { field: 'question', value: item.question, placeholder: 'Câu hỏi thường gặp' });
    addField(row, { tag: 'textarea', field: 'answer', value: item.answer, placeholder: 'Câu trả lời rõ ràng, ngắn gọn', rows: 3 });
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'admin-text-button'; remove.dataset.removeFaq = ''; remove.textContent = 'Xóa câu hỏi';
    row.append(remove); list.append(row);
  });
  const add = document.createElement('button'); add.type = 'button'; add.className = 'admin-secondary-button'; add.dataset.addFaq = ''; add.textContent = '＋ Thêm câu hỏi';
  container.append(list, add);
}

function renderSourceItems(container, items = []) {
  const list = document.createElement('div'); list.className = 'admin-block-fields'; list.dataset.sourceItems = '';
  (items.length ? items : [{ label: '', href: '' }]).forEach((item) => {
    const row = document.createElement('div'); row.className = 'admin-block-fields admin-block-fields--split'; row.dataset.sourceItem = '';
    addField(row, { field: 'label', value: item.label, placeholder: 'Tên tài liệu hoặc tổ chức' });
    addField(row, { field: 'href', value: item.href, placeholder: 'https://…' });
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'admin-text-button'; remove.dataset.removeSource = ''; remove.textContent = 'Xóa nguồn';
    row.append(remove); list.append(row);
  });
  const add = document.createElement('button'); add.type = 'button'; add.className = 'admin-secondary-button'; add.dataset.addSource = ''; add.textContent = '＋ Thêm nguồn';
  container.append(list, add);
}

function renderBlockImageUploader(container, block) {
  const uploader = document.createElement('div');
  uploader.className = 'admin-block-image-uploader';
  uploader.dataset.blockImageDropzone = '';
  uploader.tabIndex = 0;
  uploader.setAttribute('role', 'button');
  uploader.setAttribute('aria-label', 'Kéo thả hoặc chọn ảnh cho nội dung');
  const preview = document.createElement('div');
  preview.className = 'admin-block-image-preview';
  preview.dataset.blockImagePreview = '';
  if (block.url) {
    const image = new Image(); image.src = block.url; image.alt = block.alt || ''; preview.append(image);
  } else {
    const icon = document.createElement('span'); icon.textContent = '▧';
    const empty = document.createElement('small'); empty.textContent = 'Chưa có ảnh'; preview.append(icon, empty);
  }
  const copy = document.createElement('div'); copy.className = 'admin-block-image-copy';
  const strong = document.createElement('strong'); strong.textContent = 'Kéo ảnh vào đây';
  const hint = document.createElement('p'); hint.textContent = 'Ảnh được đổi sang WebP và tạo kích thước phù hợp cho mobile, tablet và desktop.';
  const choose = document.createElement('button'); choose.type = 'button'; choose.className = 'admin-secondary-button'; choose.dataset.chooseBlockImage = ''; choose.textContent = block.url ? 'Thay ảnh' : 'Chọn ảnh';
  const status = document.createElement('small'); status.className = 'admin-block-image-status'; status.dataset.blockImageStatus = ''; status.setAttribute('aria-live', 'polite');
  const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/jpeg,image/png,image/webp,image/avif'; input.hidden = true; input.dataset.blockImageFile = '';
  copy.append(strong, hint, choose, status, input); uploader.append(preview, copy); container.append(uploader);
}

function renderBlock(block) {
  const element = blockShell(block);
  const fields = $('.admin-block-fields', element);
  switch (block.type) {
    case 'paragraph': {
      const textarea = addRichTextField(fields, {
        field: 'text', value: block.text,
        placeholder: 'Nhập nội dung… Có thể dùng thanh công cụ để in đậm, in nghiêng và chèn liên kết.', rows: 5
      });
      const settings = document.createElement('div');
      settings.className = 'admin-block-text-settings';
      const label = document.createElement('label');
      label.textContent = 'Kích thước đoạn văn';
      label.htmlFor = `text-style-${block.id}`;
      const select = addSelect(settings, 'textStyle', [
        ['body', 'Tiêu chuẩn'],
        ['lead', 'Mở bài / nổi bật'],
        ['small', 'Thông tin phụ']
      ], block.textStyle || 'body');
      select.id = label.htmlFor;
      settings.prepend(label);
      fields.append(settings);
      textarea.setAttribute('aria-describedby', `${block.id}-format-help`);
      const help = document.createElement('small');
      help.id = `${block.id}-format-help`;
      help.className = 'admin-form-hint';
      help.textContent = 'Cỡ chữ dùng thang thiết kế cố định để giữ đúng giao diện và responsive của Blog RealView.';
      fields.append(help);
      break;
    }
    case 'heading':
    case 'subheading': {
      addField(fields, { field: 'text', value: block.text, placeholder: block.type === 'heading' ? 'Tiêu đề phần chính' : 'Tiêu đề phần phụ', className: block.type === 'heading' ? 'admin-block-heading-input' : 'admin-block-subheading-input' });
      const split = document.createElement('div'); split.className = 'admin-block-fields admin-block-fields--split';
      addField(split, { field: 'anchor', value: block.anchor, placeholder: 'id-heading-tu-dong' });
      addTocOption(split, block.includeInToc); fields.append(split); break;
    }
    case 'list':
      addSelect(fields, 'style', [['unordered', 'Danh sách dấu đầu dòng'], ['ordered', 'Danh sách đánh số']], block.style || 'unordered');
      addField(fields, { tag: 'textarea', field: 'items', value: (block.items || []).join('\n'), placeholder: 'Mỗi dòng là một mục trong danh sách', rows: 5 }); break;
    case 'checklist':
      addField(fields, { tag: 'textarea', field: 'checklistItems', value: (block.items || []).map((item) => `${item.checked ? '[x]' : '[ ]'} ${item.text || ''}`).join('\n'), placeholder: '[x] Mục đã hoàn thành\n[ ] Mục cần kiểm tra', rows: 5 }); break;
    case 'image': {
      renderBlockImageUploader(fields, block);
      addField(fields, { field: 'alt', value: block.alt, placeholder: 'Alt mô tả nội dung ảnh' });
      addField(fields, { field: 'caption', value: block.caption, placeholder: 'Chú thích hoặc nguồn ảnh' });
      addSelect(fields, 'display', [['wide', 'Ảnh rộng'], ['compact', 'Ảnh gọn'], ['reduced', 'Ảnh thu gọn'], ['smaller', 'Ảnh nhỏ']], block.display || 'wide');
      const manual = document.createElement('details'); manual.className = 'admin-block-image-manual';
      const summary = document.createElement('summary'); summary.textContent = 'Dùng URL ảnh có sẵn'; manual.append(summary);
      addField(manual, { field: 'url', value: block.url, placeholder: 'https://… hoặc /assets/…' }); fields.append(manual); break;
    }
    case 'callout':
      addSelect(fields, 'tone', [['info', 'Thông tin'], ['warning', 'Lưu ý'], ['success', 'Gợi ý'], ['neutral', 'Trung lập']], block.tone || 'info');
      addField(fields, { field: 'title', value: block.title, placeholder: 'Tiêu đề ghi chú' });
      addField(fields, { tag: 'textarea', field: 'text', value: block.text, placeholder: 'Nội dung cần nhấn mạnh', rows: 4 }); break;
    case 'quote':
      addField(fields, { tag: 'textarea', field: 'text', value: block.text, placeholder: 'Nội dung trích dẫn', rows: 4 });
      addField(fields, { field: 'cite', value: block.cite, placeholder: 'Nguồn trích dẫn' }); break;
    case 'formula':
      addField(fields, { tag: 'textarea', field: 'text', value: block.text, placeholder: 'Công thức hoặc biểu thức', rows: 3 });
      addField(fields, { field: 'ariaLabel', value: block.ariaLabel, placeholder: 'Cách đọc công thức cho trình đọc màn hình' }); break;
    case 'table':
      addField(fields, { field: 'caption', value: block.caption, placeholder: 'Tên hoặc mô tả bảng' });
      addField(fields, { field: 'headers', value: (block.headers || []).join(' | '), placeholder: 'Tiêu đề cột 1 | Tiêu đề cột 2' });
      addField(fields, { tag: 'textarea', field: 'rows', value: (block.rows || []).map((row) => row.join(' | ')).join('\n'), placeholder: 'Mỗi dòng là một hàng; phân cách cột bằng dấu |', rows: 6 }); break;
    case 'faq':
      addField(fields, { tag: 'textarea', field: 'description', value: block.description, placeholder: 'Đoạn mô tả hiển thị dưới tiêu đề FAQ và trước các câu hỏi', rows: 4 });
      renderFaqItems(fields, block.items || []); break;
    case 'sources': renderSourceItems(fields, block.items || []); break;
    case 'relatedPosts':
      { const note = document.createElement('p'); note.className = 'admin-form-hint'; note.textContent = 'Danh sách này được quản lý bằng các ô chọn trong phần “Bài viết liên quan”.'; fields.append(note); break; }
    case 'divider': {
      const note = document.createElement('p'); note.className = 'admin-form-hint'; note.textContent = 'Đường phân cách không cần thêm nội dung.'; fields.append(note); break;
    }
    case 'cta':
      addField(fields, { field: 'eyebrow', value: block.eyebrow, placeholder: 'Nhãn nhỏ' });
      addField(fields, { field: 'title', value: block.title, placeholder: 'Tiêu đề CTA', className: 'admin-block-heading-input' });
      addField(fields, { tag: 'textarea', field: 'text', value: block.text, placeholder: 'Nội dung CTA', rows: 3 });
      const split = document.createElement('div'); split.className = 'admin-block-fields admin-block-fields--split';
      addField(split, { field: 'label', value: block.label, placeholder: 'Nhãn nút' }); addField(split, { field: 'url', value: block.url, placeholder: 'Liên kết' }); fields.append(split); break;
    default: addField(fields, { tag: 'textarea', field: 'text', value: block.text, placeholder: 'Nhập nội dung…', rows: 5 });
  }
  return element;
}

function renderBlocks() {
  const list = $('[data-block-list]'); list.replaceChildren();
  state.currentPost.blocks.forEach((block) => list.append(renderBlock(block)));
}

function renderAuthors(authors = []) {
  const list = $('[data-author-list]');
  list.replaceChildren();
  (authors.length ? authors : [{ name: 'Nhóm RealView', email: '', url: '' }]).forEach((author, index) => {
    const row = document.createElement('div'); row.className = 'admin-author-row'; row.dataset.authorRow = '';
    const name = document.createElement('input'); name.type = 'text'; name.maxLength = 120; name.placeholder = 'Tên tác giả'; name.value = author.name || ''; name.dataset.authorName = ''; name.setAttribute('aria-label', `Tên tác giả ${index + 1}`);
    const email = document.createElement('input'); email.type = 'email'; email.maxLength = 254; email.placeholder = 'Email nội bộ (không bắt buộc)'; email.value = author.email || ''; email.dataset.authorEmail = ''; email.setAttribute('aria-label', `Email tác giả ${index + 1}`);
    const url = document.createElement('input'); url.type = 'url'; url.maxLength = 2048; url.placeholder = 'URL hồ sơ public (không bắt buộc)'; url.value = author.url || ''; url.dataset.authorUrl = ''; url.setAttribute('aria-label', `URL hồ sơ tác giả ${index + 1}`);
    const remove = document.createElement('button'); remove.type = 'button'; remove.dataset.removeAuthor = ''; remove.textContent = '×'; remove.title = 'Xóa tác giả'; remove.setAttribute('aria-label', `Xóa tác giả ${index + 1}`);
    row.append(name, email, url, remove); list.append(row);
  });
}

function readAuthors() {
  const authors = $$('[data-author-row]').map((row) => ({
    name: $('[data-author-name]', row)?.value.trim() || '',
    email: $('[data-author-email]', row)?.value.trim() || '',
    url: $('[data-author-url]', row)?.value.trim() || ''
  })).filter((author) => author.name);
  return authors.length ? authors : [{ name: 'Nhóm RealView', email: '', url: '' }];
}

function tocTargetsFromBlocks(blocks, relatedSlugs = []) {
  const targets = [];
  blocks.forEach((block) => {
    if (['heading', 'subheading'].includes(block.type) && block.text) {
      targets.push({
        anchor: slugify(block.anchor || block.text),
        label: block.text,
        level: block.type === 'subheading' || Number(block.level) === 3 ? 3 : 2,
        automatic: block.includeInToc !== false
      });
    } else if (block.type === 'faq' && block.items?.some((item) => item.question || item.answer)) {
      targets.push({ anchor: slugify(block.id === 'block-1' ? 'cau-hoi-thuong-gap' : block.id) || 'cau-hoi-thuong-gap', label: 'FAQ - Câu hỏi thường gặp', level: 2, automatic: true });
    } else if (block.type === 'relatedPosts' && (block.slugs?.length || relatedSlugs.length)) {
      targets.push({ anchor: 'bai-viet-lien-quan', label: 'Bài viết liên quan', level: 2, automatic: true });
    }
  });
  if (!blocks.some((block) => block.type === 'relatedPosts') && relatedSlugs.length) {
    targets.push({ anchor: 'bai-viet-lien-quan', label: 'Bài viết liên quan', level: 2, automatic: true });
  }
  return [...new Map(targets.filter((entry) => entry.anchor).map((entry) => [entry.anchor, entry])).values()];
}

function editorTocTargets() {
  const blocks = $$('.admin-block', $('[data-block-list]')).map(readBlock);
  return tocTargetsFromBlocks(blocks, $$('[data-related-post]:checked').map((input) => input.value));
}

function readTocEditor() {
  const editor = $('[data-toc-editor]');
  const mode = editor?.dataset.tocMode === 'manual' ? 'manual' : 'auto';
  return {
    mode,
    title: $('[data-toc-title]')?.value.trim() || 'Mục lục',
    entries: mode === 'manual' ? $$('[data-toc-entry-row]', editor).map((row) => ({
      anchor: $('[data-toc-entry-target]', row)?.value || '',
      label: $('[data-toc-entry-label]', row)?.value.trim() || '',
      level: Number(row.dataset.tocLevel) === 3 ? 3 : 2
    })).filter((entry) => entry.anchor && entry.label) : []
  };
}

function renderTocEditor(toc = readTocEditor()) {
  const editor = $('[data-toc-editor]');
  if (!editor) return;
  const mode = toc?.mode === 'manual' ? 'manual' : 'auto';
  const targets = editorTocTargets();
  const entries = mode === 'manual' ? (toc.entries || []) : targets.filter((entry) => entry.automatic);
  editor.dataset.tocMode = mode;
  $('[data-toc-title]').value = toc.title || 'Mục lục';
  $('[data-toc-status]').textContent = mode === 'manual' ? 'Danh sách chỉnh tay' : 'Tự động cập nhật';
  $('[data-toc-use-auto]').classList.toggle('is-active', mode === 'auto');
  $('[data-toc-generate]').classList.toggle('is-active', mode === 'manual');
  $('[data-toc-manual-actions]').hidden = mode !== 'manual';
  $('[data-toc-hint]').textContent = mode === 'manual'
    ? 'Đổi nhãn chỉ ảnh hưởng mục lục, không đổi tiêu đề trong bài. Mục bị xóa khỏi nội dung sẽ không xuất hiện khi render.'
    : 'Mọi thay đổi H2/H3 sẽ tự cập nhật mục lục.';
  const list = $('[data-toc-list]');
  list.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement('p'); empty.className = 'admin-toc-empty';
    empty.textContent = 'Chưa có mục nào. Hãy thêm H2/H3 hoặc bật “Hiển thị trong mục lục” ở một tiêu đề.';
    list.append(empty); return;
  }
  entries.forEach((entry) => {
    const target = targets.find((item) => item.anchor === entry.anchor) || entry;
    const row = document.createElement('div');
    row.className = `admin-toc-row${mode === 'auto' ? ' is-readonly' : ''}`;
    row.dataset.tocEntryRow = '';
    row.dataset.tocLevel = String(entry.level || target.level || 2);
    const level = document.createElement('span'); level.className = 'admin-toc-level'; level.textContent = `H${row.dataset.tocLevel}`;
    if (mode === 'auto') {
      const copy = document.createElement('div');
      const label = document.createElement('strong'); label.textContent = entry.label;
      const anchor = document.createElement('small'); anchor.textContent = `#${entry.anchor}`;
      copy.append(label, anchor); row.append(level, copy);
    } else {
      const label = document.createElement('input'); label.type = 'text'; label.maxLength = 300; label.value = entry.label || target.label || ''; label.dataset.tocEntryLabel = ''; label.setAttribute('aria-label', 'Nhãn hiển thị trong mục lục');
      const select = document.createElement('select'); select.dataset.tocEntryTarget = ''; select.setAttribute('aria-label', 'Phần nội dung được liên kết');
      targets.forEach((candidate) => {
        const option = document.createElement('option'); option.value = candidate.anchor; option.textContent = `${candidate.label} (#${candidate.anchor})`; option.selected = candidate.anchor === entry.anchor; select.append(option);
      });
      if (!targets.some((candidate) => candidate.anchor === entry.anchor)) {
        const missing = document.createElement('option'); missing.value = entry.anchor; missing.textContent = `Phần đã bị xóa (#${entry.anchor})`; missing.selected = true; select.prepend(missing); row.classList.add('is-missing');
      }
      const actions = document.createElement('div'); actions.className = 'admin-toc-row-actions';
      [['up', '↑', 'Đưa mục lên'], ['down', '↓', 'Đưa mục xuống'], ['remove', '×', 'Xóa khỏi mục lục']].forEach(([action, text, title]) => {
        const button = document.createElement('button'); button.type = 'button'; button.dataset.tocEntryAction = action; button.textContent = text; button.title = title; button.setAttribute('aria-label', title); actions.append(button);
      });
      row.append(level, label, select, actions);
    }
    list.append(row);
  });
}

function refreshAutomaticToc() {
  if ($('[data-toc-editor]')?.dataset.tocMode === 'auto') renderTocEditor(readTocEditor());
}

function createEditableToc() {
  const current = readTocEditor();
  const entries = editorTocTargets().filter((entry) => entry.automatic).map(({ anchor, label, level }) => ({ anchor, label, level }));
  renderTocEditor({ mode: 'manual', title: current.title, entries });
  markDirty();
}

function readBlock(element) {
  const type = element.dataset.blockType;
  const block = { ...(element._originalBlock || {}), id: element.dataset.blockId, type };
  $$('[data-block-field]', element).forEach((input) => {
    if (input.closest('[data-faq-item]')) return;
    let value = input.type === 'checkbox' ? input.checked : input.value;
    if (input.dataset.blockField === 'items' || input.dataset.blockField === 'slugs') value = value.split('\n').map((item) => item.trim()).filter(Boolean);
    if (input.dataset.blockField === 'checklistItems') {
      value = value.split('\n').map((item) => item.trim()).filter(Boolean).map((item) => ({
        checked: /^\[x\]/i.test(item),
        text: item.replace(/^\[(?:x| )\]\s*/i, '').trim()
      }));
      block.items = value;
      return;
    }
    if (input.dataset.blockField === 'headers') value = value.split('|').map((item) => item.trim()).filter(Boolean);
    if (input.dataset.blockField === 'rows') value = value.split('\n').map((row) => row.split('|').map((cell) => cell.trim())).filter((row) => row.some(Boolean));
    block[input.dataset.blockField] = value;
  });
  if (type === 'faq') {
    block.items = $$('[data-faq-item]', element).map((item) => ({ question: $('[data-block-field="question"]', item)?.value.trim() || '', answer: $('[data-block-field="answer"]', item)?.value.trim() || '' }));
  }
  if (type === 'sources') {
    block.items = $$('[data-source-item]', element).map((item) => ({ label: $('[data-block-field="label"]', item)?.value.trim() || '', href: $('[data-block-field="href"]', item)?.value.trim() || '' }));
  }
  if (type === 'image' && block.url !== element._originalBlock?.url) {
    block.width = 0; block.height = 0; block.responsiveSources = [];
  }
  return block;
}

function collectPost() {
  const form = $('[data-editor-form]');
  const value = (name) => form.elements[name]?.value?.trim?.() || '';
  const checked = (name) => Boolean(form.elements[name]?.checked);
  const title = value('title');
  const heroUrl = value('heroImageUrl');
  const heroImage = heroUrl === state.currentPost.heroImage?.url
    ? { ...state.currentPost.heroImage, url: heroUrl, alt: value('heroImageAlt'), caption: value('heroImageCaption') }
    : { url: heroUrl, alt: value('heroImageAlt'), caption: value('heroImageCaption'), width: 0, height: 0, responsiveSources: [] };
  const ogImageUrl = value('ogImageUrl');
  const ogImage = ogImageUrl === state.currentPost.seo.ogImage?.url
    ? { ...(state.currentPost.seo.ogImage || {}), url: ogImageUrl, alt: value('heroImageAlt') }
    : { url: ogImageUrl, alt: value('heroImageAlt'), width: 0, height: 0, responsiveSources: [] };
  const relatedSlugs = $$('[data-related-post]:checked').map((input) => input.value);
  const blocks = $$('.admin-block', $('[data-block-list]')).map(readBlock).map((block) => (
    block.type === 'relatedPosts' ? { ...block, slugs: relatedSlugs } : block
  ));
  return normalizePost({
    ...state.currentPost,
    title, h1: title, deck: value('deck'), slug: value('slug'),
    category: value('category'), categoryLabel: value('categoryLabel') || CATEGORY_LABELS[value('category')] || '',
    tags: value('tags').split(',').map((item) => item.trim()).filter(Boolean),
    authors: readAuthors(),
    featured: checked('featured'), publishedAt: fromLocalInput(value('publishedAt')), modifiedAt: fromLocalInput(value('modifiedAt')),
    seo: {
      ...state.currentPost.seo, title: value('seoTitle'), metaDescription: value('metaDescription'), primaryKeyword: value('primaryKeyword'), searchIntent: value('searchIntent'),
      canonicalPath: value('canonicalUrl'), canonicalUrl: value('canonicalUrl'), ogTitle: value('ogTitle'), ogDescription: value('ogDescription'),
      ogImage,
      ogImageUrl,
      robots: checked('allowIndexing') ? 'index,follow,max-image-preview:large' : 'noindex,nofollow'
    },
    heroImage,
    blocks,
    toc: readTocEditor(),
    relatedSlugs,
    settings: { includeFaqSchema: checked('includeFaqSchema'), allowIndexing: checked('allowIndexing') }
  });
}

function textFromBlocks(blocks) {
  return blocks.flatMap((block) => {
    if (block.type === 'list') return block.items || [];
    if (block.type === 'checklist') return (block.items || []).map((item) => item.text);
    if (block.type === 'relatedPosts') return block.slugs || [];
    if (block.type === 'table') return [...(block.headers || []), ...(block.rows || []).flat()];
    if (block.type === 'faq') return [block.description, ...(block.items || []).flatMap((item) => [item.question, item.answer])];
    return [block.text, block.title, block.caption].filter(Boolean);
  }).join(' ');
}

function contentChecks(post) {
  const text = textFromBlocks(post.blocks);
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return [
    { ok: post.title.length >= 20, text: 'Tiêu đề nêu rõ chủ đề bài viết' },
    { ok: post.deck.length >= 80, text: 'Đoạn mở đầu trả lời đúng search intent' },
    { ok: post.blocks.some((block) => block.type === 'heading'), text: 'Có ít nhất một tiêu đề H2' },
    { ok: words >= 500, text: `${words.toLocaleString('vi-VN')} từ trong nội dung chính` },
    { ok: post.blocks.some((block) => block.type === 'faq'), text: 'Có phần câu hỏi thường gặp' },
    { ok: post.blocks.some((block) => block.type === 'sources'), text: 'Có nguồn tham khảo rõ ràng' },
    { ok: post.blocks.some((block) => block.type === 'cta'), text: 'Có CTA phù hợp ở cuối bài' }
  ];
}

function seoChecks(post) {
  const keyword = post.seo.primaryKeyword.toLowerCase();
  const faqValid = !post.settings.includeFaqSchema || !post.blocks.some((block) => block.type === 'faq') || post.blocks.filter((block) => block.type === 'faq').every((block) => block.items.every((item) => item.question && item.answer));
  return [
    { ok: post.seo.title.length >= 30 && post.seo.title.length <= 65, text: 'SEO title dài khoảng 30–65 ký tự' },
    { ok: post.seo.metaDescription.length >= 100 && post.seo.metaDescription.length <= 170, text: 'Meta description dài khoảng 100–170 ký tự' },
    { ok: /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(post.slug), text: 'Slug ngắn gọn và đúng định dạng' },
    { ok: !keyword || post.title.toLowerCase().includes(keyword), text: 'Từ khóa chính xuất hiện trong H1' },
    { ok: Boolean(post.heroImage.url && post.heroImage.alt), text: 'Ảnh đại diện có URL và alt' },
    { ok: faqValid, text: 'FAQ hiển thị khớp dữ liệu schema' },
    { ok: post.relatedSlugs.length > 0 || post.blocks.some((block) => block.type === 'relatedPosts' && block.slugs?.length), text: 'Có ít nhất một internal link liên quan' }
  ];
}

function renderChecks(selector, checks) {
  const list = $(selector); list.replaceChildren();
  checks.forEach((check) => {
    const item = document.createElement('li'); item.className = check.ok ? 'is-valid' : 'is-error';
    const icon = document.createElement('span'); icon.textContent = check.ok ? '✓' : '!';
    item.append(icon, document.createTextNode(check.text)); list.append(item);
  });
  return Math.round((checks.filter((check) => check.ok).length / checks.length) * 100);
}

function updateChecks() {
  if (!state.currentPost) return;
  const post = collectPost();
  const content = contentChecks(post); const seo = seoChecks(post);
  $('[data-content-score]').textContent = `${renderChecks('[data-content-checks]', content)}%`;
  $('[data-seo-score]').textContent = `${renderChecks('[data-seo-checks]', seo)}%`;
  const errors = seo.filter((check) => !check.ok).length;
  $('[data-seo-count]').hidden = !errors; $('[data-seo-count]').textContent = String(errors);
  const words = textFromBlocks(post.blocks).trim().split(/\s+/).filter(Boolean).length;
  $('[data-word-count]').textContent = `${words.toLocaleString('vi-VN')} từ · ${Math.max(1, Math.ceil(words / 220))} phút đọc`;
  $('[data-title-count]').textContent = String(post.title.length);
  $('[data-seo-title-count]').textContent = String(post.seo.title.length);
  $('[data-meta-count]').textContent = String(post.seo.metaDescription.length);
  $('[data-google-slug]').textContent = post.slug || 'duong-dan-bai-viet';
  $('[data-google-title]').textContent = post.seo.title || `${post.title || 'Tiêu đề bài viết'} | RealView`;
  $('[data-google-description]').textContent = post.seo.metaDescription || 'Mô tả bài viết sẽ xuất hiện tại đây.';
}

function updateEditorMeta() {
  const post = state.currentPost;
  const status = $('[data-document-status]');
  status.textContent = post.status === 'published' && post.hasUnpublishedChanges
    ? 'Có bản nháp chưa xuất bản'
    : (STATUS_LABELS[post.status] || 'Bản nháp');
  status.className = `status-pill status-${post.status || 'draft'}`;
  const publishedRevision = Number(post.publishedRevision || 0);
  const currentRevision = Number(post.revision || 0);
  $('[data-revision-label]').textContent = post.status === 'published' && publishedRevision && publishedRevision !== currentRevision
    ? `Đang công khai Revision ${publishedRevision} · Bản nháp Revision ${currentRevision}`
    : `Revision ${currentRevision}`;
}

function markDirty() {
  if (!state.currentPost || state.saving) return;
  state.dirty = true; setSaveState('Có thay đổi chưa lưu'); updateChecks();
}

async function savePost({ quiet = false, forceCopy = false } = {}) {
  if (state.saving) return state.currentPost;
  clearTimeout(state.autosaveTimer);
  const post = collectPost();
  if (!post.title.trim()) {
    if (!quiet) toast('Hãy nhập tiêu đề trước khi lưu bài viết.', 'error');
    return null;
  }
  state.saving = true; setSaveState('Đang lưu…', 'saving');
  $$('[data-save-post],[data-publish-post]').forEach((button) => { button.disabled = true; });
  try {
    if (!post.slug) {
      post.slug = slugify(post.title);
      setFormValue('slug', post.slug);
    }
    if (!post.seo.title) { post.seo.title = `${post.title} | RealView`; setFormValue('seoTitle', post.seo.title); }
    const body = { action: 'save', id: forceCopy ? undefined : post.id || undefined, expectedRevision: forceCopy ? 0 : post.revision || 0, post: forceCopy ? { ...post, id: null, slug: `${post.slug}-ban-sao`, title: `${post.title} (bản sao)`, status: 'draft' } : post };
    const payload = await apiPost(body);
    state.currentPost = normalizeApiPost(payload, { ...post, id: payload.id || post.id, revision: payload.revision ?? (post.revision + 1) });
    state.dirty = false; setSaveState(`Đã lưu lúc ${new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}`, 'saved');
    updateEditorMeta(); renderRelatedPicker();
    $('[data-discard-draft]').hidden = !state.currentPost.hasUnpublishedChanges;
    if (!quiet) toast(forceCopy ? 'Đã lưu thành một bài viết mới.' : 'Đã lưu bản nháp.');
    return state.currentPost;
  } catch (error) {
    if (error.status === 409) {
      state.conflict = error.payload;
      $('[data-conflict-dialog]').showModal();
      setSaveState('Có xung đột phiên bản');
    } else {
      setSaveState('Lưu thất bại');
      if (!quiet) toast(error.message, 'error');
    }
    return null;
  } finally {
    state.saving = false;
    $$('[data-save-post],[data-publish-post]').forEach((button) => { button.disabled = false; });
  }
}

function publishErrors(post) {
  const errors = [];
  if (!post.title) errors.push('Thiếu tiêu đề bài viết');
  if (!post.slug) errors.push('Thiếu slug');
  if (!post.seo.title) errors.push('Thiếu SEO title');
  if (!post.seo.metaDescription) errors.push('Thiếu meta description');
  if (!post.heroImage.url) errors.push('Thiếu ảnh đại diện');
  if (!post.heroImage.alt) errors.push('Thiếu alt ảnh đại diện');
  if (!post.blocks.some((block) => block.type === 'heading')) errors.push('Bài viết chưa có H2');
  const anchors = post.blocks.filter((block) => ['heading', 'subheading'].includes(block.type)).map((block) => block.anchor).filter(Boolean);
  if (new Set(anchors).size !== anchors.length) errors.push('Có heading dùng trùng anchor');
  const incompleteFaq = post.blocks.filter((block) => block.type === 'faq').some((block) => block.items.some((item) => !item.question || !item.answer));
  if (incompleteFaq) errors.push('FAQ có câu hỏi hoặc câu trả lời còn trống');
  return errors;
}

async function publishPost() {
  let post = collectPost();
  const errors = publishErrors(post);
  if (errors.length) {
    switchEditorTab(errors.some((item) => /SEO|meta|slug/.test(item)) ? 'seo' : errors.some((item) => /ảnh|alt/.test(item)) ? 'media' : 'content');
    toast(`Chưa thể xuất bản: ${errors[0]}.`, 'error');
    return;
  }
  if (state.dirty || !post.id) {
    post = await savePost();
    if (!post) return;
  }
  const confirmed = await confirmAction('Xuất bản bài viết?', 'Bài viết sẽ hiển thị công khai và được đưa vào sitemap nếu cho phép Google lập chỉ mục.', 'Xuất bản');
  if (!confirmed) return;
  try {
    const payload = await apiPost({ action: 'publish', id: post.id, expectedRevision: post.revision });
    state.currentPost = normalizeApiPost(payload, { ...post, status: 'published', revision: payload.revision ?? post.revision });
    updateEditorMeta(); $('[data-unpublish-post]').hidden = false; $('[data-discard-draft]').hidden = true; $('[data-publish-post]').textContent = 'Cập nhật bài viết →';
    toast('Bài viết đã được xuất bản.'); await loadPosts();
  } catch (error) {
    if (error.status === 409) { state.conflict = error.payload; $('[data-conflict-dialog]').showModal(); }
    else toast(error.message, 'error');
  }
}

async function unpublishPost(id = state.currentPost?.id, revision = state.currentPost?.revision) {
  if (!id) return;
  const confirmed = await confirmAction('Gỡ bài viết khỏi website?', 'URL bài viết sẽ ngừng hiển thị công khai và được loại khỏi sitemap. Bản nội dung vẫn được giữ lại.', 'Gỡ xuất bản');
  if (!confirmed) return;
  try {
    const payload = await apiPost({ action: 'unpublish', id, expectedRevision: revision });
    if (state.currentPost?.id === id) {
      state.currentPost = normalizeApiPost(payload, { ...state.currentPost, status: 'draft', revision: payload.revision ?? state.currentPost.revision });
      updateEditorMeta(); $('[data-unpublish-post]').hidden = true; $('[data-publish-post]').textContent = 'Xuất bản →';
    }
    toast('Bài viết đã được chuyển về bản nháp.'); await loadPosts();
  } catch (error) { toast(error.message, 'error'); }
}

async function discardDraft() {
  const post = state.currentPost;
  if (!post?.id || !post.hasUnpublishedChanges) return;
  const confirmed = await confirmAction(
    'Bỏ bản nháp chưa xuất bản?',
    `Nội dung đang chỉnh sửa ở Revision ${post.revision} sẽ được bỏ. Bài viết quay lại Revision ${post.publishedRevision} đang công khai.`,
    'Bỏ bản nháp'
  );
  if (!confirmed) return;
  try {
    const payload = await apiPost({ action: 'discard_draft', id: post.id, expectedRevision: post.revision });
    state.currentPost = normalizeApiPost(payload, post);
    openEditor(state.currentPost);
    toast(`Đã quay lại Revision ${state.currentPost.publishedRevision || state.currentPost.revision}.`);
    await loadPosts();
  } catch (error) {
    if (error.status === 409) { state.conflict = error.payload; $('[data-conflict-dialog]').showModal(); }
    else toast(error.message, 'error');
  }
}

async function archivePost(post) {
  const confirmed = await confirmAction('Lưu trữ bài viết?', 'Bài viết sẽ được gỡ khỏi danh sách nội dung đang hoạt động. Lịch sử phiên bản vẫn được giữ lại.', 'Lưu trữ');
  if (!confirmed) return;
  try {
    await apiPost({ action: 'archive', id: post.id, expectedRevision: post.revision });
    toast('Đã lưu trữ bài viết.'); await loadPosts();
  } catch (error) { toast(error.message, 'error'); }
}

async function previewPost() {
  const popup = window.open('', '_blank');
  try {
    const post = collectPost();
    const payload = await apiPost({ action: 'preview', post });
    if (!payload.preview) throw new Error('Máy chủ chưa tạo được bản xem trước.');
    if (popup) { popup.document.open(); popup.document.write(payload.preview); popup.document.close(); }
    else toast('Trình duyệt đang chặn cửa sổ xem trước.', 'error');
  } catch (error) { popup?.close(); toast(error.message, 'error'); }
}

function confirmAction(title, message, label = 'Xác nhận') {
  const dialog = $('[data-confirm-dialog]');
  $('[data-confirm-title]').textContent = title; $('[data-confirm-message]').textContent = message; $('[data-confirm-submit]').textContent = label;
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
}

function renderRelatedPicker() {
  const picker = $('[data-related-picker]');
  if (!picker || !state.currentPost) return;
  picker.replaceChildren();
  const candidates = state.posts.filter((post) => post.id && post.id !== state.currentPost.id && post.status === 'published');
  if (!candidates.length) { const p = document.createElement('p'); p.textContent = 'Chưa có bài viết khác để liên kết.'; picker.append(p); return; }
  candidates.forEach((post) => {
    const label = document.createElement('label');
    const input = document.createElement('input'); input.type = 'checkbox'; input.value = post.slug; input.dataset.relatedPost = ''; input.checked = state.currentPost.relatedSlugs.includes(post.slug);
    const title = document.createElement('span'); title.textContent = post.title || 'Bài viết chưa đặt tên';
    const status = document.createElement('small'); status.textContent = STATUS_LABELS[post.status] || post.status;
    label.append(input, title, status); picker.append(label);
  });
}

function renderHeroPreview() {
  const url = $('[name="heroImageUrl"]')?.value.trim();
  const preview = $('[data-hero-preview]'); preview.replaceChildren();
  if (url) { const image = new Image(); image.src = url; image.alt = ''; preview.append(image); }
  else { const icon = document.createElement('span'); icon.textContent = '▧'; const p = document.createElement('p'); p.textContent = 'Chưa có ảnh đại diện'; preview.append(icon, p); }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file);
  });
}

function validateMediaFile(file) {
  if (!file) throw new Error('Chưa chọn file ảnh.');
  if (!/^image\/(jpeg|png|webp|avif)$/.test(file.type)) throw new Error('Chỉ chấp nhận JPEG, PNG, WebP hoặc AVIF.');
  if (file.size > 3 * 1024 * 1024) throw new Error('Ảnh không được vượt quá 3 MB.');
}

function uploadFileName(file, suffix = 'image') {
  const extension = (file.name.match(/\.[a-z0-9]+$/i)?.[0] || '.jpg').toLowerCase();
  const postName = slugify($('[name="slug"]')?.value || $('[name="title"]')?.value || 'bai-viet');
  return `${postName || 'bai-viet'}-${slugify(suffix) || 'image'}${extension}`;
}

async function uploadMedia(file, { alt = '', suffix = 'image' } = {}) {
  validateMediaFile(file);
  const data = await readFileAsBase64(file);
  const payload = await apiPost({
    action: 'upload_media',
    fileName: uploadFileName(file, suffix),
    contentType: file.type,
    data,
    alt
  });
  const asset = payload.asset || payload;
  if (!asset?.url) throw new Error('Máy chủ không trả về URL ảnh.');
  return asset;
}

function suggestedBlockAlt(element) {
  const blocks = $$('.admin-block', $('[data-block-list]'));
  const index = blocks.indexOf(element);
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (['heading', 'subheading'].includes(blocks[cursor].dataset.blockType)) {
      const heading = $('[data-block-field="text"]', blocks[cursor])?.value.trim();
      if (heading) return heading.slice(0, 300);
    }
  }
  return ($('[name="title"]')?.value.trim() || 'Hình minh họa bài viết').slice(0, 300);
}

async function uploadBlockImage(element, file) {
  const status = $('[data-block-image-status]', element);
  const preview = $('[data-block-image-preview]', element);
  const dropzone = $('[data-block-image-dropzone]', element);
  const urlField = $('[data-block-field="url"]', element);
  const altField = $('[data-block-field="alt"]', element);
  const originalUrl = urlField?.value || '';
  let localUrl = '';
  try {
    validateMediaFile(file);
    localUrl = URL.createObjectURL(file);
    preview.replaceChildren(); const localImage = new Image(); localImage.src = localUrl; localImage.alt = ''; preview.append(localImage);
    dropzone.classList.add('is-uploading'); status.textContent = 'Đang tối ưu và tải ảnh…';
    if (!altField.value.trim()) altField.value = suggestedBlockAlt(element);
    const asset = await uploadMedia(file, { alt: altField.value.trim(), suffix: element.dataset.blockId || 'noi-dung' });
    urlField.value = asset.url;
    element._originalBlock = {
      ...(element._originalBlock || {}),
      url: asset.url,
      width: Number(asset.width || 0),
      height: Number(asset.height || 0),
      responsiveSources: asset.responsiveSources || []
    };
    const image = new Image(); image.src = asset.url; image.alt = altField.value.trim(); preview.replaceChildren(image);
    status.textContent = `${asset.responsiveSources?.length || 1} kích thước WebP đã sẵn sàng`;
    markDirty(); toast('Đã tải và tối ưu ảnh nội dung.');
  } catch (error) {
    if (urlField) urlField.value = originalUrl;
    preview.replaceChildren();
    if (originalUrl) { const image = new Image(); image.src = originalUrl; image.alt = altField?.value || ''; preview.append(image); }
    else { const icon = document.createElement('span'); icon.textContent = '▧'; const empty = document.createElement('small'); empty.textContent = 'Chưa có ảnh'; preview.append(icon, empty); }
    status.textContent = ''; toast(error.message, 'error');
  } finally {
    dropzone.classList.remove('is-uploading', 'is-dragging');
    if (localUrl) URL.revokeObjectURL(localUrl);
  }
}

async function uploadHero(file) {
  if (!file) return;
  const previousUrl = $('[name="heroImageUrl"]').value;
  let localUrl = '';
  try {
    validateMediaFile(file);
    if (!$('[name="heroImageAlt"]').value.trim()) {
      $('[name="heroImageAlt"]').value = ($('[name="title"]')?.value.trim() || 'Ảnh đại diện bài viết').slice(0, 300);
    }
    localUrl = URL.createObjectURL(file); $('[name="heroImageUrl"]').value = localUrl; renderHeroPreview();
    const asset = await uploadMedia(file, { alt: $('[name="heroImageAlt"]').value.trim(), suffix: 'hero' });
    state.currentPost.heroImage = {
      ...state.currentPost.heroImage,
      url: asset.url,
      width: Number(asset.width || 0),
      height: Number(asset.height || 0),
      responsiveSources: asset.responsiveSources || [],
      alt: $('[name="heroImageAlt"]').value.trim()
    };
    if (!$('[name="ogImageUrl"]').value.trim() || $('[name="ogImageUrl"]').value.trim() === previousUrl) {
      $('[name="ogImageUrl"]').value = asset.url;
      state.currentPost.seo.ogImage = { ...state.currentPost.seo.ogImage, ...state.currentPost.heroImage };
    }
    $('[name="heroImageUrl"]').value = asset.url; renderHeroPreview(); markDirty(); toast('Đã tải và tối ưu ảnh đại diện.');
  } catch (error) {
    $('[name="heroImageUrl"]').value = previousUrl; renderHeroPreview(); toast(error.message, 'error');
  } finally { if (localUrl) URL.revokeObjectURL(localUrl); }
}

async function loadRevisions() {
  const list = $('[data-revision-list]');
  if (!state.currentPost?.id) { list.innerHTML = '<p>Hãy lưu bài viết để bắt đầu lưu lịch sử phiên bản.</p>'; return; }
  list.innerHTML = '<p>Đang tải lịch sử phiên bản…</p>';
  try {
    const payload = await apiGet('revisions', { id: state.currentPost.id });
    const revisions = payload.revisions || payload.items || [];
    list.replaceChildren();
    if (!revisions.length) { const p = document.createElement('p'); p.textContent = 'Chưa có phiên bản trước đó.'; list.append(p); return; }
    revisions.forEach((revision) => {
      const item = document.createElement('article'); item.className = 'admin-revision-item';
      const copy = document.createElement('div'); const title = document.createElement('strong'); const meta = document.createElement('small');
      const savedBy = revision.savedBy || revision.author || {};
      const savedByLabel = typeof savedBy === 'string' ? savedBy : savedBy.username || savedBy.email || savedBy.name || 'Admin RealView';
      title.textContent = `Revision ${revision.revision ?? revision.version}`; meta.textContent = `${formatDate(revision.savedAt || revision.createdAt || revision.modifiedAt)} · ${savedByLabel}`; copy.append(title, meta);
      const actions = document.createElement('div'); const preview = document.createElement('button'); preview.type = 'button'; preview.dataset.previewRevision = revision.revision ?? revision.version; preview.textContent = 'Xem phiên bản'; actions.append(preview);
      if (Number(revision.revision ?? revision.version) !== Number(state.currentPost.revision)) {
        const restore = document.createElement('button'); restore.type = 'button'; restore.dataset.restoreRevision = revision.revision ?? revision.version; restore.textContent = 'Khôi phục'; actions.append(restore);
      }
      item.append(copy, actions); list.append(item);
    });
  } catch (error) { list.innerHTML = ''; const p = document.createElement('p'); p.textContent = error.message; list.append(p); }
}

function closeEditor() {
  if (!state.dirty) { showView('posts'); return; }
  confirmAction('Rời khỏi trình soạn thảo?', 'Bạn đang có thay đổi chưa được lưu. Nếu rời khỏi, các thay đổi này sẽ bị mất.', 'Rời khỏi').then((confirmed) => { if (confirmed) { clearTimeout(state.autosaveTimer); state.dirty = false; showView('posts'); } });
}

function openGuide() {
  if (!state.dirty) { showView('guide'); return; }
  confirmAction('Mở trang hướng dẫn?', 'Bạn đang có thay đổi chưa được lưu. Nếu rời khỏi trình soạn thảo, các thay đổi này sẽ bị mất.', 'Mở hướng dẫn').then((confirmed) => {
    if (confirmed) { clearTimeout(state.autosaveTimer); state.dirty = false; showView('guide'); }
  });
}

function addBlock(type) {
  state.currentPost.blocks = $$('.admin-block', $('[data-block-list]')).map(readBlock);
  const block = createBlock(type); state.currentPost.blocks.push(block); $('[data-block-list]').append(renderBlock(block));
  $('[data-block-menu]').hidden = true; $('[data-add-block-toggle]').setAttribute('aria-expanded', 'false'); refreshAutomaticToc(); markDirty();
  $(`[data-block-id="${block.id}"] input, [data-block-id="${block.id}"] textarea`)?.focus();
}

function initializeEvents() {
  $('[data-access-login]').addEventListener('click', () => openAuthDialog({ mode: 'login', message: 'Đăng nhập bằng tài khoản được cấp quyền quản trị Blog RealView.' }));
  $('[data-create-post]').addEventListener('click', () => openEditor());
  $('[data-view-link="new"]').addEventListener('click', () => openEditor());
  $('[data-view-link="posts"]').addEventListener('click', closeEditor);
  $('[data-view-link="guide"]').addEventListener('click', openGuide);
  $$('[data-guide-new]').forEach((button) => button.addEventListener('click', () => openEditor()));
  $('[data-access-management]').addEventListener('click', () => { window.location.href = '/admin/access'; });
  $('[data-close-editor]').addEventListener('click', closeEditor);
  $('[data-save-post]').addEventListener('click', () => savePost());
  $('[data-discard-draft]').addEventListener('click', discardDraft);
  $('[data-publish-post]').addEventListener('click', publishPost);
  $('[data-unpublish-post]').addEventListener('click', () => unpublishPost());
  $('[data-preview-post]').addEventListener('click', previewPost);
  $('[data-open-seo]').addEventListener('click', () => switchEditorTab('seo'));
  $('[data-refresh-revisions]').addEventListener('click', loadRevisions);
  $('[data-copy-social]').addEventListener('click', () => { setFormValue('ogTitle', $('[name="seoTitle"]').value); setFormValue('ogDescription', $('[name="metaDescription"]').value); markDirty(); });

  $$('[data-editor-tab]').forEach((button) => button.addEventListener('click', () => {
    switchEditorTab(button.dataset.editorTab);
    if (button.dataset.editorTab === 'revisions') loadRevisions();
  }));
  $$('[data-status-filter]').forEach((button) => button.addEventListener('click', () => {
    state.filter = button.dataset.statusFilter;
    $$('[data-status-filter]').forEach((item) => { const active = item === button; item.classList.toggle('is-active', active); item.setAttribute('aria-pressed', String(active)); });
    renderPosts();
  }));
  $('[data-post-search]').addEventListener('input', (event) => { state.query = event.target.value; renderPosts(); });

  $('[data-post-list]').addEventListener('click', async (event) => {
    const row = event.target.closest('tr[data-post-id]'); if (!row) return;
    const post = state.posts.find((item) => item.id === row.dataset.postId); if (!post) return;
    if (event.target.closest('[data-edit-row]')) return editPost(post.id);
    const menuButton = event.target.closest('[data-row-menu]');
    if (menuButton) { const menu = $('.post-row-menu', row); $$('.post-row-menu').forEach((item) => { if (item !== menu) item.hidden = true; }); menu.hidden = !menu.hidden; return; }
    if (event.target.closest('[data-duplicate-row]')) {
      const payload = await apiGet('detail', { id: post.id }).catch((error) => { toast(error.message, 'error'); return null; });
      if (payload) { const copy = normalizePost(payload.post || payload); copy.id = null; copy.revision = 0; copy.status = 'draft'; copy.title = `${copy.title} (bản sao)`; copy.slug = `${copy.slug}-ban-sao`; openEditor(copy); }
      return;
    }
    if (event.target.closest('[data-unpublish-row]')) return unpublishPost(post.id, post.revision);
    if (event.target.closest('[data-archive-row]')) return archivePost(post);
  });

  $('[data-editor-form]').addEventListener('input', (event) => {
    if (event.target.name === 'title' && !$('[name="slug"]').value && !state.currentPost.id) $('[name="slug"]').value = slugify(event.target.value);
    if (event.target.name === 'heroImageUrl') renderHeroPreview();
    if (event.target.closest('.admin-block')) refreshAutomaticToc();
    markDirty();
  });
  $('[data-editor-form]').addEventListener('change', (event) => { if (event.target.closest('.admin-block') || event.target.matches('[data-related-post]')) refreshAutomaticToc(); markDirty(); });
  $('[data-toc-use-auto]').addEventListener('click', () => {
    const current = readTocEditor();
    renderTocEditor({ mode: 'auto', title: current.title, entries: [] });
    markDirty();
  });
  $('[data-toc-generate]').addEventListener('click', createEditableToc);
  $('[data-toc-regenerate]').addEventListener('click', createEditableToc);
  $('[data-toc-add]').addEventListener('click', () => {
    const current = readTocEditor();
    const used = new Set(current.entries.map((entry) => entry.anchor));
    const target = editorTocTargets().find((entry) => !used.has(entry.anchor));
    if (!target) return toast('Không còn phần nội dung nào để thêm vào mục lục.', 'error');
    current.entries.push({ anchor: target.anchor, label: target.label, level: target.level });
    renderTocEditor(current); markDirty();
  });
  $('[data-toc-editor]').addEventListener('click', (event) => {
    const button = event.target.closest('[data-toc-entry-action]');
    if (!button) return;
    const row = button.closest('[data-toc-entry-row]');
    if (button.dataset.tocEntryAction === 'remove') row.remove();
    if (button.dataset.tocEntryAction === 'up' && row.previousElementSibling) row.parentNode.insertBefore(row, row.previousElementSibling);
    if (button.dataset.tocEntryAction === 'down' && row.nextElementSibling) row.parentNode.insertBefore(row.nextElementSibling, row);
    markDirty();
  });
  $('[data-toc-editor]').addEventListener('change', (event) => {
    const select = event.target.closest('[data-toc-entry-target]');
    if (select) {
      const target = editorTocTargets().find((entry) => entry.anchor === select.value);
      const row = select.closest('[data-toc-entry-row]');
      if (target && row) { row.dataset.tocLevel = String(target.level); $('.admin-toc-level', row).textContent = `H${target.level}`; }
    }
    markDirty();
  });
  $('[data-add-author]').addEventListener('click', () => {
    const authors = readAuthors();
    if ($$('[data-author-row]').length >= 10) return toast('Mỗi bài có tối đa 10 tác giả.', 'error');
    authors.push({ name: '', email: '', url: '' }); renderAuthors(authors); markDirty();
    $$('[data-author-name]').at(-1)?.focus();
  });
  $('[data-author-list]').addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-author]');
    if (!remove) return;
    const rows = $$('[data-author-row]');
    if (rows.length <= 1) return toast('Bài viết cần ít nhất một tác giả.', 'error');
    remove.closest('[data-author-row]').remove(); markDirty();
  });
  $('[data-add-block-toggle]').addEventListener('click', () => { const menu = $('[data-block-menu]'); menu.hidden = !menu.hidden; $('[data-add-block-toggle]').setAttribute('aria-expanded', String(!menu.hidden)); });
  $('[data-block-menu]').addEventListener('click', (event) => { const button = event.target.closest('[data-add-block]'); if (button) addBlock(button.dataset.addBlock); });

  $('[data-block-list]').addEventListener('click', (event) => {
    const element = event.target.closest('.admin-block'); if (!element) return;
    const chooseImage = event.target.closest('[data-choose-block-image]');
    if (chooseImage) { $('[data-block-image-file]', element)?.click(); return; }
    if (event.target.closest('[data-remove-block]')) { if ($$('.admin-block').length === 1) return toast('Bài viết cần ít nhất một khối nội dung.', 'error'); element.remove(); refreshAutomaticToc(); markDirty(); return; }
    if (event.target.closest('[data-duplicate-block]')) { const block = { ...readBlock(element), id: uid() }; element.insertAdjacentElement('afterend', renderBlock(block)); refreshAutomaticToc(); markDirty(); return; }
    const move = event.target.closest('[data-move-block]');
    if (move?.dataset.moveBlock === 'up' && element.previousElementSibling) element.parentNode.insertBefore(element, element.previousElementSibling);
    if (move?.dataset.moveBlock === 'down' && element.nextElementSibling) element.parentNode.insertBefore(element.nextElementSibling, element);
    if (move) { refreshAutomaticToc(); markDirty(); }
    if (event.target.closest('[data-add-faq]')) { const list = $('[data-faq-items]', element); const row = document.createElement('div'); row.className = 'admin-block-fields'; row.dataset.faqItem = ''; addField(row, { field: 'question', placeholder: 'Câu hỏi thường gặp' }); addField(row, { tag: 'textarea', field: 'answer', placeholder: 'Câu trả lời rõ ràng, ngắn gọn', rows: 3 }); const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'admin-text-button'; remove.dataset.removeFaq = ''; remove.textContent = 'Xóa câu hỏi'; row.append(remove); list.append(row); markDirty(); }
    if (event.target.closest('[data-remove-faq]')) { const items = $$('[data-faq-item]', element); if (items.length <= 1) return toast('Khối FAQ cần ít nhất một câu hỏi.', 'error'); event.target.closest('[data-faq-item]').remove(); markDirty(); }
    if (event.target.closest('[data-add-source]')) { const list = $('[data-source-items]', element); const row = document.createElement('div'); row.className = 'admin-block-fields admin-block-fields--split'; row.dataset.sourceItem = ''; addField(row, { field: 'label', placeholder: 'Tên tài liệu hoặc tổ chức' }); addField(row, { field: 'href', placeholder: 'https://…' }); const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'admin-text-button'; remove.dataset.removeSource = ''; remove.textContent = 'Xóa nguồn'; row.append(remove); list.append(row); markDirty(); }
    if (event.target.closest('[data-remove-source]')) { const items = $$('[data-source-item]', element); if (items.length <= 1) return toast('Khối nguồn cần ít nhất một mục.', 'error'); event.target.closest('[data-source-item]').remove(); markDirty(); }
  });
  $('[data-block-list]').addEventListener('change', (event) => {
    const input = event.target.closest('[data-block-image-file]');
    const element = input?.closest('.admin-block');
    if (input && element) { uploadBlockImage(element, input.files?.[0]); input.value = ''; }
  });
  ['dragenter', 'dragover'].forEach((name) => $('[data-block-list]').addEventListener(name, (event) => {
    const dropzone = event.target.closest('[data-block-image-dropzone]');
    if (!dropzone) return;
    event.preventDefault(); dropzone.classList.add('is-dragging');
  }));
  ['dragleave', 'drop'].forEach((name) => $('[data-block-list]').addEventListener(name, (event) => {
    const dropzone = event.target.closest('[data-block-image-dropzone]');
    if (!dropzone) return;
    event.preventDefault(); dropzone.classList.remove('is-dragging');
    if (name === 'drop') uploadBlockImage(dropzone.closest('.admin-block'), event.dataTransfer?.files?.[0]);
  }));
  $('[data-block-list]').addEventListener('keydown', (event) => {
    const dropzone = event.target.closest('[data-block-image-dropzone]');
    if (dropzone && ['Enter', ' '].includes(event.key)) { event.preventDefault(); $('[data-block-image-file]', dropzone)?.click(); }
  });

  $('[data-choose-hero]').addEventListener('click', () => $('[data-hero-file]').click());
  $('[data-hero-file]').addEventListener('change', (event) => uploadHero(event.target.files?.[0]));
  const dropzone = $('[data-hero-dropzone]');
  ['dragenter', 'dragover'].forEach((name) => dropzone.addEventListener(name, (event) => { event.preventDefault(); dropzone.classList.add('is-dragging'); }));
  ['dragleave', 'drop'].forEach((name) => dropzone.addEventListener(name, (event) => { event.preventDefault(); dropzone.classList.remove('is-dragging'); }));
  dropzone.addEventListener('drop', (event) => uploadHero(event.dataTransfer?.files?.[0]));

  $('[data-conflict-copy]').addEventListener('click', async () => { $('[data-conflict-dialog]').close(); await savePost({ forceCopy: true }); });
  $('[data-conflict-reload]').addEventListener('click', async () => { $('[data-conflict-dialog]').close(); if (state.currentPost?.id) await editPost(state.currentPost.id); });
  $('[data-revision-list]').addEventListener('click', (event) => {
    const preview = event.target.closest('[data-preview-revision]');
    if (preview) {
      const popup = window.open('', '_blank');
      apiGet('preview', { id: state.currentPost.id, revision: preview.dataset.previewRevision }).then((payload) => {
        if (!payload.preview) throw new Error('Máy chủ chưa tạo được bản xem trước.');
        if (popup) { popup.document.open(); popup.document.write(payload.preview); popup.document.close(); }
      }).catch((error) => { popup?.close(); toast(error.message, 'error'); });
    }
    const restore = event.target.closest('[data-restore-revision]');
    if (restore) {
      const revisionToRestore = Number(restore.dataset.restoreRevision);
      confirmAction('Khôi phục phiên bản này?', `Nội dung Revision ${revisionToRestore} sẽ được sao chép thành một revision mới; lịch sử hiện tại vẫn được giữ nguyên.`, 'Khôi phục').then(async (confirmed) => {
        if (!confirmed) return;
        try {
          const payload = await apiPost({ action: 'restore', id: state.currentPost.id, revisionToRestore, expectedRevision: state.currentPost.revision });
          state.currentPost = normalizeApiPost(payload, state.currentPost);
          openEditor(state.currentPost);
          toast(`Đã khôi phục từ Revision ${revisionToRestore}.`);
        } catch (error) { toast(error.message, 'error'); }
      });
    }
  });

  document.addEventListener('click', (event) => {
    if (!event.target.closest('.post-row-actions')) $$('.post-row-menu').forEach((menu) => { menu.hidden = true; });
    if (!event.target.closest('.admin-add-block')) { $('[data-block-menu]').hidden = true; $('[data-add-block-toggle]').setAttribute('aria-expanded', 'false'); }
  });
  window.addEventListener('beforeunload', (event) => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('realview:auth-changed', () => initializeAccess());
}

async function initializeAccess() {
  setAccess('Đang kiểm tra quyền truy cập', 'Vui lòng chờ trong giây lát.');
  state.user = await getCurrentUser({ refresh: true });
  if (!state.user) { setAccess('Bạn chưa đăng nhập', 'Đăng nhập bằng tài khoản được cấp quyền admin hoặc editor để quản lý nội dung.', { login: true }); return; }
  try {
    await loadPosts(); showView('posts');
  } catch (error) {
    if (error.status === 401) setAccess('Phiên đăng nhập đã hết hạn', 'Hãy đăng nhập lại để tiếp tục.', { login: true });
    else if (error.status === 403) setAccess('Tài khoản chưa được cấp quyền', `${state.user.email || state.user.username} không có quyền quản trị Blog RealView.`);
    else setAccess('Không thể tải Blog Studio', error.message);
  }
}

function initialize() {
  initializeEvents();
  initializeAccess();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
