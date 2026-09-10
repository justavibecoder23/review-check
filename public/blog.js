(() => {
  const cards = [...document.querySelectorAll('[data-blog-card]')];
  const filterButtons = [...document.querySelectorAll('[data-blog-filter]')];
  const sidebarButtons = [...document.querySelectorAll('[data-sidebar-filter]')];
  const searchInput = document.querySelector('#blog-search-input');
  const emptyState = document.querySelector('[data-blog-empty]');
  if (!cards.length) return;

  let activeFilter = 'all';

  const normalize = (value) => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('vi')
    .trim();

  const update = () => {
    const query = normalize(searchInput?.value);
    let visibleCount = 0;

    cards.forEach((card) => {
      const categories = String(card.dataset.category || '').split(/\s+/);
      const searchText = normalize(`${card.dataset.search || ''} ${card.textContent || ''}`);
      const matchesFilter = activeFilter === 'all' || categories.includes(activeFilter);
      const matchesSearch = !query || searchText.includes(query);
      const isVisible = matchesFilter && matchesSearch;
      card.hidden = !isVisible;
      if (isVisible) visibleCount += 1;
    });

    filterButtons.forEach((button) => {
      const isActive = button.dataset.blogFilter === activeFilter;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    });
    if (emptyState) emptyState.hidden = visibleCount !== 0;
  };

  const chooseFilter = (filter, shouldScroll = false) => {
    activeFilter = filter || 'all';
    update();
    if (shouldScroll) document.querySelector('#thu-vien-bai-viet')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  filterButtons.forEach((button) => button.addEventListener('click', () => chooseFilter(button.dataset.blogFilter)));
  sidebarButtons.forEach((button) => button.addEventListener('click', () => chooseFilter(button.dataset.sidebarFilter, true)));
  searchInput?.addEventListener('input', update);
})();
