import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contactStoreInternals,
  saveContactMessage,
  sendContactNotification
} from '../src/contact-store.mjs';

test('liên hệ được kiểm tra và lưu vào hộp thư dữ liệu RealView', async () => {
  const previousUrl = process.env.UPSTASH_REDIS_REST_URL;
  const previousToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  let commands;
  try {
    const record = await saveContactMessage({
      name: 'Nguyễn Văn A',
      email: 'USER@Example.com',
      message: 'Mình muốn góp ý về kết quả phân tích.'
    }, {
      fetchImpl: async (_url, options) => {
        commands = JSON.parse(options.body);
        return { ok: true, json: async () => commands.map(() => ({ result: 'OK' })) };
      }
    });
    assert.equal(record.email, 'user@example.com');
    assert.equal(commands[0][0], 'RPUSH');
    assert.equal(commands[0][1], contactStoreInternals.CONTACT_INBOX_KEY);
    assert.match(commands[0][2], /Mình muốn góp ý/);
    assert.equal(commands[2][1], contactStoreInternals.CONTACT_EMAILS_KEY);
  } finally {
    if (previousUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = previousUrl;
    if (previousToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = previousToken;
  }
});

test('không giả vờ gửi email khi chưa có khóa dịch vụ', async () => {
  const previousUser = process.env.GMAIL_SMTP_USER;
  const previousPassword = process.env.GMAIL_APP_PASSWORD;
  delete process.env.GMAIL_SMTP_USER;
  delete process.env.GMAIL_APP_PASSWORD;
  try {
    const result = await sendContactNotification({
      name: 'Nguyễn Văn A',
      email: 'user@example.com',
      message: 'Nội dung liên hệ',
      createdAt: new Date().toISOString()
    });
    assert.deepEqual(result, { delivered: false, reason: 'not_configured' });
  } finally {
    if (previousUser !== undefined) process.env.GMAIL_SMTP_USER = previousUser;
    if (previousPassword !== undefined) process.env.GMAIL_APP_PASSWORD = previousPassword;
  }
});

test('gửi liên hệ qua Gmail SMTP và đặt người gửi làm địa chỉ phản hồi', async () => {
  const previousUser = process.env.GMAIL_SMTP_USER;
  const previousPassword = process.env.GMAIL_APP_PASSWORD;
  process.env.GMAIL_SMTP_USER = 'realviewueh@gmail.com';
  process.env.GMAIL_APP_PASSWORD = 'test app password';
  let transportOptions;
  let mail;
  try {
    const result = await sendContactNotification({
      name: 'Nguyễn Văn A',
      email: 'user@example.com',
      message: 'Nội dung liên hệ',
      createdAt: '2026-09-08T08:00:00.000Z'
    }, {
      createTransportImpl(options) {
        transportOptions = options;
        return {
          async sendMail(message) {
            mail = message;
            return { messageId: 'gmail-message-id' };
          }
        };
      }
    });

    assert.equal(transportOptions.host, 'smtp.gmail.com');
    assert.equal(transportOptions.port, 465);
    assert.equal(transportOptions.secure, true);
    assert.equal(transportOptions.auth.user, 'realviewueh@gmail.com');
    assert.equal(transportOptions.auth.pass, 'testapppassword');
    assert.equal(mail.to, 'realviewueh@gmail.com');
    assert.equal(mail.replyTo, 'user@example.com');
    assert.deepEqual(result, { delivered: true, messageId: 'gmail-message-id' });
  } finally {
    if (previousUser === undefined) delete process.env.GMAIL_SMTP_USER;
    else process.env.GMAIL_SMTP_USER = previousUser;
    if (previousPassword === undefined) delete process.env.GMAIL_APP_PASSWORD;
    else process.env.GMAIL_APP_PASSWORD = previousPassword;
  }
});

