import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmailTransport } from '../src/email-transport.mjs';

const ENV_KEYS = ['EMAIL_PROVIDER', 'EMAIL_FROM', 'RESEND_API_KEY', 'GMAIL_SMTP_USER', 'GMAIL_APP_PASSWORD'];

function withEnv(values, callback) {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    if (Object.hasOwn(values, key)) process.env[key] = values[key];
    else delete process.env[key];
  }
  try {
    callback();
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('Resend SMTP uses its API key, verified-domain sender, and TLS port', () => {
  withEnv({
    EMAIL_PROVIDER: 'resend',
    EMAIL_FROM: 'RealView <no-reply@realview.com.vn>',
    RESEND_API_KEY: 're_test_secret'
  }, () => {
    let transportOptions;
    const emailTransport = createEmailTransport({
      createTransportImpl(options) {
        transportOptions = options;
        return { sendMail() {} };
      }
    });

    assert.equal(emailTransport.from, 'RealView <no-reply@realview.com.vn>');
    assert.equal(transportOptions.host, 'smtp.resend.com');
    assert.equal(transportOptions.port, 465);
    assert.equal(transportOptions.secure, true);
    assert.deepEqual(transportOptions.auth, { user: 'resend', pass: 're_test_secret' });
  });
});

test('Resend does not send unless both key and sender are configured safely', () => {
  withEnv({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test_secret' }, () => {
    assert.equal(createEmailTransport({ createTransportImpl() { throw new Error('must not create transport'); } }), null);
  });

  withEnv({
    EMAIL_PROVIDER: 'resend',
    EMAIL_FROM: 'RealView <no-reply@realview.com.vn>\r\nBcc: attacker@example.com',
    RESEND_API_KEY: 're_test_secret'
  }, () => {
    assert.equal(createEmailTransport({ createTransportImpl() { throw new Error('must not create transport'); } }), null);
  });
});

test('unset provider keeps the current Gmail SMTP behavior', () => {
  withEnv({ GMAIL_SMTP_USER: 'realviewueh@gmail.com', GMAIL_APP_PASSWORD: 'test password' }, () => {
    let transportOptions;
    const emailTransport = createEmailTransport({
      createTransportImpl(options) {
        transportOptions = options;
        return {};
      }
    });

    assert.equal(emailTransport.from, 'RealView <realviewueh@gmail.com>');
    assert.equal(transportOptions.host, 'smtp.gmail.com');
    assert.deepEqual(transportOptions.auth, { user: 'realviewueh@gmail.com', pass: 'testpassword' });
  });
});

