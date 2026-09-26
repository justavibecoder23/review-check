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

(() => {
  const title = document.querySelector('.article-title');
  const sidebarCta = document.querySelector('.article-sidebar-cta');
  if (!title || !sidebarCta) return;

  const ASSET_ROOT = '/assets/mascot/';
  const titleFrames = [
    ['relaxed', 'realviewee-blog-title-relaxed-v1.png'],
    ['inspect', 'realviewee-blog-title-inspect-v1.png'],
    ['surprised', 'realviewee-blog-title-surprised-v2.png'],
  ];
  const ctaFrames = [
    ['thinking', 'realviewee-blog-cta-thinking-v1.png'],
    ['point', 'realviewee-blog-cta-point-v1.png'],
    ['happy', 'realviewee-blog-cta-happy-v1.png'],
  ];
  const timers = [];
  const BLOG_MASCOT_ACTION_DURATION = 4_000;
  const schedule = (callback, delay) => timers.push(window.setTimeout(callback, delay));
  const frameMarkup = (frames) => frames.map(([pose, file]) => (
    `<img class="article-blog-mascot-pose" data-blog-mascot-pose="${pose}" src="${ASSET_ROOT}${file}" alt="" width="657" height="768" decoding="async" />`
  )).join('');

  const titleZone = document.createElement('div');
  titleZone.className = 'article-title-zone';
  title.before(titleZone);
  titleZone.append(title);
  titleZone.insertAdjacentHTML('beforeend', `
    <span class="article-title-mascot" data-blog-title-mascot aria-hidden="true">
      <span class="article-title-mascot-bubble"></span>
      ${frameMarkup(titleFrames)}
    </span>`);

  const ctaMascot = document.createElement('div');
  ctaMascot.className = 'article-cta-mascot';
  ctaMascot.setAttribute('data-blog-cta-mascot', '');
  ctaMascot.innerHTML = `
    <span class="article-cta-mascot-bubble" role="status">Chúc bạn đọc blog vui vẻ, nhớ dùng RealView nha!</span>
    <span class="article-cta-mascot-frame" aria-hidden="true">
      ${frameMarkup(ctaFrames)}
    </span>`;
  sidebarCta.after(ctaMascot);

  const titleMascot = titleZone.querySelector('[data-blog-title-mascot]');
  const titleBubble = titleMascot.querySelector('.article-title-mascot-bubble');
  const bubble = ctaMascot.querySelector('.article-cta-mascot-bubble');
  const allImages = [...titleMascot.querySelectorAll('img'), ...ctaMascot.querySelectorAll('img')];
  const setPose = (stage, pose) => {
    stage.dataset.pose = pose;
    stage.querySelectorAll('[data-blog-mascot-pose]').forEach((frame) => {
      frame.classList.toggle('is-active', frame.dataset.blogMascotPose === pose);
    });
  };
  const show = (stage) => stage.classList.add('is-visible');
  const hide = (stage) => stage.classList.remove('is-visible');
  const setTitleSpeech = (text = '') => {
    titleBubble.classList.remove('is-visible');
    if (!text) return;
    schedule(() => {
      titleBubble.textContent = text;
      titleBubble.classList.add('is-visible');
    }, 200);
  };
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const startSequence = () => {
    if (reducedMotion) {
      setPose(ctaMascot, 'happy');
      show(ctaMascot);
      bubble.classList.add('is-visible');
      return;
    }

    setPose(titleMascot, 'relaxed');
    show(titleMascot);
    schedule(() => {
      setPose(titleMascot, 'inspect');
      setTitleSpeech('Gì đây ta??');
    }, BLOG_MASCOT_ACTION_DURATION);
    schedule(() => {
      setPose(titleMascot, 'surprised');
      setTitleSpeech('Woww, bài này hay ghê!');
    }, BLOG_MASCOT_ACTION_DURATION * 2);
    schedule(() => {
      setTitleSpeech();
      hide(titleMascot);
    }, BLOG_MASCOT_ACTION_DURATION * 3);

    schedule(() => {
      setPose(ctaMascot, 'thinking');
      show(ctaMascot);
    }, BLOG_MASCOT_ACTION_DURATION * 3 + 400);
    schedule(() => setPose(ctaMascot, 'point'), BLOG_MASCOT_ACTION_DURATION * 4 + 400);
    schedule(() => {
      setPose(ctaMascot, 'happy');
      bubble.classList.add('is-visible');
    }, BLOG_MASCOT_ACTION_DURATION * 5 + 400);
  };

  Promise.all(allImages.map((image) => (
    image.complete ? Promise.resolve() : image.decode?.().catch(() => undefined)
  ))).then(startSequence);
  window.addEventListener('pagehide', () => timers.forEach((timer) => window.clearTimeout(timer)), { once: true });
})();
