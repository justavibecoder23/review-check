(() => {
  const nav = document.querySelector('#main-navigation');
  const header = document.querySelector('.site-header');
  const toggle = document.querySelector('.nav-toggle');
  if (!nav) return;

  const isMobileNav = () => window.matchMedia('(max-width: 900px)').matches;
  const setDropdownState = (wrap, open) => {
    nav.querySelectorAll('.nav-parent-wrap').forEach((item) => {
      if (item !== wrap) item.classList.remove('is-dropdown-open');
    });
    if (wrap) wrap.classList.toggle('is-dropdown-open', open);
    nav.classList.toggle('is-dropdown-open', !!(wrap && open));
  };
  
  const isCriteria = document.body.classList.contains('criteria-page');
  const isContact = document.body.classList.contains('contact-page');
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
  const activeGroup = isContact ? '' : isCriteria ? 'criteria' : 'home';
  const pageHref = (href, group) => {
    if (group === 'criteria') return isCriteria ? href : `/criteria.html${href}`;
    return isCriteria || isContact ? `/${href}` : href;
  };
  const dropdownMarkup = (items, group) => `<span class="nav-dropdown" role="menu">${items.map(([href, label]) => `<a href="${pageHref(href, group)}" role="menuitem">${label}</a>`).join('')}</span>`;
  const navItem = (group, label, href, items) => {
    const active = group === activeGroup;
    return `<span class="nav-parent-wrap"><a class="nav-parent${active ? ' is-active' : ''}" data-nav-parent="${group}" href="${href}"${active ? ' aria-current="page"' : ''}>${label}</a>${dropdownMarkup(items, group)}</span>`;
  };
  
  nav.innerHTML = `
    <span class="nav-indicator" aria-hidden="true"></span>
  ${navItem('home', 'Trang chủ', isCriteria || isContact ? '/#home' : '#home', homeItems)}
    ${navItem('criteria', 'Tiêu chí lọc', '/criteria.html', criteriaItems)}
    <span class="nav-link nav-blog" aria-disabled="true">Blog</span>`;

  const closeMenu = () => {
    header?.classList.remove('is-menu-open');
    toggle?.setAttribute('aria-expanded', 'false');
  };


  nav.querySelectorAll('.nav-parent').forEach((parent) => {
    const parentWrap = parent.closest('.nav-parent-wrap');
    
      parent.addEventListener('click', (event) => {
        if (!isMobileNav()) return;
        event.preventDefault();
        event.stopPropagation();
        const isOpen = parentWrap?.classList.contains('is-dropdown-open');
      nav.querySelectorAll('.nav-parent-wrap').forEach((item) => item.classList.remove('is-dropdown-open'));
      if (!isOpen) parentWrap?.classList.add('is-dropdown-open');
      });
    
    parent.addEventListener('mouseenter', () => {
      if (isMobileNav()) return;
      nav.querySelectorAll('.nav-parent-wrap').forEach((item) => item.classList.remove('is-dropdown-open'));
      nav.querySelectorAll('.nav-parent').forEach((item) => item.style.removeProperty('background-color'));
      nav.querySelectorAll('.nav-parent-wrap').forEach((item) => item.classList.remove('is-hovered'));
      parentWrap?.classList.add('is-dropdown-open', 'is-hovered');
      if (!parent.classList.contains('is-active') && !parent.hasAttribute('aria-current')) {
        parent.style.setProperty('background-color', 'rgba(252,120,31,.14)', 'important');
      }
      nav.classList.add('is-dropdown-open');
      nav.dataset.hoveredParent = parent.dataset.navParent;
    });
    parent.addEventListener('focus', () => {
      if (isMobileNav()) return;
      nav.querySelectorAll('.nav-parent-wrap').forEach((item) => item.classList.remove('is-dropdown-open'));
      nav.querySelectorAll('.nav-parent').forEach((item) => item.style.removeProperty('background-color'));
      nav.querySelectorAll('.nav-parent-wrap').forEach((item) => item.classList.remove('is-hovered'));
      parentWrap?.classList.add('is-dropdown-open', 'is-hovered');
      if (!parent.classList.contains('is-active') && !parent.hasAttribute('aria-current')) {
        parent.style.setProperty('background-color', 'rgba(252,120,31,.14)', 'important');
      }
      nav.classList.add('is-dropdown-open');
      nav.dataset.hoveredParent = parent.dataset.navParent;
    });
  });
  nav.addEventListener('mouseleave', () => {
    nav.querySelectorAll('.nav-parent').forEach((item) => item.style.removeProperty('background-color'));
    nav.querySelectorAll('.nav-parent-wrap').forEach((item) => item.classList.remove('is-dropdown-open'));
    nav.querySelectorAll('.nav-parent-wrap').forEach((item) => item.classList.remove('is-hovered'));
    nav.classList.remove('is-dropdown-open');
    delete nav.dataset.hoveredParent;
  });
  nav.addEventListener('click', (event) => {
    if (event.target.closest('.nav-dropdown a')) closeMenu();
  });
  document.addEventListener('click', (event) => {
    if (header?.classList.contains('is-menu-open') && !header.contains(event.target)) closeMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
  });
})();
