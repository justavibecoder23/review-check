import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createEmailVerification, verifyEmailCode } from '../src/email-verification.mjs';
import { sendEmailVerificationCode } from '../src/email-verification-mail.mjs';

function redisMock() {
  const values = new Map();
  return {
    values,
    fetchImpl: async (_url, options) => {
      const [command, key, value] = JSON.parse(options.body);
      const name = String(command).toUpperCase();
      let result;
      if (name === 'SET') { values.set(key, String(value)); result = 'OK'; }
      else if (name === 'GET') result = values.get(key) ?? null;
      else if (name === 'DEL') result = values.delete(key) ? 1 : 0;
      else throw new Error(`Unsupported command: ${name}`);
      return { ok: true, json: async () => ({ result }) };
    }
  };
}

async function withRedis(callback) {
  const oldUrl = process.env.UPSTASH_REDIS_REST_URL;
  const oldToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  try { return await callback(); }
  finally {
    if (oldUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = oldUrl;
    if (oldToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = oldToken;
  }
}

test('mã email đúng được dùng đúng một lần và gắn với nội dung yêu cầu', async () => withRedis(async () => {
  const mock = redisMock();
  const created = await createEmailVerification({
    purpose: 'registration', email: 'Buyer@Example.com', context: 'buyer|buyer@example.com'
  }, { fetchImpl: mock.fetchImpl });
  assert.match(created.code, /^\d{6}$/);
  assert.equal(created.email, 'buyer@example.com');

  await assert.rejects(
    verifyEmailCode({
      requestId: created.requestId, code: created.code, purpose: 'registration',
      email: created.email, context: 'changed-context'
    }, { fetchImpl: mock.fetchImpl }),
    /thông tin đã thay đổi/
  );
  const result = await verifyEmailCode({
    requestId: created.requestId, code: created.code, purpose: 'registration',
    email: created.email, context: 'buyer|buyer@example.com'
  }, { fetchImpl: mock.fetchImpl });
  assert.equal(result.verified, true);
  await assert.rejects(
    verifyEmailCode({
      requestId: created.requestId, code: created.code, purpose: 'registration',
      email: created.email, context: 'buyer|buyer@example.com'
    }, { fetchImpl: mock.fetchImpl }),
    /hết hạn/
  );
}));

test('email OTP dùng Gmail SMTP và không lộ mã qua API response', async () => {
  const oldUser = process.env.GMAIL_SMTP_USER;
  const oldPassword = process.env.GMAIL_APP_PASSWORD;
  process.env.GMAIL_SMTP_USER = 'realviewueh@gmail.com';
  process.env.GMAIL_APP_PASSWORD = 'test app password';
  let message;
  try {
    const result = await sendEmailVerificationCode('buyer@example.com', '381204', 'registration', {
      createTransportImpl: () => ({ sendMail: async (payload) => { message = payload; return { messageId: 'otp-1' }; } })
    });
    assert.equal(result.delivered, true);
    assert.equal(message.to, 'buyer@example.com');
    assert.match(message.text, /381204/);
    const [authApi, contactApi] = await Promise.all([
      readFile(new URL('../api/auth.mjs', import.meta.url), 'utf8'),
      readFile(new URL('../api/contact.mjs', import.meta.url), 'utf8')
    ]);
    assert.match(authApi, /request_registration_verification/);
    assert.match(contactApi, /request_verification/);
    assert.doesNotMatch(authApi, /code:\s*verification\.code/);
    assert.doesNotMatch(contactApi, /code:\s*verification\.code/);
  } finally {
    if (oldUser === undefined) delete process.env.GMAIL_SMTP_USER; else process.env.GMAIL_SMTP_USER = oldUser;
    if (oldPassword === undefined) delete process.env.GMAIL_APP_PASSWORD; else process.env.GMAIL_APP_PASSWORD = oldPassword;
  }
});

test('giao diện đăng ký và liên hệ đều yêu cầu mã dùng một lần', async () => {
  const [auth, contact, page] = await Promise.all([
    readFile(new URL('../public/auth.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/contact.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/contact.html', import.meta.url), 'utf8')
  ]);
  assert.match(auth, /data-auth-form="verify_registration"/);
  assert.match(auth, /request_registration_verification/);
  assert.match(contact, /action: requestingCode \? 'request_verification' : 'submit_contact'/);
  assert.match(page, /id="contact-code"/);
});
