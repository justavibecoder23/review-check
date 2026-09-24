import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { emailBrandingUrls } from '../src/email-branding.mjs';
import { welcomeEmailInternals } from '../src/welcome-email.mjs';
import { emailVerificationMailInternals } from '../src/email-verification-mail.mjs';
import { passwordResetEmailInternals } from '../src/password-reset-email.mjs';
import { contactAcknowledgementEmailInternals } from '../src/contact-acknowledgement-email.mjs';

const root = new URL('../', import.meta.url);

test('các mẫu email dùng logo RealView, mascot và chỉ liên kết Facebook, TikTok, Threads', () => {
  const templates = [
    welcomeEmailInternals.welcomeEmailContent({ username: 'Minh Anh' }).html,
    emailVerificationMailInternals.verificationEmailContent('123456', 'register').html,
    passwordResetEmailInternals.passwordResetEmailContent('123456').html,
    contactAcknowledgementEmailInternals.contactAcknowledgementEmailContent({ name: 'Minh Anh' }).html
  ];

  for (const html of templates) {
    assert.ok(html.includes(emailBrandingUrls.logo));
    assert.ok(html.includes(emailBrandingUrls.facebook));
    assert.ok(html.includes(emailBrandingUrls.tiktok));
    assert.ok(html.includes(emailBrandingUrls.threads));
    assert.doesNotMatch(html, /instagram/i);
    assert.match(html, /color:#fc781f/);
    assert.match(html, /color:#31291d/);
    assert.match(html, /src="https:\/\/www\.realview\.com\.vn\/assets\/email\/realview-logo-mark\.png"/);
    assert.match(html, /width="89" height="50"/);
    assert.match(html, /@media \(max-width:599px\)/);
    assert.doesNotMatch(html, /<script\b|\son[a-z]+\s*=/i);
    assert.doesNotMatch(html, /http:\/\/TP\.HCM/i);
    for (const label of ['Website:', 'Email:', 'Facebook:', 'Threads:']) assert.ok(html.includes(label));
    assert.match(html, /TikTok:?/i);
  }
});

test('asset logo và mascot được tham chiếu trong email có sẵn trong thư mục public', () => {
  assert.equal(existsSync(fileURLToPath(new URL(`public/assets/email/${emailBrandingUrls.mascotWelcome.split('/').at(-1)}`, root))), true);
  assert.equal(existsSync(fileURLToPath(new URL(`public/assets/email/${emailBrandingUrls.mascotVerification.split('/').at(-1)}`, root))), true);
  assert.equal(existsSync(fileURLToPath(new URL(`public/assets/email/${emailBrandingUrls.logo.split('/').at(-1)}`, root))), true);
});

test('email chào mừng dẫn tới các điểm khám phá phụ đã yêu cầu', () => {
  const html = welcomeEmailInternals.welcomeEmailContent({ username: 'Minh Anh' }).html;
  assert.ok(html.includes(emailBrandingUrls.home));
  assert.ok(html.includes(emailBrandingUrls.blog));
  assert.ok(html.includes(emailBrandingUrls.contact));
  assert.ok(html.includes(emailBrandingUrls.criteria));
  assert.match(html, /Blog:<br>/);
  assert.match(html, /Nơi chia sẻ những kiến thức hữu ích/);
  assert.match(html, /Tiêu chí lọc review/);
  assert.match(html, /Liên hệ:<br>/);
  assert.match(html, /Nơi bạn có thể liên hệ với đội ngũ/);
  assert.match(html, />Trang chủ</);
  assert.match(html, />Blog</);
  assert.match(html, />Tiêu chí lọc</);
  assert.match(html, />Liên hệ</);
});

test('các mẫu mới thay placeholder động và loại bỏ script khỏi HTML dán vào', () => {
  const welcome = welcomeEmailInternals.welcomeEmailContent({ username: 'Minh Anh' }).html;
  const contact = contactAcknowledgementEmailInternals.contactAcknowledgementEmailContent({ name: 'Minh Anh' }).html;
  const verification = emailVerificationMailInternals.verificationEmailContent('123456', 'registration').html;
  const reset = passwordResetEmailInternals.passwordResetEmailContent('654321').html;

  assert.match(welcome, /Xin chào Minh Anh!/);
  assert.match(contact, /Chào <\/span><span[^>]*>Minh Anh<\/span>/);
  assert.match(verification, /Xác minh để tạo tài khoản/);
  assert.match(verification, />123456</);
  assert.match(reset, />654321</);
  for (const html of [welcome, contact, verification, reset]) {
    assert.doesNotMatch(html, /\{\{(?:USER_NAME|PURPOSE|VERIFICATION_CODE)\}\}|<script\b/i);
  }
});

test('footer có thể xuống dòng trên mobile và mã xác minh đủ lớn để dễ đọc', () => {
  const verification = emailVerificationMailInternals.verificationEmailContent('123456', 'registration').html;
  const reset = passwordResetEmailInternals.passwordResetEmailContent('654321').html;
  const welcome = welcomeEmailInternals.welcomeEmailContent({ username: 'Minh Anh' }).html;
  const contact = contactAcknowledgementEmailInternals.contactAcknowledgementEmailContent({ name: 'Minh Anh' }).html;

  for (const html of [welcome, contact, verification, reset]) {
    assert.match(html, /class="ecw" style="width:100%;max-width:600px;min-width:0;/);
    assert.doesNotMatch(html, /class="ecw" style="[^\"]*min-width:600px|class="ecw"[^>]*width="600"/);
    assert.match(html, /border-radius:999px;white-space:normal;overflow-wrap:anywhere;word-break:break-word/);
    assert.doesNotMatch(html, /border-radius:999px;display:inline-block;max-width:100%/);
    assert.doesNotMatch(html, /border-radius:999px;white-space:nowrap;max-width:100%/);
  }
  for (const html of [verification, reset]) {
    assert.match(html, /font-size:32px;letter-spacing:0\.08em;line-height:38px/);
    assert.match(html, /font-size:32px">(?:123456|654321)/);
  }
});
