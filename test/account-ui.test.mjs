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

test('cửa sổ tài khoản chỉ đóng bằng nút X', async () => {
  const auth = await readFile(new URL('../public/auth.js', import.meta.url), 'utf8');
  assert.match(auth, /addEventListener\('cancel', \(event\) => event\.preventDefault\(\)\)/);
  assert.doesNotMatch(auth, /event\.target === dialog\) closeAuthDialog/);
  assert.match(auth, /data-auth-close/);
});

test('form đăng ký có lựa chọn email marketing riêng và thông báo không làm gián đoạn trạng thái đăng nhập', async () => {
  const [auth, css, authApi] = await Promise.all([
    readFile(new URL('../public/auth.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/auth.css', import.meta.url), 'utf8'),
    readFile(new URL('../api/auth.mjs', import.meta.url), 'utf8')
  ]);
  assert.match(auth, /name="emailMarketingConsent" type="checkbox"/);
  assert.match(auth, /Đồng ý nhận email marketing từ RealView \(không bắt buộc\)/);
  assert.match(auth, /if \(payload\.showOfflineConsentNotice\) showOfflineConsentNotice\(currentUser\)/);
  assert.doesNotMatch(auth, /realview-offline-consent-notice|sessionStorage/);
  assert.match(authApi, /claimOfflineConsentNotice\(user\)/);
  assert.match(authApi, /showOfflineConsentNotice/);
  assert.match(auth, /if \(action === 'login'\) \{[\s\S]*showMarketingConsentPrompt\(currentUser\)/);
  assert.match(css, /\.account-consent-option/);
  assert.match(css, /\.account-consent-toast/);
});

test('lời mời email marketing chỉ bật sau đăng nhập và chỉ lưu khi người dùng đồng ý', async () => {
  const [auth, css, authApi] = await Promise.all([
    readFile(new URL('../public/auth.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/auth.css', import.meta.url), 'utf8'),
    readFile(new URL('../api/auth.mjs', import.meta.url), 'utf8')
  ]);
  assert.match(auth, /if \(action === 'login'\)[\s\S]*showMarketingConsentPrompt\(currentUser\)/);
  assert.match(auth, /user\?\.emailMarketingConsent\?\.status !== 'not_subscribed'/);
  assert.match(auth, /data-marketing-consent-accept/);
  assert.match(auth, /apiRequest\(\{ action: 'consent_email_marketing' \}\)/);
  assert.match(auth, /data-marketing-consent-dismiss/);
  assert.match(auth, /aria-labelledby="marketing-consent-title"/);
  assert.match(auth, /Hoàn toàn tự nguyện/);
  assert.match(authApi, /body\.action === 'consent_email_marketing'/);
  assert.match(authApi, /const sessionUser = await currentAccount\(request\)/);
  assert.match(authApi, /acceptEmailMarketingConsent\(sessionUser\.id\)/);
  assert.match(css, /\.marketing-consent-dialog::backdrop/);
  assert.match(css, /\.marketing-consent-accept/);
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
  assert.match(auth, /<span>Đăng nhập \/ Đăng ký<\/span>/);
  assert.equal((auth.match(/data-auth-open=/g) || []).length, 1);
  assert.match(authCss, /\.auth-button--access[\s\S]*background:\s*var\(--orange\)/);
  assert.match(styles, /\.header-contact[\s\S]*background:\s*rgba\(255,255,255,\.82\)/);
});

test('menu tài khoản chỉ hiện lối vào quản trị blog sau khi backend xác nhận quyền', async () => {
  const [auth, authCss, adminRoute, blogRouter, vercelConfig] = await Promise.all([
    readFile(new URL('../public/auth.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/auth.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/blog-admin-route.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../api/blog.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../vercel.json', import.meta.url), 'utf8')
  ]);
  assert.match(auth, /fetch\('\/api\/admin-blog\?action=access'/);
  assert.match(auth, /currentBlogCapabilities\?\.managePosts \? '<a class="account-admin-link" href="\/admin\/blog">/);
  assert.match(auth, /currentBlogCapabilities\?\.manageAccess \? '<a class="account-admin-link account-admin-link--access" href="\/admin\/access">/);
  assert.match(auth, /\['admin', 'editor'\]\.includes\(payload\.role\)/);
  assert.doesNotMatch(auth, /nhantrietka07@gmail\.com|realviewueh@gmail\.com/);
  assert.match(authCss, /\.account-popover \.account-admin-link/);
  assert.match(adminRoute, /action === 'access'/);
  assert.match(adminRoute, /authorized: true/);
  assert.match(blogRouter, /request\.query\?\.route/);
  assert.match(vercelConfig, /"destination": "\/api\/blog\.mjs\?route=admin"/);
  assert.doesNotMatch(vercelConfig, /"destination": "\/api\/blog\.mjs\?action=admin"/);
});

test('mobile luôn có nút liên hệ dạng icon với vùng chạm đạt chuẩn', async () => {
  const authCss = await readFile(new URL('../public/auth.css', import.meta.url), 'utf8');
  assert.match(authCss, /@media \(max-width: 900px\)[\s\S]*\.header-contact\s*\{[\s\S]*display:\s*inline-flex/);
  assert.match(authCss, /\.header-contact\s*\{[\s\S]*width:\s*44px[\s\S]*height:\s*44px/);
  assert.match(authCss, /\.header-contact span\s*\{\s*display:\s*none/);
  assert.doesNotMatch(authCss, /@media \(max-width: 900px\)\s*\{\s*\.header-contact\s*\{\s*display:\s*none/);
  assert.doesNotMatch(authCss, /\.header-inner > \.brand > span:not\(\.brand-mark\)\s*\{\s*display:\s*none/);
});

test('slogan và nội dung tổng hợp không dùng thông điệp tài chính', async () => {
  const [home, trustAnalysis] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/trust-analysis.mjs', import.meta.url), 'utf8')
  ]);
  assert.match(home, /hero-heading-line-primary">Tiết kiệm<\/span><span class="hero-heading-line">cho quyết định đúng<\/span>/);
  assert.doesNotMatch(home, /Tiết kiệm tiền cho/);
  assert.match(trustAnalysis, /Mức độ đáp ứng kỳ vọng/);
  assert.doesNotMatch(trustAnalysis, /Giá trị so với chi phí|số tiền đã bỏ ra/);
});

test('hai dòng tiêu đề hero đồng bộ cỡ chữ và icon liên hệ dùng path hoàn chỉnh', async () => {
  const [styles, contact] = await Promise.all([
    readFile(new URL('../public/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/contact.html', import.meta.url), 'utf8')
  ]);
  assert.match(styles, /\.hero-copy h1 \.hero-heading-line \+ \.hero-heading-line \{ margin-top: 10px; font-size: 1\.06em; \}/);
  assert.match(styles, /@media \(max-width: 700px\)[\s\S]*\.hero-copy h1 \.hero-heading-line \+ \.hero-heading-line \{ margin-top: 6px; \}/);
  assert.match(contact, /class="header-contact"[\s\S]*?<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v8Z"/);
  assert.doesNotMatch(contact, /class="header-contact"[\s\S]{0,400}a4 4 4 0 0 1/);
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

