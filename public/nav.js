(() => {
  const nav = document.querySelector('#main-navigation');
  const header = document.querySelector('.site-header');
  const toggle = document.querySelector('.nav-toggle');
  if (!nav) return;

  const isCriteria = document.body.classList.contains('criteria-page');
  const isContact = document.body.classList.contains('contact-page');
  if (isContact) {
    const homeItems = [
      ['/#about', 'Về RealView'],
      ['/#how-it-works', 'Cách dùng RealView'],
      ['/#realview-benefits', 'Vì sao nên chọn RealView?'],
      ['/#featured', 'Tính năng nổi bật'],
    ];
    const criteriaItems = [
      ['/criteria.html#evaluation-process', 'Quy trình đánh giá'],
      ['/criteria.html#criteria-library', 'Bộ tiêu chí đánh giá'],
    ];
    const dropdownMarkup = (items) => `<span class="nav-dropdown" role="menu">${items.map(([href, label]) => `<a href="${href}" role="menuitem">${label}</a>`).join('')}</span>`;
    nav.innerHTML = `
      <span class="nav-indicator" aria-hidden="true"></span>
      <span class="nav-parent-wrap"><a class="nav-parent" data-nav-parent="home" href="/#home">Trang chủ</a>${dropdownMarkup(homeItems)}</span>
      <span class="nav-parent-wrap"><a class="nav-parent" data-nav-parent="criteria" href="/criteria.html">Tiêu chí lọc</a>${dropdownMarkup(criteriaItems)}</span>`;
    nav.querySelectorAll('.nav-parent-wrap').forEach((parent) => {
      parent.addEventListener('mouseenter', () => {
        nav.querySelectorAll('.nav-parent-wrap').forEach((item) => item.classList.remove('is-dropdown-open'));
        parent.classList.add('is-dropdown-open');
      });
      parent.addEventListener('focus', () => {
        nav.querySelectorAll('.nav-parent-wrap').forEach((item) => item.classList.remove('is-dropdown-open'));
        parent.classList.add('is-dropdown-open');
      });
    });
    nav.addEventListener('mouseleave', () => {
      nav.querySelectorAll('.nav-parent-wrap').forEach((item) => item.classList.remove('is-dropdown-open'));
    });
    nav.addEventListener('click', (event) => {
      if (event.target.closest('.nav-dropdown a')) {
        header?.classList.remove('is-menu-open');
        toggle?.setAttribute('aria-expanded', 'false');
      }
    });
    toggle?.addEventListener('click', () => {
      const open = !header?.classList.contains('is-menu-open');
      header?.classList.toggle('is-menu-open', open);
      toggle.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', (event) => {
      if (header?.classList.contains('is-menu-open') && !header.contains(event.target)) {
        header.classList.remove('is-menu-open');
        toggle?.setAttribute('aria-expanded', 'false');
      }
    });
    return;
  }
  const pageHref = (href, group) => {
    if (group === 'criteria') return isCriteria ? href : `/criteria.html${href}`;
    return isCriteria || isContact ? `/${href}` : href;
  };
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
  const activeGroup = isCriteria ? 'criteria' : 'home';
  const homeHref = isCriteria ? '/#home' : '#home';
  const criteriaHref = '/criteria.html';
  const activeClass = (group) => group === activeGroup ? ' is-active' : '';
  const activeCurrent = (group) => group === activeGroup ? ' aria-current="page"' : '';

  nav.innerHTML = `
    <span class="nav-indicator" aria-hidden="true"></span>
    <a class="nav-parent${activeClass('home')}" data-nav-parent="home" href="${homeHref}"${activeCurrent('home')}>Trang chủ</a>
    <a class="nav-cloud" href="${isCriteria ? '#evaluation-process' : '#about'}" aria-label="Mở các mục con">K<span class="nav-dropdown" role="menu"></span></a>
    <a class="nav-parent${activeClass('criteria')}" data-nav-parent="criteria" href="${criteriaHref}"${activeCurrent('criteria')}>Tiêu chí lọc</a>`;

  const cloud = nav.querySelector('.nav-cloud');
  const dropdown = nav.querySelector('.nav-dropdown');
  const closeMenu = () => {
    header?.classList.remove('is-menu-open');
    toggle?.setAttribute('aria-expanded', 'false');
  };

  const renderDropdown = (items) => {
    const group = items === criteriaItems ? 'criteria' : 'home';
    dropdown.innerHTML = items.map(([href, label]) => `<a href="${pageHref(href, group)}" role="menuitem">${label}</a>`).join('');
    cloud.dataset.dropdownGroup = items === criteriaItems ? 'criteria' : 'home';
  };
  renderDropdown(isCriteria ? criteriaItems : homeItems);

  const scrollItems = isCriteria
    ? [['review-criteria', 'Tiêu chí lọc'], ['evaluation-process', 'Quy trình đánh giá'], ['criteria-library', 'Bộ tiêu chí đánh giá']]
    : [['home', 'Trang chủ'], ...homeItems.map(([href, label]) => [href.slice(1), label])];
  const scrollSections = scrollItems
    .map(([id]) => document.getElementById(id))
    .filter(Boolean);
  const setCloudLabel = (sectionId) => {
    const item = scrollItems.find(([id]) => id === sectionId);
    if (!item) return;
    cloud.firstChild.textContent = item[1];
    cloud.href = `#${item[0]}`;
  };
  setCloudLabel(scrollSections[0]?.id);
  if ('IntersectionObserver' in window && scrollSections.length) {
    const scrollObserver = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (visible) setCloudLabel(visible.target.id);
    }, { rootMargin: '-24% 0px -62% 0px', threshold: [0, .2, .5] });
    scrollSections.forEach((section) => scrollObserver.observe(section));
  }

  nav.querySelectorAll('.nav-parent').forEach((parent) => {
    parent.addEventListener('mouseenter', () => {
      renderDropdown(parent.dataset.navParent === 'criteria' ? criteriaItems : homeItems);
      nav.classList.add('is-dropdown-open');
      nav.dataset.hoveredParent = parent.dataset.navParent;
    });
    parent.addEventListener('focus', () => {
      renderDropdown(parent.dataset.navParent === 'criteria' ? criteriaItems : homeItems);
      nav.classList.add('is-dropdown-open');
      nav.dataset.hoveredParent = parent.dataset.navParent;
    });
  });
  nav.addEventListener('mouseleave', () => {
    nav.classList.remove('is-dropdown-open');
    delete nav.dataset.hoveredParent;
  });
  nav.addEventListener('click', (event) => {
    if (event.target.closest('.nav-dropdown a')) closeMenu();
  });
  toggle?.addEventListener('click', () => {
    const open = !header?.classList.contains('is-menu-open');
    header?.classList.toggle('is-menu-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (event) => {
    if (header?.classList.contains('is-menu-open') && !header.contains(event.target)) closeMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
  });
})();
