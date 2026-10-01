import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

const preview = new URL('../docs/previews/google-login/', import.meta.url);
const html = await readFile(new URL('index.html', preview), 'utf8');
const js = await readFile(new URL('preview.js', preview), 'utf8');
const css = await readFile(new URL('preview.css', preview), 'utf8');
const server = await readFile(new URL('../tools/google-login-preview-server.mjs', import.meta.url), 'utf8');

test('approval prototype is isolated from production and cannot authenticate', () => {
  assert.ok(html.includes('noindex,nofollow'));
  assert.ok(html.includes('Không nhập mật khẩu thật'));
  assert.ok(html.includes('Không kết nối Google/Redis'));
  for (const text of [html, js, server]) {
    assert.ok(!/fetch\s*\(|XMLHttpRequest|localStorage|sessionStorage|accounts\.google\.com\/gsi\/client|\/api\/auth/.test(text));
  }
  assert.ok(server.includes("'127.0.0.1'"));
  assert.ok(server.includes("'X-Robots-Tag', 'noindex, nofollow'"));
});

test('preview has Google above the existing password flow and separate legal links', () => {
  assert.ok(html.indexOf('class="google-signin"') < html.indexOf('<form id="auth-login-panel"'));
  assert.ok(html.includes('href="/dieu-khoan-su-dung">Điều khoản sử dụng'));
  assert.ok(html.includes('href="/chinh-sach-bao-mat">Chính sách bảo mật'));
  for (const state of ['login', 'register', 'link', 'email', 'error', 'cancel', 'success']) {
    assert.ok(html.includes(`value="${state}"`));
  }
  assert.ok(html.includes('role="status" aria-live="polite"'));
  assert.ok(html.includes('role="alert"'));
  assert.ok(html.includes('for="login-password"'));
  assert.ok(html.includes('id="login-password"'));
  assert.ok(!/type="checkbox"[^>]*emailMarketingConsent[^>]*checked/.test(html));
});

test('preview uses local brand assets and responsive, reduced-motion styles', async () => {
  await access(new URL('google-g.png', preview));
  await access(new URL('google-sans.ttf', preview));
  assert.ok(css.includes("'Google Sans'"));
  assert.ok(css.includes('max-width: 520px'));
  assert.ok(css.includes('prefers-reduced-motion'));
  assert.ok(css.includes('font-size: 16px') || html.includes('/auth.css'));
  assert.ok(js.includes('form.reset()'));
  assert.ok(js.includes('clearTimeout(timer)'));
});
