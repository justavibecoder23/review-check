import { validateMarketplaceInput } from './url-validation.js';

const form = document.querySelector('#analyze-form');
const input = document.querySelector('#product-url');
const errorBox = document.querySelector('#form-error');
const backToTop = document.querySelector('.back-to-top');

function showInputError(message, { focus = false } = {}) {
  if (!form || !input || !errorBox) return;
  form.classList.add('is-invalid');
  input.setAttribute('aria-invalid', 'true');
  errorBox.textContent = message;
  errorBox.classList.remove('hidden');
  if (focus) input.focus({ preventScroll: true });
}

function clearInputError() {
  if (!form || !input || !errorBox) return;
  form.classList.remove('is-invalid');
  input.setAttribute('aria-invalid', 'false');
  errorBox.classList.add('hidden');
  errorBox.textContent = '';
}

function validateCurrentInput({ focus = false, allowEmpty = false } = {}) {
  const value = input?.value || '';
  if (allowEmpty && !value.trim()) {
    clearInputError();
    return null;
  }
  const validation = validateMarketplaceInput(value);
  if (!validation.valid) {
    showInputError(validation.message, { focus });
    return null;
  }
  clearInputError();
  return validation;
}

input?.addEventListener('input', () => {
  validateCurrentInput({ allowEmpty: true });
});
input?.addEventListener('blur', () => {
  if (input.value.trim()) validateCurrentInput();
});

const navLinks = [...document.querySelectorAll('.main-nav .nav-parent[href^="#"]')];
const navIndicator = document.querySelector('.nav-indicator');
const mainNav = document.querySelector('.main-nav');
const siteHeader = document.querySelector('.site-header');
const navToggle = document.querySelector('.nav-toggle');
const navToggleLabel = document.querySelector('.nav-toggle-label');
const navSections = navLinks
  .map((link) => document.querySelector(link.hash))
  .filter(Boolean);
let indicatorAnimation;
let activeNavId;

function updateBackToTop() {
  if (!backToTop) return;
  backToTop.classList.toggle('is-visible', window.scrollY > 400);
}

backToTop?.addEventListener('click', () => {
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
window.addEventListener('scroll', updateBackToTop, { passive: true });
updateBackToTop();

function setMobileMenu(open) {
  if (!siteHeader || !navToggle) return;
  siteHeader.classList.toggle('is-menu-open', open);
  navToggle.setAttribute('aria-expanded', String(open));
  if (navToggleLabel) navToggleLabel.textContent = open ? 'Đóng menu' : 'Mở menu';
}

if (navToggle) {
  navToggle.addEventListener('click', () => {
    setMobileMenu(navToggle.getAttribute('aria-expanded') !== 'true');
  });
  document.addEventListener('click', (event) => {
    if (siteHeader?.classList.contains('is-menu-open') && !siteHeader.contains(event.target)) setMobileMenu(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setMobileMenu(false);
  });
}

function moveNavIndicator(targetLink, shouldAnimate = true) {
  if (!navIndicator || !mainNav || !targetLink || targetLink.offsetParent === null) return;

  const targetX = targetLink.getBoundingClientRect().left - mainNav.getBoundingClientRect().left;
  const targetWidth = targetLink.offsetWidth;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canAnimate = shouldAnimate && navIndicator.dataset.ready && !reduceMotion && navIndicator.animate;

  if (!canAnimate) {
    indicatorAnimation?.cancel();
    navIndicator.style.width = `${targetWidth}px`;
    navIndicator.style.borderRadius = '11px';
    navIndicator.style.transform = `translate3d(${targetX}px, 0, 0)`;
    navIndicator.dataset.ready = 'true';
    return;
  }

  const computedStyle = window.getComputedStyle(navIndicator);
  const currentMatrix = new DOMMatrixReadOnly(computedStyle.transform);
  const currentX = currentMatrix.m41;
  const currentWidth = Number.parseFloat(computedStyle.width) || targetWidth;
  const circleSize = 38;
  const circleStartX = currentX + (currentWidth - circleSize) / 2;
  const circleEndX = targetX + (targetWidth - circleSize) / 2;

  indicatorAnimation?.cancel();
  indicatorAnimation = navIndicator.animate([
    { width: `${currentWidth}px`, borderRadius: '11px', transform: `translate3d(${currentX}px, 0, 0)`, offset: 0 },
    { width: `${circleSize}px`, borderRadius: '50%', transform: `translate3d(${circleStartX}px, -3px, 0)`, offset: .24 },
    { width: `${circleSize}px`, borderRadius: '50%', transform: `translate3d(${circleEndX}px, -3px, 0)`, offset: .72 },
    { width: `${targetWidth}px`, borderRadius: '11px', transform: `translate3d(${targetX}px, 0, 0)`, offset: 1 },
  ], {
    duration: 520,
    easing: 'cubic-bezier(.22, 1, .36, 1)',
  });

  indicatorAnimation.onfinish = () => {
    navIndicator.style.width = `${targetWidth}px`;
    navIndicator.style.borderRadius = '11px';
    navIndicator.style.transform = `translate3d(${targetX}px, 0, 0)`;
    indicatorAnimation = undefined;
  };
}

function setActiveNav(sectionId, shouldAnimate = true) {
  const targetLink = navLinks.find((link) => link.hash === `#${sectionId}`);
  if (!targetLink) return;
  const sectionChanged = activeNavId !== sectionId;
  activeNavId = sectionId;

  navLinks.forEach((link) => {
    const isActive = link === targetLink;
    link.classList.toggle('is-active', isActive);
    if (isActive) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  moveNavIndicator(targetLink, shouldAnimate && sectionChanged);
}

if (navSections.length) {
  const initialSection = navSections.find((section) => `#${section.id}` === window.location.hash) || navSections[0];
  setActiveNav(initialSection.id, false);

  const sectionObserver = new IntersectionObserver((entries) => {
    const currentSection = entries.find((entry) => entry.isIntersecting);
    if (currentSection) setActiveNav(currentSection.target.id);
  }, {
    rootMargin: '-22% 0px -68% 0px',
    threshold: 0,
  });

  navSections.forEach((section) => sectionObserver.observe(section));
  navLinks.forEach((link) => link.addEventListener('click', () => {
    setActiveNav(link.hash.slice(1));
    setMobileMenu(false);
  }));
  window.addEventListener('resize', () => {
    if (window.innerWidth > 900) setMobileMenu(false);
    const activeLink = navLinks.find((link) => link.classList.contains('is-active'));
    if (activeLink) moveNavIndicator(activeLink, false);
  });
}

if (form) form.addEventListener('submit', (event) => {
  event.preventDefault();
  const validation = validateCurrentInput({ focus: true });
  if (!validation) return;
  window.location.assign(`/results.html?url=${encodeURIComponent(validation.url)}`);
});
