(() => {
  const nav = document.querySelector('#main-navigation');
  const header = document.querySelector('.site-header');
  const toggle = document.querySelector('.nav-toggle');
  const toggleLabel = document.querySelector('.nav-toggle-label');
  if (!nav) return;

  const mobileQuery = window.matchMedia('(max-width: 900px)');
  const isMobileNav = () => mobileQuery.matches;
  const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
  const isHome = pathname === '/' || pathname.endsWith('/index.html');
  const isCriteria = document.body.classList.contains('criteria-page') || pathname.endsWith('/criteria.html');
  const isContact = document.body.classList.contains('contact-page') || pathname.endsWith('/contact.html');

  const homeItems = [
    ['#about', 'Về RealView'],
    ['#how-it-works', 'Cách dùng RealView'],
    ['#realview-benefits', 'Vì sao nên chọn RealView?'],
    ['#featured', 'Tính năng nổi bật'],
  ];
  const criteriaItems = [
    ['#evaluation-process', 'Quy trình đánh giá'],
    ['#criteria-library', 'Bộ tiêu chí đánh giá'],
  ];
  const activeGroup = isHome ? 'home' : isCriteria ? 'criteria' : '';
  const pageHref = (href, group) => {
    if (group === 'criteria') return isCriteria ? href : `/criteria.html${href}`;
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
    ${navItem('home', 'Trang chủ', isHome ? '#home' : '/#home', homeItems)}
    ${navItem('criteria', 'Tiêu chí lọc', '/criteria.html', criteriaItems)}
    <span class="nav-link nav-blog" aria-disabled="true">Blog <small>Sắp ra mắt</small></span>`;

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
