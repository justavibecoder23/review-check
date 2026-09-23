import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/results.js', import.meta.url), 'utf8');
const loaderSource = source.slice(
  source.indexOf('function loadProductImage('),
  source.indexOf('\nfunction requestProductMedia(')
);

function classList(initial = []) {
  const values = new Set(initial);
  return {
    add: (value) => values.add(value),
    remove: (value) => values.delete(value),
    contains: (value) => values.has(value)
  };
}

function imageHarness({ existing = true } = {}) {
  const candidates = [];
  const timers = new Map();
  let nextTimer = 0;
  const image = {
    src: existing ? 'https://example.com/working.webp' : '',
    naturalWidth: existing ? 300 : 0,
    referrerPolicy: 'no-referrer',
    dataset: {},
    classList: classList(existing ? [] : ['hidden']),
    removeAttribute(name) { if (name === 'src') this.src = ''; }
  };
  const fallback = { classList: classList(existing ? ['hidden'] : []) };
  const skeletonTarget = { classList: classList(existing ? [] : ['is-skeleton']) };
  const context = {
    PRODUCT_IMAGE_TIMEOUT_MS: 20_000,
    productImageLoadSequence: 0,
    safeImageUrl: (value) => value || '',
    Image: class {
      constructor() {
        this.complete = false;
        this.naturalWidth = 0;
        candidates.push(this);
      }
    },
    window: {
      setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
      clearTimeout(id) { timers.delete(id); }
    }
  };
  runInNewContext(`${loaderSource}\nthis.loadProductImage = loadProductImage;`, context);
  return { ...context, image, fallback, skeletonTarget, candidates, timers };
}

test('a failed replacement keeps the previously visible product image', () => {
  const ui = imageHarness();
  ui.loadProductImage({
    image: ui.image,
    fallback: ui.fallback,
    skeletonTarget: ui.skeletonTarget,
    url: 'https://example.com/replacement.webp'
  });
  assert.equal(ui.image.src, 'https://example.com/working.webp');
  assert.equal(ui.image.classList.contains('hidden'), false);
  assert.equal(ui.fallback.classList.contains('hidden'), true);

  ui.candidates[0].onerror();
  assert.equal(ui.image.src, 'https://example.com/working.webp');
  assert.equal(ui.fallback.classList.contains('hidden'), true);
});

test('a timed-out replacement keeps the old image; a later successful URL replaces it', () => {
  const ui = imageHarness();
  const target = { image: ui.image, fallback: ui.fallback, skeletonTarget: ui.skeletonTarget };
  ui.loadProductImage({ ...target, url: 'https://example.com/hanging.webp' });
  [...ui.timers.values()][0]();
  assert.equal(ui.image.src, 'https://example.com/working.webp');
  assert.equal(ui.fallback.classList.contains('hidden'), true);

  ui.loadProductImage({ ...target, url: 'https://example.com/blob.webp' });
  ui.candidates[1].onload();
  assert.equal(ui.image.src, 'https://example.com/blob.webp');
  assert.equal(ui.fallback.classList.contains('hidden'), true);
});

test('the illustration remains when no product image has loaded yet', () => {
  const ui = imageHarness({ existing: false });
  ui.loadProductImage({
    image: ui.image,
    fallback: ui.fallback,
    url: 'https://example.com/broken.webp'
  });
  ui.candidates[0].onerror();
  assert.equal(ui.image.classList.contains('hidden'), true);
  assert.equal(ui.fallback.classList.contains('hidden'), false);
});

test('a slow image still replaces the illustration when it eventually loads', () => {
  const ui = imageHarness({ existing: false });
  ui.loadProductImage({
    image: ui.image,
    fallback: ui.fallback,
    url: 'https://example.com/slow-blob.webp'
  });
  assert.equal(ui.fallback.classList.contains('hidden'), false);
  ui.candidates[0].onload();
  assert.equal(ui.image.src, 'https://example.com/slow-blob.webp');
  assert.equal(ui.image.classList.contains('hidden'), false);
  assert.equal(ui.fallback.classList.contains('hidden'), true);
});
