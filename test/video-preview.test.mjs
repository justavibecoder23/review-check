import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../public/video-preview.js', import.meta.url), 'utf8');

test('tutorial reserves its original frame without an initial YouTube embed', async () => {
  const dom = new JSDOM(html);
  assert.equal(dom.window.document.querySelectorAll('.how-video iframe').length, 0);
  const preview = dom.window.document.querySelector('[data-video-preview]');
  assert.equal(preview.href, 'https://www.youtube.com/watch?v=qtVxLsrjLLs');
  assert.equal(preview.querySelector('img').getAttribute('width'), '960');
  assert.ok((await stat(new URL('../public/assets/realview-tutorial-poster-v1.webp', import.meta.url))).size < 60_000);
});

test('one click creates only one embed for the original video', () => {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  dom.window.eval(script);
  const preview = dom.window.document.querySelector('[data-video-preview]');
  preview.click();
  preview.click();
  const frames = dom.window.document.querySelectorAll('.how-video iframe');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].src, 'https://www.youtube-nocookie.com/embed/qtVxLsrjLLs?autoplay=1');
  assert.equal(frames[0].referrerPolicy, 'strict-origin-when-cross-origin');
  assert.equal(frames[0].allowFullscreen, true);
});

test('modified clicks keep native navigation without loading a player', () => {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  dom.window.eval(script);
  const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
  assert.equal(dom.window.document.querySelector('[data-video-preview]').dispatchEvent(event), true);
  assert.equal(dom.window.document.querySelectorAll('.how-video iframe').length, 0);
  dom.window.close();
});

test('analytics queues initial page view and every supported event without rescheduling GA', async () => {
  const analytics = await readFile(new URL('../public/analytics.js', import.meta.url), 'utf8');
  const dom = new JSDOM('<html><head></head><body></body></html>', { runScripts: 'outside-only' });
  let load;
  dom.window.requestIdleCallback = (callback, options) => {
    assert.equal(options.timeout, 2000);
    load = callback;
  };
  dom.window.eval(analytics);
  assert.equal(dom.window.dataLayer.length, 2);
  assert.equal(dom.window.dataLayer[1][0], 'config');
  assert.equal(dom.window.dataLayer[1][1], 'G-VRX4RKBXN6');
  for (const name of ['analysis_start', 'analysis_complete', 'analysis_error', 'sign_up', 'login', 'password_reset', 'generate_lead']) {
    dom.window.realviewTrackEvent(name, { marketplace: 'shopee' });
  }
  assert.equal(dom.window.dataLayer.length, 9);
  load();
  load();
  assert.equal(dom.window.document.querySelectorAll('script[src*="googletagmanager.com/gtag/js"]').length, 1);
  assert.equal(dom.window.dataLayer.filter((item) => item[0] === 'config').length, 1);
});
