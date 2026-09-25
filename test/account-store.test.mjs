import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptEmailMarketingConsent,
  authenticateAccount,
  claimOfflineConsentNotice,
  createPasswordReset,
  createAccountSession,
  getAccountFromSession,
  getAccountHistoryItem,
  listAccountHistory,
  registerAccount,
  resetAccountPassword,
  saveAccountHistory
} from '../src/account-store.mjs';

function redisMock() {
  const strings = new Map();
  const sets = new Map();
  const sorted = new Map();

  function range(values, startValue, stopValue, reverse = false) {
    const ordered = [...values.entries()]
      .sort((left, right) => left[1] - right[1])
      .map(([member]) => member);
    if (reverse) ordered.reverse();
    const start = Number(startValue);
    const rawStop = Number(stopValue);
    const stop = rawStop < 0 ? ordered.length + rawStop : rawStop;
    return ordered.slice(start, stop + 1);
  }

  function command(parts) {
    const [name, ...args] = parts;
    switch (String(name).toUpperCase()) {
      case 'SET': {
        const [key, value] = args;
        if (args.includes('NX') && strings.has(key)) return null;
        strings.set(key, String(value));
        return 'OK';
      }
      case 'GET':
        return strings.get(args[0]) ?? null;
      case 'DEL': {
        let deleted = 0;
        for (const key of args) {
          deleted += strings.delete(key) ? 1 : 0;
          deleted += sorted.delete(key) ? 1 : 0;
        }
        return deleted;
      }
      case 'SADD': {
        const [key, ...members] = args;
        const value = sets.get(key) || new Set();
        const before = value.size;
        members.forEach((member) => value.add(member));
        sets.set(key, value);
        return value.size - before;
      }
      case 'ZADD': {
        const [key, score, member] = args;
        const value = sorted.get(key) || new Map();
        value.set(String(member), Number(score));
        sorted.set(key, value);
        return 1;
      }
      case 'ZRANGE':
        return range(sorted.get(args[0]) || new Map(), args[1], args[2]);
      case 'ZREVRANGE':
        return range(sorted.get(args[0]) || new Map(), args[1], args[2], true);
      case 'ZREM': {
        const [key, ...members] = args;
        const value = sorted.get(key) || new Map();
        let deleted = 0;
        members.forEach((member) => { deleted += value.delete(String(member)) ? 1 : 0; });
        return deleted;
      }
      case 'MGET':
        return args.map((key) => strings.get(key) ?? null);
      default:
        throw new Error(`Unsupported Redis command in test: ${name}`);
    }
  }

  return {
    strings,
    sets,
    fetchImpl: async (url, options) => {
      const input = JSON.parse(options.body);
      const result = url.endsWith('/multi-exec')
        ? input.map((parts) => ({ result: command(parts) }))
        : { result: command(input) };
      return { ok: true, json: async () => result };
    }
  };
}

test('đăng ký lưu email riêng, mật khẩu băm và đăng nhập bằng username', async () => {
  const previousUrl = process.env.UPSTASH_REDIS_REST_URL;
  const previousToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const mock = redisMock();
  try {
    const user = await registerAccount({
      email: 'Buyer@Example.com',
      username: 'Buyer_01',
      password: 'mat-khau-an-toan'
    }, { fetchImpl: mock.fetchImpl });

    assert.equal(user.email, 'buyer@example.com');
    assert.equal(user.username, 'Buyer_01');
    assert.equal('passwordHash' in user, false);
    assert.equal(mock.sets.get('realview:account:v1:emails').has('buyer@example.com'), true);
    const stored = JSON.parse(mock.strings.get(`realview:account:v1:user:${user.id}`));
    assert.match(stored.passwordHash, /^scrypt\$/);
    assert.notEqual(stored.passwordHash, 'mat-khau-an-toan');

    const authenticated = await authenticateAccount({
      username: 'buyer_01',
      password: 'mat-khau-an-toan'
    }, { fetchImpl: mock.fetchImpl });
    assert.equal(authenticated.id, user.id);

    const session = await createAccountSession(user, { fetchImpl: mock.fetchImpl });
    const fromSession = await getAccountFromSession(session.token, { fetchImpl: mock.fetchImpl });
    assert.equal(fromSession.username, 'Buyer_01');
  } finally {
    if (previousUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = previousUrl;
    if (previousToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = previousToken;
  }
});

test('lựa chọn email marketing được lưu riêng và tài khoản cũ dùng trạng thái đã đồng ý ngoại tuyến', async () => {
  const previousUrl = process.env.UPSTASH_REDIS_REST_URL;
  const previousToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const mock = redisMock();
  try {
    const optedIn = await registerAccount({
      email: 'opted-in@example.com', username: 'OptedIn_01', password: 'mat-khau-an-toan', emailMarketingConsent: true
    }, { fetchImpl: mock.fetchImpl });
    assert.equal(optedIn.emailMarketingConsent.status, 'subscribed');
    assert.equal(optedIn.emailMarketingConsent.source, 'registration_form');
    assert.ok(optedIn.emailMarketingConsent.consentedAt);

    const optedOut = await registerAccount({
      email: 'opted-out@example.com', username: 'OptedOut_01', password: 'mat-khau-an-toan'
    }, { fetchImpl: mock.fetchImpl });
    assert.deepEqual(optedOut.emailMarketingConsent, {
      status: 'not_subscribed', source: 'registration_form', consentedAt: null
    });

    const userKey = `realview:account:v1:user:${optedOut.id}`;
    const legacyRecord = JSON.parse(mock.strings.get(userKey));
    delete legacyRecord.emailMarketingConsent;
    mock.strings.set(userKey, JSON.stringify(legacyRecord));
    const session = await createAccountSession(optedOut, { fetchImpl: mock.fetchImpl });
    const legacy = await getAccountFromSession(session.token, { fetchImpl: mock.fetchImpl });
    assert.deepEqual(legacy.emailMarketingConsent, {
      status: 'subscribed', source: 'offline', consentedAt: null
    });
    assert.deepEqual(JSON.parse(mock.strings.get(userKey)).emailMarketingConsent, legacy.emailMarketingConsent);
    assert.equal(await claimOfflineConsentNotice(legacy, { fetchImpl: mock.fetchImpl }), true);
    assert.equal(await claimOfflineConsentNotice(legacy, { fetchImpl: mock.fetchImpl }), false);
    assert.equal(await claimOfflineConsentNotice(optedIn, { fetchImpl: mock.fetchImpl }), false);
  } finally {
    if (previousUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = previousUrl;
    if (previousToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = previousToken;
  }
});

test('chỉ ghi nhận đồng ý marketing sau khi người dùng chấp nhận', async () => {
  const previousUrl = process.env.UPSTASH_REDIS_REST_URL;
  const previousToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const mock = redisMock();
  try {
    const user = await registerAccount({
      email: 'consent@example.com', username: 'Consent_01', password: 'mat-khau-an-toan'
    }, { fetchImpl: mock.fetchImpl });
    assert.equal(user.emailMarketingConsent.status, 'not_subscribed');

    const accepted = await acceptEmailMarketingConsent(user.id, { fetchImpl: mock.fetchImpl });
    assert.equal(accepted.emailMarketingConsent.status, 'subscribed');
    assert.equal(accepted.emailMarketingConsent.source, 'login_prompt');
    assert.ok(accepted.emailMarketingConsent.consentedAt);
    assert.equal(JSON.parse(mock.strings.get(`realview:account:v1:user:${user.id}`)).emailMarketingConsent.source, 'login_prompt');

    const repeated = await acceptEmailMarketingConsent(user.id, { fetchImpl: mock.fetchImpl });
    assert.equal(repeated.emailMarketingConsent.consentedAt, accepted.emailMarketingConsent.consentedAt);
  } finally {
    if (previousUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = previousUrl;
    if (previousToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = previousToken;
  }
});

test('mã xác minh đặt lại mật khẩu chỉ dùng một lần và mật khẩu mới vẫn được băm', async () => {
  const previousUrl = process.env.UPSTASH_REDIS_REST_URL;
  const previousToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const mock = redisMock();
  try {
    const user = await registerAccount({
      email: 'buyer@example.com',
      username: 'Buyer_02',
      password: 'mat-khau-cu'
    }, { fetchImpl: mock.fetchImpl });
    const reset = await createPasswordReset('BUYER@example.com', { fetchImpl: mock.fetchImpl });

    assert.equal(reset.user.id, user.id);
    assert.match(reset.code, /^\d{6}$/);
    const storedReset = JSON.parse(mock.strings.get(`realview:account:v1:password-reset:${reset.requestId}`));
    assert.equal(storedReset.codeHash.includes(reset.code), false);

    const wrongCode = reset.code === '000000' ? '000001' : '000000';
    await assert.rejects(
      resetAccountPassword({ requestId: reset.requestId, code: wrongCode, password: 'mat-khau-moi' }, { fetchImpl: mock.fetchImpl }),
      /Mã xác minh không đúng/
    );
    await resetAccountPassword({ requestId: reset.requestId, code: reset.code, password: 'mat-khau-moi' }, { fetchImpl: mock.fetchImpl });
    await assert.rejects(
      resetAccountPassword({ requestId: reset.requestId, code: reset.code, password: 'mat-khau-khac' }, { fetchImpl: mock.fetchImpl }),
      /không hợp lệ hoặc đã hết hạn/
    );
    await assert.rejects(
      authenticateAccount({ username: 'Buyer_02', password: 'mat-khau-cu' }, { fetchImpl: mock.fetchImpl }),
      /không đúng/
    );
    assert.equal((await authenticateAccount({ username: 'Buyer_02', password: 'mat-khau-moi' }, { fetchImpl: mock.fetchImpl })).id, user.id);
  } finally {
    if (previousUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = previousUrl;
    if (previousToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = previousToken;
  }
});

test('lịch sử được lưu theo tài khoản và sắp xếp mới nhất trước', async () => {
  const previousUrl = process.env.UPSTASH_REDIS_REST_URL;
  const previousToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const mock = redisMock();
  const report = (id, analyzedAt) => ({
    id,
    analyzedAt,
    title: id,
    fullReport: { product: { title: id }, reviews: [] }
  });
  try {
    await saveAccountHistory('user-a', report('old', '2026-01-01T00:00:00.000Z'), { fetchImpl: mock.fetchImpl });
    await saveAccountHistory('user-a', report('new', '2026-08-01T00:00:00.000Z'), { fetchImpl: mock.fetchImpl });
    await saveAccountHistory('user-b', report('other', '2026-09-01T00:00:00.000Z'), { fetchImpl: mock.fetchImpl });

    assert.deepEqual((await listAccountHistory('user-a', { fetchImpl: mock.fetchImpl })).map((item) => item.id), ['new', 'old']);
    assert.deepEqual((await listAccountHistory('user-b', { fetchImpl: mock.fetchImpl })).map((item) => item.id), ['other']);
    assert.equal((await getAccountHistoryItem('user-a', 'new', { fetchImpl: mock.fetchImpl })).id, 'new');
    assert.equal(await getAccountHistoryItem('user-b', 'new', { fetchImpl: mock.fetchImpl }), null);
  } finally {
    if (previousUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = previousUrl;
    if (previousToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = previousToken;
  }
});

