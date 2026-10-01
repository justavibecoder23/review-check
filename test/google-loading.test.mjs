import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

test('slow Google preparation occupies the button slot and repeated prepare does not recreate it', async () => {
  const dom = new JSDOM(`<dialog open data-mode="login"><div data-google-option>
    <div data-google-button></div><p data-google-status hidden><span class="google-spinner" hidden></span><span data-google-status-text></span></p>
    <div data-google-error hidden><p></p></div>
    <form data-auth-form="register"><input name="claimGuestHistory" type="checkbox"></form>
  </div></dialog>`, { url: 'http://localhost:3146/' });
  const originals = Object.fromEntries(['window', 'document', 'ResizeObserver', 'fetch'].map(key => [key, globalThis[key]]));
  const calls = [], renders = [], initialized = [];
  let releaseConfig;
  const configReady = new Promise(resolve => { releaseConfig = resolve; });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document,
    ResizeObserver: class { observe() {} },
    fetch: async (url, options = {}) => {
      calls.push({ url, action: options.body && JSON.parse(options.body).action });
      if (!options.body) await configReady;
      return { ok: true, json: async () => options.body
        ? { challengeId: 'challenge', nonce: 'nonce', clientId: 'client', expiresIn: 300 }
        : { enabled: true, clientId: 'client' } };
    }
  });
  window.google = { accounts: { id: {
    initialize(config) { initialized.push(config); }, cancel() {}, disableAutoSelect() {},
    renderButton(slot, config) { renders.push(config); slot.append(document.createElement('button')); }
  } } };
  try {
    const { createGoogleLoginController } = await import('../public/google-login.js');
    const dialog = document.querySelector('dialog');
    const controller = createGoogleLoginController({ dialog, isBusy: () => false, setBusy() {}, setMode() {}, onSignedIn() {} });
    const first = controller.prepare(), duplicate = controller.prepare();
    assert.equal(document.querySelector('[data-google-option]').classList.contains('is-preparing'), true);
    assert.equal(document.querySelector('[data-google-status]').hidden, false);
    assert.equal(document.querySelector('[data-google-button]').childElementCount, 0);
    releaseConfig(); await Promise.all([first, duplicate]);
    assert.equal(renders.length, 1, 'Only one Google iframe is inserted for the initial open');
    assert.equal(document.querySelector('[data-google-status]').hidden, true);
    assert.equal(document.querySelector('[data-google-option]').classList.contains('is-preparing'), false);
    await controller.prepare();
    assert.equal(renders.length, 1);
    assert.equal(calls.length, 2);
    dialog.dataset.mode = 'register'; await controller.prepare();
    assert.equal(renders.at(-1).text, 'signup_with');
    assert.equal(calls.length, 2, 'Switching tabs does not show another network loading state');
    assert.equal(initialized.length, 1);
    controller.close(); await controller.prepare();
    assert.equal(renders.length, 3, 'Reopening recreates the cleared button only once');
  } finally { dom.window.close(); Object.assign(globalThis, originals); }
});

test('initial Google loading is positioned inside the reserved 44px button footprint', async () => {
  const css = await readFile(new URL('../public/auth.css', import.meta.url), 'utf8');
  assert.match(css, /\.google-button-slot\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /\.google-option\.is-preparing \.google-status\s*\{[^}]*position:\s*absolute;[^}]*min-height:\s*44px;[^}]*margin:\s*0;/);
});
