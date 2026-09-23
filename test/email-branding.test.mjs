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
    assert.match(html, /<span style="color:#f05b16;font-family:Arial,Helvetica,sans-serif;">REAL<\/span><span style="color:#171717;font-family:Arial,Helvetica,sans-serif;">VIEW<\/span>/);
    assert.match(html, /font-family:Arial,Helvetica,sans-serif !important/);
    assert.match(html, /email-hero-mascot/);
    assert.match(html, /@media only screen and \(max-width:480px\)/);
    assert.match(html, /THÔNG TIN &amp; KẾT NỐI/);
    for (const label of ['Website:', 'Email:', 'Hotline:', 'Facebook:', 'TikTok:', 'Threads:']) assert.ok(html.includes(label));
  }
});

test('asset mascot được tham chiếu trong email có sẵn trong thư mục public', () => {
  assert.equal(existsSync(fileURLToPath(new URL(`public/assets/email/${emailBrandingUrls.mascotWelcome.split('/').at(-1)}`, root))), true);
  assert.equal(existsSync(fileURLToPath(new URL(`public/assets/email/${emailBrandingUrls.mascotVerification.split('/').at(-1)}`, root))), true);
});

test('email chào mừng dẫn tới các điểm khám phá phụ đã yêu cầu', () => {
  const html = welcomeEmailInternals.welcomeEmailContent({ username: 'Minh Anh' }).html;
  assert.ok(html.includes(emailBrandingUrls.home));
  assert.ok(html.includes(emailBrandingUrls.blog));
  assert.ok(html.includes(emailBrandingUrls.contact));
  assert.ok(html.includes(emailBrandingUrls.criteria));
  assert.match(html, /Blog<\/strong> để đọc hướng dẫn mua sắm/);
  assert.match(html, /Tiêu chí lọc<\/strong> để hiểu cách nhận diện/);
  assert.match(html, /trang <strong>Liên hệ<\/strong> để gửi câu hỏi/);
  assert.ok(html.includes('Đọc Blog RealView'));
  assert.ok(html.includes('Xem tiêu chí lọc'));
  assert.ok(html.includes('Liên hệ RealView'));
});
