(() => {
  const cards = [...document.querySelectorAll('[data-blog-card]')];
  const filterButtons = [...document.querySelectorAll('[data-blog-filter]')];
  const sidebarButtons = [...document.querySelectorAll('[data-sidebar-filter]')];
  const searchInput = document.querySelector('#blog-search-input');
  const emptyState = document.querySelector('[data-blog-empty]');
  const pagination = document.querySelector('[data-blog-pagination]');
  if (!cards.length) return;

  const firstPageSize = 5;
  const pageSize = 6;
  let activeFilter = 'all';
  let currentPage = 1;

  const normalize = (value) => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('vi')
    .trim();

  const renderPagination = (visibleCards) => {
    if (!pagination) return;
    const pageCount = visibleCards.length <= firstPageSize
      ? 1
      : 1 + Math.ceil((visibleCards.length - firstPageSize) / pageSize);
    pagination.replaceChildren();
    pagination.hidden = pageCount <= 1;
    if (pagination.hidden) return;

    const addButton = (label, page, { disabled = false, current = false, ariaLabel = label } = {}) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'blog-page-button';
      button.textContent = label;
      button.disabled = disabled;
      button.setAttribute('aria-label', ariaLabel);
      if (current) button.setAttribute('aria-current', 'page');
      button.addEventListener('click', () => {
        currentPage = page;
        update();
        document.querySelector('#thu-vien-bai-viet')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      pagination.append(button);
    };

    addButton('‹', Math.max(1, currentPage - 1), {
      disabled: currentPage === 1,
      ariaLabel: 'Trang trước',
    });

    let pageNumbers = [...Array(pageCount)].map((_, index) => index + 1);
    if (pageCount > 7) {
      const pages = new Set([1, pageCount, currentPage, currentPage - 1, currentPage + 1]);
      pageNumbers = [...pages].filter((page) => page >= 1 && page <= pageCount).sort((a, b) => a - b);
    }

    let previousPage = 0;
    pageNumbers.forEach((page) => {
      if (previousPage && page - previousPage > 1) {
        const ellipsis = document.createElement('span');
        ellipsis.className = 'blog-page-ellipsis';
        ellipsis.setAttribute('aria-hidden', 'true');
        ellipsis.textContent = '…';
        pagination.append(ellipsis);
      }
      addButton(String(page), page, { current: page === currentPage, ariaLabel: `Trang ${page}` });
      previousPage = page;
    });

    addButton('›', Math.min(pageCount, currentPage + 1), {
      disabled: currentPage === pageCount,
      ariaLabel: 'Trang tiếp theo',
    });
  };

  const update = () => {
    const query = normalize(searchInput?.value);
    const matchingCards = cards.filter((card) => {
      const categories = String(card.dataset.category || '').split(/\s+/);
      const searchText = normalize(`${card.dataset.search || ''} ${card.textContent || ''}`);
      const matchesFilter = activeFilter === 'all' || categories.includes(activeFilter);
      const matchesSearch = !query || searchText.includes(query);
      return matchesFilter && matchesSearch;
    });
    const pageCount = Math.max(1, matchingCards.length <= firstPageSize
      ? 1
      : 1 + Math.ceil((matchingCards.length - firstPageSize) / pageSize));
    currentPage = Math.min(currentPage, pageCount);
    const firstCardIndex = currentPage === 1
      ? 0
      : firstPageSize + (currentPage - 2) * pageSize;
    const currentPageSize = currentPage === 1 ? firstPageSize : pageSize;
    const visibleCards = new Set(matchingCards.slice(firstCardIndex, firstCardIndex + currentPageSize));

    cards.forEach((card) => {
      card.hidden = !visibleCards.has(card);
    });

    filterButtons.forEach((button) => {
      const isActive = button.dataset.blogFilter === activeFilter;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    });
    if (emptyState) emptyState.hidden = matchingCards.length !== 0;
    renderPagination(matchingCards);
  };

  const chooseFilter = (filter, shouldScroll = false) => {
    activeFilter = filter || 'all';
    currentPage = 1;
    update();
    if (shouldScroll) document.querySelector('#thu-vien-bai-viet')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  filterButtons.forEach((button) => button.addEventListener('click', () => chooseFilter(button.dataset.blogFilter)));
  sidebarButtons.forEach((button) => button.addEventListener('click', () => chooseFilter(button.dataset.sidebarFilter, true)));
  searchInput?.addEventListener('input', () => {
    currentPage = 1;
    update();
  });
  update();
})();
