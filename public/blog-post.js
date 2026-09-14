(() => {
  const toc = document.querySelector('[data-article-toc]');
  const content = document.querySelector('.article-content');
  const tocScroller = toc?.querySelector('.article-toc-links');
  const list = toc?.querySelector('.article-toc-links ol');
  if (!toc || !content || !tocScroller || !list) return;

  const headings = [...content.querySelectorAll(':scope > h2[id]')];
  const links = new Map();
  let lockedId = '';
  let lockUntil = 0;

  const lockActiveHeading = (id) => {
    lockedId = id;
    lockUntil = performance.now() + 5000;
    setActive(id);
  };

  headings.forEach((heading) => {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = `#${heading.id}`;
    link.textContent = heading.textContent.trim();
    link.addEventListener('click', () => {
      lockActiveHeading(heading.id);
    });
    item.append(link);
    list.append(item);
    links.set(heading.id, link);
  });

  const desktopQuery = window.matchMedia('(min-width: 1025px)');
  const syncTocState = ({ matches }) => {
    if (matches) toc.setAttribute('open', '');
    else toc.removeAttribute('open');
  };
  syncTocState(desktopQuery);
  desktopQuery.addEventListener('change', syncTocState);

  const keepLinkVisible = (link) => {
    if (!toc.open || !tocScroller.clientHeight) return;
    const scrollerRect = tocScroller.getBoundingClientRect();
    const linkRect = link.getBoundingClientRect();
    if (linkRect.top < scrollerRect.top + 8) {
      tocScroller.scrollTo({ top: tocScroller.scrollTop + linkRect.top - scrollerRect.top - 12, behavior: 'smooth' });
    } else if (linkRect.bottom > scrollerRect.bottom - 8) {
      tocScroller.scrollTo({ top: tocScroller.scrollTop + linkRect.bottom - scrollerRect.bottom + 12, behavior: 'smooth' });
    }
  };

  const setActive = (id) => {
    let activeLink;
    links.forEach((link, linkId) => {
      const active = linkId === id;
      link.classList.toggle('is-active', active);
      if (active) {
        link.setAttribute('aria-current', 'location');
        activeLink = link;
      }
      else link.removeAttribute('aria-current');
    });
    if (activeLink) keepLinkVisible(activeLink);
  };

  if (!headings.length) return;
  const updateFromPosition = () => {
    if (lockedId && performance.now() < lockUntil) {
      const lockedHeading = document.getElementById(lockedId);
      const distanceFromAnchor = Math.abs((lockedHeading?.getBoundingClientRect().top ?? 0) - 112);
      if (distanceFromAnchor > 32) {
        setActive(lockedId);
        return;
      }
    }
    lockedId = '';
    const atPageEnd = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
    const current = atPageEnd ? headings.at(-1) : headings.reduce((active, heading) => (
      heading.getBoundingClientRect().top <= 180 ? heading : active
    ), headings[0]);
    setActive(current.id);
  };
  let updateQueued = false;
  const queuePositionUpdate = () => {
    if (updateQueued) return;
    updateQueued = true;
    requestAnimationFrame(() => {
      updateFromPosition();
      updateQueued = false;
    });
  };
  setActive(location.hash.slice(1) || headings[0].id);

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(queuePositionUpdate, { rootMargin: '-100px 0px -72% 0px', threshold: [0, 1] });
    headings.forEach((heading) => observer.observe(heading));
  }
  window.addEventListener('scroll', queuePositionUpdate, { passive: true });

  window.addEventListener('hashchange', () => {
    const id = location.hash.slice(1);
    if (links.has(id)) {
      lockActiveHeading(id);
    }
  });
})();
