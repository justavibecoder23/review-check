import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('các trang chính nạp giao diện tài khoản và khóa lịch sử cho khách', async () => {
  const pages = await Promise.all(
    ['index.html', 'results.html', 'criteria.html', 'contact.html']
      .map((name) => readFile(new URL(`../public/${name}`, import.meta.url), 'utf8'))
  );
  for (const page of pages) {
    assert.match(page, /\/auth\.css/);
    assert.match(page, /\/auth\.js/);
    assert.match(page, /\/history-ui\.js/);
    assert.match(page, /class="header-utilities"/);
  }
  const historyUi = await readFile(new URL('../public/history-ui.js', import.meta.url), 'utf8');
  assert.match(historyUi, /Vui lòng đăng ký tài khoản để kích hoạt tính năng lịch sử phân tích/);
  assert.match(historyUi, /getCurrentUser/);
});

test('mật khẩu chỉ gửi tới API và không được lưu trong mã giao diện', async () => {
  const auth = await readFile(new URL('../public/auth.js', import.meta.url), 'utf8');
  const history = await readFile(new URL('../public/history-manager.js', import.meta.url), 'utf8');
  assert.match(auth, /autocomplete="current-password"/);
  assert.match(auth, /autocomplete="new-password"/);
  assert.doesNotMatch(auth, /localStorage\.setItem\([^)]*password/i);
  assert.doesNotMatch(history, /localStorage/);
});

test('các nút tiện ích trên header desktop có cùng kích thước', async () => {
  const css = await readFile(new URL('../public/auth.css', import.meta.url), 'utf8');
  assert.match(css, /\.header-utilities \.header-actions \.chatbot-trigger/);
  assert.match(css, /\.header-utilities \.header-actions \.header-contact/);
  assert.match(css, /\.header-utilities \.header-auth \.auth-button/);
  assert.match(css, /width:\s*clamp\(108px,\s*7\.2vw,\s*126px\)/);
  assert.match(css, /height:\s*46px/);
});

test('khách chỉ thấy một nút tài khoản màu cam và nút liên hệ màu trắng', async () => {
  const auth = await readFile(new URL('../public/auth.js', import.meta.url), 'utf8');
  const authCss = await readFile(new URL('../public/auth.css', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(auth, />Đăng nhập \/ Đăng ký<\/button>/);
  assert.equal((auth.match(/data-auth-open=/g) || []).length, 1);
  assert.match(authCss, /\.auth-button--access[\s\S]*background:\s*var\(--orange\)/);
  assert.match(styles, /\.header-contact[\s\S]*background:\s*rgba\(255,255,255,\.82\)/);
});

test('biểu mẫu liên hệ gửi trực tiếp và dùng email RealView mới', async () => {
  const page = await readFile(new URL('../public/contact.html', import.meta.url), 'utf8');
  const script = await readFile(new URL('../public/contact.js', import.meta.url), 'utf8');
  assert.match(page, /realviewueh@gmail\.com/);
  assert.doesNotMatch(page, /reviewcheckteam@gmail\.com/);
  assert.doesNotMatch(page, /action="mailto:/);
  assert.match(page, />Gửi liên hệ/);
  assert.match(script, /fetch\('\/api\/contact'/);
  assert.match(script, /payload\.delivered/);
  assert.match(script, /email chuyển tiếp chưa gửi được/);
});

