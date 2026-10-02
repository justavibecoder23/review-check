import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { LEGAL_PAGES, LEGAL_CONTACT, LEGAL_UPDATED, LEGAL_VERSION } from '../src/legal-content.mjs';

const site = 'https://www.realview.com.vn';
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const e = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const p = (text) => `<p>${e(text)}</p>`;

export function renderLegalPage(page, footer) {
  const other = LEGAL_PAGES.find((entry) => entry.key !== page.key);
  const paragraphs = (items = []) => items.map(p).join('\n');
  const sections = page.sections.map((section, index) => {
    // Turn source labels into numbered subheadings without changing the copy.
    const list = section.bullets ? (section.bullets.every((item) => item.label)
      ? section.bullets.map((item, subIndex) => `<div class="legal-subsection"><h3>${index + 1}.${subIndex + 1}. ${e(item.label)}</h3>${p(item.text)}</div>`).join('\n')
      : `<ol class="legal-letter-list">${section.bullets.map((item) => `<li>${item.label ? `<strong>${e(item.label)}.</strong> ` : ''}${e(item.text)}</li>`).join('\n')}</ol>`) : '';
    const table = section.table ? `<div class="legal-table-wrap"><table class="legal-table"><caption>${e(section.table.caption)}</caption><thead><tr>${section.table.columns.map((label) => `<th scope="col">${e(label)}</th>`).join('')}</tr></thead><tbody>${section.table.rows.map(([label, text]) => `<tr><th scope="row">${e(label)}</th><td>${e(text)}</td></tr>`).join('\n')}</tbody></table></div>` : '';
    return `<section id="${e(section.id)}" class="legal-section" aria-labelledby="title-${e(section.id)}">
      <h2 id="title-${e(section.id)}">${index + 1}. ${e(section.title)}</h2>
      ${paragraphs(section.paragraphs)}${list}${table}${paragraphs(section.paragraphsAfter)}
      ${section.contact ? `<p>Email hỗ trợ: <a href="mailto:${LEGAL_CONTACT}">${LEGAL_CONTACT}</a>. Bạn cũng có thể dùng <a href="/lien-he">trang liên hệ RealView</a>.</p>` : ''}
      ${section.related ? `<p><a href="${other.path}">Đọc ${e(other.title)}</a>.</p>` : ''}
    </section>`;
  }).join('\n');
  const schema = JSON.stringify({ '@context': 'https://schema.org', '@graph': [
    { '@type': 'WebPage', '@id': `${site}${page.path}#webpage`, url: `${site}${page.path}`, name: `${page.title} | RealView`, description: page.description, inLanguage: 'vi-VN', dateModified: LEGAL_UPDATED },
    { '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Trang chủ', item: `${site}/` },
      { '@type': 'ListItem', position: 2, name: page.title, item: `${site}${page.path}` }
    ] }
  ] }).replace(/</g, '\\u003c');
  // Landing adds Threads through nav.js. Emit the same existing destination
  // statically here, so the legal pages do not need the application's JS bundle.
  const sharedFooter = footer.includes('https://www.threads.com/@real.viewueh') ? footer : footer.replace(
    /(<div class="footer-social">[\s\S]*?)(<\/div>)/,
    `$1<a href="https://www.threads.com/@real.viewueh" target="_blank" rel="noopener noreferrer" aria-label="Threads RealView"><span class="social-icon-threads" aria-hidden="true" style="--social-icon: url('/assets/threads-logo.svg')"></span><span>Threads</span></a>$2`
  );
  const markedFooter = sharedFooter.replace(`href="${page.path}"`, `href="${page.path}" aria-current="page"`);
  return `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="${e(page.description)}" />
    <meta name="robots" content="index,follow" />
    <meta name="theme-color" content="#FFFFFF" />
    <title>${e(page.title)} | RealView</title>
    <link rel="canonical" href="${site}${page.path}" />
    <meta property="og:locale" content="vi_VN" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="RealView" />
    <meta property="og:title" content="${e(page.title)} | RealView" />
    <meta property="og:description" content="${e(page.description)}" />
    <meta property="og:url" content="${site}${page.path}" />
    <meta property="og:image" content="${site}/assets/realview-rv.png" />
    <link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-v1-32.png" />
    <link rel="apple-touch-icon" sizes="180x180" href="/assets/apple-touch-icon-v1.png" />
    <link rel="stylesheet" href="/styles.css" />
    <link rel="stylesheet" href="/legal.css" />
    <script type="application/ld+json">${schema}</script>
    <script src="/legal.js" defer></script>
  </head>
  <body class="legal-page">
    <a class="skip-link" href="#noi-dung-chinh">Đi đến nội dung chính</a>
    <header class="site-header">
      <div class="container header-inner">
        <a class="brand" href="/" aria-label="RealView - Trang chủ"><span class="brand-mark" aria-hidden="true"><img src="/assets/realview-logo-v1.webp" alt="" width="128" height="75" /></span><span><b>REAL</b>VIEW</span></a>
        <nav class="main-nav" aria-label="Điều hướng chính"><a href="/">Trang chủ</a><a href="/tieu-chi-loc">Tiêu chí lọc</a><a href="/bai-viet">Blog</a></nav>
        <div class="header-utilities"><a class="header-contact" href="/lien-he">Liên hệ</a></div>
      </div>
    </header>
    <main id="noi-dung-chinh" class="container legal-main">
      <nav class="legal-breadcrumb" aria-label="Đường dẫn trang"><a href="/">Trang chủ</a><span aria-hidden="true">/</span><span aria-current="page">${e(page.title)}</span></nav>
      <div class="legal-surface">
        <header class="legal-heading"><h1>${e(page.title)}</h1><p class="legal-meta"><span>Phiên bản ${LEGAL_VERSION}</span><span>Cập nhật: <time datetime="${LEGAL_UPDATED}">01/10/2026</time></span></p><p class="legal-lead">${e(page.lead)}</p></header>
        <aside class="legal-summary" aria-labelledby="legal-summary-title"><h2 id="legal-summary-title">Những điểm bạn cần biết</h2><ul>${page.summary.map((text) => `<li>${e(text)}</li>`).join('\n')}</ul></aside>
        <div class="legal-layout">
          <nav class="legal-toc" aria-label="Mục lục ${e(page.title)}"><h2>Mục lục</h2><ol>${page.sections.map((section) => `<li><a href="#${e(section.id)}">${e(section.title)}</a></li>`).join('\n')}</ol></nav>
          <article class="legal-reading" aria-label="Nội dung ${e(page.title)}">
            ${sections}
            <nav class="legal-end" aria-label="Đọc tiếp"><a href="${other.path}">${e(other.title)}</a><a href="/lien-he">Liên hệ hỗ trợ</a></nav>
            <p class="legal-footer-note">Nếu bạn cần làm rõ một mục, hãy liên hệ nhóm RealView trước khi cung cấp thông tin hoặc sử dụng tính năng liên quan.</p>
          </article>
        </div>
      </div>
    </main>
    ${markedFooter}
    <script src="/i18n.js" defer></script>
  </body>
</html>
`.replace(/[\t ]+$/gm, '');
}

export async function buildLegalPages() {
  const home = await readFile(resolve(publicDir, 'index.html'), 'utf8');
  const footer = home.match(/<footer class="site-footer">[\s\S]*?<\/footer>/)?.[0];
  if (!footer || !footer.includes('footer-legal')) throw new Error('Landing footer is missing its legal row.');
  for (const page of LEGAL_PAGES) {
    await writeFile(resolve(publicDir, page.file), renderLegalPage(page, footer));
    console.log(`Built /${page.file} → ${page.path}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildLegalPages();
