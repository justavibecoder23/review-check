(() => {
  const counters = [...document.querySelectorAll('[data-article-view-count][data-article-slug]')];
  if (!counters.length) return;

  const currentSlug = document.body.dataset.articleSlug || '';
  const formatter = new Intl.NumberFormat('vi-VN');
  const grouped = new Map();
  counters.forEach((counter) => {
    const slug = counter.dataset.articleSlug;
    if (!grouped.has(slug)) grouped.set(slug, []);
    grouped.get(slug).push(counter);
  });

  const render = (slug, views) => {
    const value = Math.max(0, Number(views) || 0);
    grouped.get(slug)?.forEach((counter) => {
      counter.textContent = `${formatter.format(value)} lượt xem`;
      counter.setAttribute('aria-label', `Bài viết có ${formatter.format(value)} lượt xem`);
    });
  };

  const load = async (slug) => {
    try {
      const response = await fetch(`/api/article-views?slug=${encodeURIComponent(slug)}`, {
        method: slug === currentSlug ? 'POST' : 'GET',
        headers: { accept: 'application/json' },
        credentials: 'same-origin'
      });
      if (!response.ok) throw new Error('view_count_unavailable');
      const payload = await response.json();
      render(slug, payload.views);
    } catch {
      grouped.get(slug)?.forEach((counter) => {
        counter.textContent = 'Lượt xem đang cập nhật';
        counter.setAttribute('aria-label', 'Lượt xem đang được cập nhật');
      });
    }
  };

  grouped.forEach((_, slug) => load(slug));
})();
