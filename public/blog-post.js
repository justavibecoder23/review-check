(() => {
  const toc = document.querySelector('[data-article-toc]');
  const content = document.querySelector('.article-content');
  const tocScroller = toc?.querySelector('.article-toc-links');
  const list = toc?.querySelector('.article-toc-links ol');
  if (!toc || !content || !tocScroller || !list) return;

  const configuredHeadings = [...content.querySelectorAll(':scope > [data-toc-entry][id]')];
  const existingLinks = [...list.querySelectorAll('a[href^="#"]')];
  const existingHeadings = existingLinks
    .map((link) => document.getElementById(decodeURIComponent(link.hash.slice(1))))
    .filter(Boolean);
  const headings = existingHeadings.length
    ? existingHeadings
    : (configuredHeadings.length ? configuredHeadings : [...content.querySelectorAll(':scope > h2[id]')]);
  const links = new Map();
  const HEADING_SCROLL_OFFSET = 112;
  const ACTIVE_HEADING_THRESHOLD = 180;
  const SCROLL_SETTLE_DELAY = 160;
  let lockedId = '';
  let lockUntil = 0;
  let releaseLockTimer;

  const lockActiveHeading = (id) => {
    lockedId = id;
    lockUntil = performance.now() + 5000;
    setActive(id);
  };

  const scheduleLockRelease = () => {
    window.clearTimeout(releaseLockTimer);
    releaseLockTimer = window.setTimeout(() => {
      lockedId = '';
      lockUntil = 0;
      updateFromPosition();
    }, SCROLL_SETTLE_DELAY);
  };

  const scrollToHeading = (heading) => {
    const top = window.scrollY + heading.getBoundingClientRect().top - HEADING_SCROLL_OFFSET;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  };

  headings.forEach((heading, index) => {
    const item = document.createElement('li');
    const link = existingLinks[index] || document.createElement('a');
    if (!existingLinks[index]) {
      link.href = `#${heading.id}`;
      link.textContent = heading.textContent.trim();
    }
    link.addEventListener('click', (event) => {
      event.preventDefault();
      lockActiveHeading(heading.id);
      const hash = `#${heading.id}`;
      if (location.hash !== hash) history.pushState(null, '', hash);
      scrollToHeading(heading);
      scheduleLockRelease();
    });
    if (!existingLinks[index]) {
      item.append(link);
      list.append(item);
    }
    links.set(heading.id, link);
  });
  const trackedHeadings = [...headings].sort((left, right) => (
    left === right ? 0 : (left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
  ));

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

  if (!trackedHeadings.length) return;
  const updateFromPosition = () => {
    if (lockedId && performance.now() < lockUntil) {
      setActive(lockedId);
      return;
    }
    lockedId = '';
    const atPageEnd = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
    const current = atPageEnd ? trackedHeadings.at(-1) : trackedHeadings.reduce((active, heading) => (
      heading.getBoundingClientRect().top <= ACTIVE_HEADING_THRESHOLD ? heading : active
    ), trackedHeadings[0]);
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
  setActive(location.hash.slice(1) || trackedHeadings[0].id);

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(queuePositionUpdate, { rootMargin: '-100px 0px -72% 0px', threshold: [0, 1] });
    trackedHeadings.forEach((heading) => observer.observe(heading));
  }
  window.addEventListener('scroll', () => {
    if (lockedId) scheduleLockRelease();
    queuePositionUpdate();
  }, { passive: true });

  window.addEventListener('hashchange', () => {
    const id = location.hash.slice(1);
    if (links.has(id)) {
      lockActiveHeading(id);
      scheduleLockRelease();
    }
  });
})();
