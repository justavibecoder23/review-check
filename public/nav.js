(() => {
  const nav = document.querySelector('#main-navigation');
  const header = document.querySelector('.site-header');
  const toggle = document.querySelector('.nav-toggle');
  const toggleLabel = document.querySelector('.nav-toggle-label');
  if (!nav) return;

  const mobileQuery = window.matchMedia('(max-width: 1024px)');
  const isMobileNav = () => mobileQuery.matches;
  const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
  const isHome = pathname === '/' || pathname.endsWith('/index.html');
  const isCriteria = document.body.classList.contains('criteria-page') || pathname === '/tieu-chi-loc';
  const isContact = document.body.classList.contains('contact-page') || pathname === '/lien-he';
  const isBlog = document.body.classList.contains('blog-page') || pathname === '/bai-viet' || pathname.startsWith('/bai-viet/');
  const legacyHashes = {
    '#home': '#trang-chu',
    '#about': '#ve-realview',
    '#how-it-works': '#cach-su-dung',
    '#realview-benefits': '#loi-ich-realview',
    '#featured': '#tinh-nang-noi-bat',
    '#result': '#ket-qua',
    '#review-criteria': '#tieu-chi-danh-gia',
    '#evaluation-process': '#quy-trinh-danh-gia',
    '#criteria-library': '#bo-tieu-chi',
    '#kept-reviews': '#danh-gia-giu-lai',
    '#excluded-reviews': '#danh-gia-da-loai',
  };
  const translatedHash = legacyHashes[window.location.hash];
  if (translatedHash) {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${translatedHash}`);
    window.requestAnimationFrame(() => document.querySelector(translatedHash)?.scrollIntoView());
  }

  const homeItems = [
    ['#ve-realview', 'Về RealView'],
    ['#cach-su-dung', 'Cách dùng RealView'],
    ['#loi-ich-realview', 'Vì sao nên chọn RealView?'],
    ['#tinh-nang-noi-bat', 'Tính năng nổi bật'],
  ];
  const criteriaItems = [
    ['#quy-trinh-danh-gia', 'Quy trình đánh giá'],
    ['#bo-tieu-chi', 'Bộ tiêu chí đánh giá'],
  ];
  const activeGroup = isHome ? 'home' : isCriteria ? 'criteria' : isBlog ? 'blog' : '';
  const pageHref = (href, group) => {
    if (group === 'criteria') return isCriteria ? href : `/tieu-chi-loc${href}`;
    return isHome ? href : `/${href}`;
  };
  const dropdownMarkup = (items, group, id, label) => `
    <span id="${id}" class="nav-dropdown" aria-label="Danh mục ${label}">
      ${items.map(([href, itemLabel]) => `<a href="${pageHref(href, group)}">${itemLabel}</a>`).join('')}
    </span>`;
  const navItem = (group, label, href, items) => {
    const active = group === activeGroup;
    const dropdownId = `nav-dropdown-${group}`;
    return `
      <span class="nav-parent-wrap" data-nav-group="${group}">
        <span class="nav-parent-row">
          <a class="nav-parent${active ? ' is-active' : ''}" data-nav-parent="${group}" href="${href}"${active ? ' aria-current="page"' : ''}>${label}</a>
          <button class="nav-dropdown-toggle" type="button" aria-expanded="false" aria-controls="${dropdownId}" aria-label="Mở danh mục ${label}">
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m6 8 4 4 4-4"/></svg>
          </button>
        </span>
        ${dropdownMarkup(items, group, dropdownId, label)}
      </span>`;
  };

  nav.innerHTML = `
    <span class="nav-indicator" aria-hidden="true"></span>
    ${navItem('home', 'Trang chủ', isHome ? '#trang-chu' : '/#trang-chu', homeItems)}
    ${navItem('criteria', 'Tiêu chí lọc', '/tieu-chi-loc', criteriaItems)}
    <button class="nav-history-trigger" type="button" data-history-open>Lịch sử <span data-history-count hidden>0</span></button>
    <div class="nav-blog-wrapper${isBlog ? ' is-active' : ''}">
      <a class="nav-link nav-blog${isBlog ? ' is-active' : ''}" href="/bai-viet"${isBlog ? ' aria-current="page"' : ''}>
        <div class="nav-blog-content">Blog</div>
      </a>
      <span class="nav-blog-badge">New</span>
    </div>`;

  const dropdownWraps = [...nav.querySelectorAll('.nav-parent-wrap')];

  const setDropdownState = (targetWrap, open) => {
    dropdownWraps.forEach((wrap) => {
      const shouldOpen = wrap === targetWrap && open;
      wrap.classList.toggle('is-dropdown-open', shouldOpen);
      const button = wrap.querySelector('.nav-dropdown-toggle');
      const label = wrap.querySelector('.nav-parent')?.textContent.trim() || 'danh mục';
      button?.setAttribute('aria-expanded', String(shouldOpen));
      button?.setAttribute('aria-label', `${shouldOpen ? 'Đóng' : 'Mở'} danh mục ${label}`);
    });
    nav.classList.toggle('is-dropdown-open', Boolean(targetWrap && open));
  };

  const closeMenu = (restoreFocus = false) => {
    header?.classList.remove('is-menu-open');
    toggle?.setAttribute('aria-expanded', 'false');
    if (toggleLabel) toggleLabel.textContent = 'Mở menu';
    setDropdownState(null, false);
    if (restoreFocus) toggle?.focus();
  };

  dropdownWraps.forEach((wrap) => {
    const parent = wrap.querySelector('.nav-parent');
    const dropdownToggle = wrap.querySelector('.nav-dropdown-toggle');

    dropdownToggle?.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const willOpen = !wrap.classList.contains('is-dropdown-open');
      setDropdownState(wrap, willOpen);
    });

    parent?.addEventListener('mouseenter', () => {
      if (!isMobileNav()) setDropdownState(wrap, true);
    });
    parent?.addEventListener('focus', () => {
      if (!isMobileNav()) setDropdownState(wrap, true);
    });
  });

  nav.addEventListener('mouseleave', () => {
    if (!isMobileNav()) setDropdownState(null, false);
  });
  nav.addEventListener('focusout', () => {
    window.setTimeout(() => {
      if (!nav.contains(document.activeElement)) setDropdownState(null, false);
    }, 0);
  });
  nav.addEventListener('click', (event) => {
    if (isMobileNav() && event.target.closest('a')) closeMenu();
  });

  toggle?.addEventListener('click', () => {
    window.setTimeout(() => {
      if (toggle.getAttribute('aria-expanded') !== 'true') setDropdownState(null, false);
    }, 0);
  });
  document.addEventListener('click', (event) => {
    if (header?.classList.contains('is-menu-open') && !header.contains(event.target)) closeMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (header?.classList.contains('is-menu-open')) closeMenu(true);
    else setDropdownState(null, false);
  });
  window.addEventListener('resize', () => {
    if (!isMobileNav()) closeMenu();
  });
})();

// Keep the social destinations consistent across every shared footer and the contact card.
(() => {
  const socialChannels = [
    {
      label: 'Facebook',
      href: 'https://www.facebook.com/profile.php?id=61594093477895',
      viewBox: '0 0 16 16',
      icon: '<path d="M16 8.049C16 3.603 12.418 0 8 0S0 3.603 0 8.049C0 12.067 2.925 15.397 6.75 16v-5.624H4.719V8.049H6.75V6.276c0-2.017 1.194-3.131 3.022-3.131.875 0 1.791.157 1.791.157v1.986h-1.009c-.994 0-1.304.622-1.304 1.26v1.501h2.219l-.355 2.327H9.25V16C13.075 15.397 16 12.067 16 8.049Z"/>',
    },
    {
      label: 'TikTok',
      href: 'https://www.tiktok.com/@realviewueh',
      viewBox: '0 0 24 24',
      icon: '<path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.72-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07Z"/>',
    },
    {
      label: 'Threads',
      href: 'https://www.threads.com/@real.viewueh',
      asset: '/assets/threads-logo.svg',
    },
  ];

  const appendChannels = (container, showLabels) => {
    if (!container) return;
    socialChannels.forEach(({ label, href, viewBox, icon, asset }) => {
      let link = [...container.querySelectorAll('a')].find((candidate) => candidate.href === href);
      const iconMarkup = asset
        ? `<span class="social-icon-threads" aria-hidden="true" style="--social-icon: url('${asset}')"></span>`
        : `<svg viewBox="${viewBox}" aria-hidden="true">${icon}</svg>`;
      if (link) {
        if (!link.querySelector('svg, .social-icon-threads')) link.insertAdjacentHTML('afterbegin', iconMarkup);
        return;
      }
      link = document.createElement('a');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', `${label} RealView`);
      link.innerHTML = `${iconMarkup}${showLabels ? `<span>${label}</span>` : ''}`;
      container.append(link);
    });
  };

  document.querySelectorAll('.footer-social').forEach((container) => appendChannels(container, true));
  appendChannels(document.querySelector('.contact-social-links'), false);
})();

// Setup scroll to top button for all subpages
(() => {
  const backToTop = document.querySelector('.back-to-top');
  if (!backToTop) return;

  function updateBackToTop() {
    backToTop.classList.toggle('is-visible', window.scrollY > 400);
  }

  backToTop.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  window.addEventListener('scroll', updateBackToTop, { passive: true });
  updateBackToTop();
})();
