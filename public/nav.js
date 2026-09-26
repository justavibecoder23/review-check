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
      label: 'Instagram',
      href: 'https://www.instagram.com/real.viewueh?stkn=em9tdjNmcTJ5OW91',
      icon: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1"/>',
    },
    {
      label: 'Threads',
      href: 'https://www.threads.com/@real.viewueh',
      asset: '/assets/threads-logo.svg',
    },
  ];

  const appendChannels = (container, showLabels) => {
    if (!container) return;
    socialChannels.forEach(({ label, href, icon, asset }) => {
      if ([...container.querySelectorAll('a')].some((link) => link.href === href)) return;
      const link = document.createElement('a');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', `${label} RealView`);
      const iconMarkup = asset
        ? `<span class="social-icon-threads" aria-hidden="true" style="--social-icon: url('${asset}')"></span>`
        : `<svg class="social-icon-outline" viewBox="0 0 24 24" fill="none" aria-hidden="true">${icon}</svg>`;
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
