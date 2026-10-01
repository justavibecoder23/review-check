// Progressive enhancement only: all document content and links exist in HTML.
(() => {
  const links = [...document.querySelectorAll('.legal-toc a[href^="#"]')];
  const sections = links.map((link) => document.getElementById(link.hash.slice(1))).filter(Boolean);
  if (!sections.length || !('IntersectionObserver' in window)) return;
  const markCurrent = (id) => links.forEach((link) => {
    if (link.hash === `#${id}`) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  });
  const visible = new Set();
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => entry.isIntersecting ? visible.add(entry.target.id) : visible.delete(entry.target.id));
    const first = sections.find((section) => visible.has(section.id));
    if (first) markCurrent(first.id);
  }, { rootMargin: '-180px 0px -35% 0px', threshold: 0 });
  sections.forEach((section) => observer.observe(section));
  links.forEach((link) => link.addEventListener('click', () => markCurrent(link.hash.slice(1))));
})();
