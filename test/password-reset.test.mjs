import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sendPasswordResetEmail, passwordResetEmailInternals } from '../src/password-reset-email.mjs';

test('email đặt lại mật khẩu chỉ gửi mã 6 số qua Gmail SMTP', async () => {
  const previousUser = process.env.GMAIL_SMTP_USER;
  const previousPassword = process.env.GMAIL_APP_PASSWORD;
  process.env.GMAIL_SMTP_USER = 'realviewueh@gmail.com';
  process.env.GMAIL_APP_PASSWORD = 'test app password';
  let transportOptions;
  let message;
  try {
    const result = await sendPasswordResetEmail(
      { email: 'buyer@example.com' },
      '483920',
      {
        createTransportImpl(options) {
          transportOptions = options;
          return { sendMail: async (payload) => { message = payload; return { messageId: 'reset-1' }; } };
        }
      }
    );
    assert.equal(result.delivered, true);
    assert.equal(transportOptions.host, 'smtp.gmail.com');
    assert.equal(message.to, 'buyer@example.com');
    assert.match(message.text, /483920/);
    assert.match(message.html, /10 phút/);
    assert.doesNotMatch(message.text, /mật khẩu mới của bạn/i);
  } finally {
    if (previousUser === undefined) delete process.env.GMAIL_SMTP_USER;
    else process.env.GMAIL_SMTP_USER = previousUser;
    if (previousPassword === undefined) delete process.env.GMAIL_APP_PASSWORD;
    else process.env.GMAIL_APP_PASSWORD = previousPassword;
  }
});

test('API không trả mã xác minh về trình duyệt và giao diện có đủ hai bước', async () => {
  const [api, ui] = await Promise.all([
    readFile(new URL('../api/auth.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../public/auth.js', import.meta.url), 'utf8')
  ]);
  assert.match(api, /action === 'request_password_reset'/);
  assert.match(api, /sendPasswordResetEmail\(reset\.user, reset\.code\)/);
  assert.doesNotMatch(api, /code:\s*reset\.code/);
  assert.match(ui, /autocomplete="one-time-code"/);
  assert.match(ui, /data-auth-form="reset_password"/);
  assert.match(ui, /Mật khẩu nhập lại chưa trùng khớp/);
});

test('nội dung email từ chối mã sai định dạng', () => {
  assert.throws(() => passwordResetEmailInternals.passwordResetEmailContent('123'), /không hợp lệ/);
});

