import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sendWelcomeEmail, welcomeEmailInternals } from '../src/welcome-email.mjs';

function preserveSmtpEnvironment() {
  const smtpUser = process.env.GMAIL_SMTP_USER;
  const appPassword = process.env.GMAIL_APP_PASSWORD;
  return () => {
    if (smtpUser === undefined) delete process.env.GMAIL_SMTP_USER;
    else process.env.GMAIL_SMTP_USER = smtpUser;
    if (appPassword === undefined) delete process.env.GMAIL_APP_PASSWORD;
    else process.env.GMAIL_APP_PASSWORD = appPassword;
  };
}

test('email chào mừng dùng Gmail SMTP và gửi đúng người vừa đăng ký', async () => {
  const restoreEnvironment = preserveSmtpEnvironment();
  process.env.GMAIL_SMTP_USER = 'realviewueh@gmail.com';
  process.env.GMAIL_APP_PASSWORD = 'test app password';
  let transportOptions;
  let message;

  try {
    const result = await sendWelcomeEmail({
      username: 'Buyer_01',
      email: 'Buyer@Example.com'
    }, {
      createTransportImpl(options) {
        transportOptions = options;
        return {
          async sendMail(value) {
            message = value;
            return { messageId: 'welcome-message-id' };
          }
        };
      }
    });

    assert.equal(transportOptions.host, 'smtp.gmail.com');
    assert.equal(transportOptions.port, 465);
    assert.equal(transportOptions.secure, true);
    assert.equal(transportOptions.auth.user, 'realviewueh@gmail.com');
    assert.equal(transportOptions.auth.pass, 'testapppassword');
    assert.equal(message.from, 'RealView <realviewueh@gmail.com>');
    assert.equal(message.to, 'buyer@example.com');
    assert.equal(message.subject, 'Chào mừng bạn đến với RealView');
    assert.match(message.text, /Xin chào Buyer_01/);
    assert.match(message.text, /trải nghiệm thật tuyệt vời/);
    assert.match(message.text, /quyết định mua sắm đúng đắn nhất/);
    assert.match(message.html, /Khám phá RealView/);
    assert.doesNotMatch(message.text, /không thực hiện đăng ký/i);
    assert.doesNotMatch(message.html, /mật khẩu/i);
    assert.deepEqual(result, { delivered: true, messageId: 'welcome-message-id' });
  } finally {
    restoreEnvironment();
  }
});

test('email chào mừng thoát an toàn nội dung tên đăng nhập', () => {
  const content = welcomeEmailInternals.welcomeEmailContent({ username: '<img src=x onerror=alert(1)>' });
  assert.doesNotMatch(content.html, /<img src=x/);
  assert.match(content.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('đăng ký gọi email chào mừng nhưng đăng nhập thì không', async () => {
  const authApi = await readFile(new URL('../api/auth.mjs', import.meta.url), 'utf8');
  assert.match(authApi, /const isRegistration = body\.action === 'register'/);
  assert.match(authApi, /isRegistration\s*\? await sendWelcomeEmail\(user\)/);
  assert.match(authApi, /welcomeEmailDelivered/);
});

