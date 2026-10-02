import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LEGAL_PAGES } from '../src/legal-content.mjs';

const publicFile = (name) => new URL(`../public/${name}`, import.meta.url);

test('language toggle is minimal, persistent, accessible, and responsive', async () => {
  const [i18n, styles] = await Promise.all([
    readFile(publicFile('i18n.js'), 'utf8'),
    readFile(publicFile('styles.css'), 'utf8')
  ]);
  assert.match(i18n, /realview-language/);
  assert.match(i18n, /data-language="vi"/);
  assert.match(i18n, /data-language="en"/);
  assert.match(i18n, /localStorage\.setItem\(STORAGE_KEY, language\)/);
  assert.match(i18n, /MutationObserver/);
  assert.match(i18n, /window\.dispatchEvent\(new CustomEvent\('realview:language-changed'/);
  assert.match(styles, /\.language-toggle[\s\S]*background:\s*transparent/);
  assert.match(styles, /\.language-toggle button\.is-active\s*\{[^}]*color:\s*var\(--orange\)/);
  assert.match(styles, /@media \(max-width: 420px\)[\s\S]*\.language-toggle/);
});

test('English navigation and longer interface copy reflow without stale measurements', async () => {
  const [styles, auth, chatbot, app, home, i18n] = await Promise.all([
    readFile(publicFile('styles.css'), 'utf8'),
    readFile(publicFile('auth.css'), 'utf8'),
    readFile(publicFile('chatbot.css'), 'utf8'),
    readFile(publicFile('app.js'), 'utf8'),
    readFile(publicFile('index.html'), 'utf8'),
    readFile(publicFile('i18n.js'), 'utf8')
  ]);
  assert.match(styles, /body\.is-english \.hero-copy h1 \.hero-heading-line\s*\{[^}]*white-space:\s*normal/s);
  assert.match(styles, /@media \(min-width: 1025px\)[\s\S]*body\.is-english \.hero-grid\s*\{[^}]*width:\s*min\(1320px, calc\(100% - 48px\)\)/s);
  assert.match(styles, /body\.is-english \.hero-grid\s*\{[^}]*transform:\s*translateX\(clamp\(8px, \.7vw, 14px\)\)/s);
  assert.match(styles, /@media \(min-width: 1025px\)[\s\S]*body\.is-english \.hero-visual\s*\{[^}]*transform:\s*translate\(clamp\(10px, 1vw, 18px\)/s);
  assert.match(styles, /@media \(min-width: 1025px\)[\s\S]*body\.is-english \.hero-copy h1\s*\{[^}]*font-size:\s*clamp\(54px, 4\.9vw, 78px\)/s);
  assert.match(styles, /body\.is-english \.hero-copy h1 \.hero-heading-line-primary,\s*body\.is-english \.hero-copy h1 \.hero-heading-line \+ \.hero-heading-line\s*\{[^}]*font-size:\s*clamp\(48px, 4vw, 72px\)/s);
  assert.match(styles, /body\.is-english \.hero-copy h1 \.hero-heading-line \+ \.hero-heading-line\s*\{[^}]*white-space:\s*nowrap/s);
  assert.match(auth, /body\.is-english \.header-utilities \.header-actions \.chatbot-trigger\s*\{[^}]*width:\s*146px/s);
  assert.match(chatbot, /body\.is-english \.realviewee-state-speech,[\s\S]*white-space:\s*normal/);
  assert.match(app, /addEventListener\('realview:language-changed', realignNavIndicator\)/);
  assert.match(app, /requestAnimationFrame\(\(\) => \{[\s\S]*requestAnimationFrame\(\(\) => \{/);
  assert.match(home, /hero-heading-line-primary">Tiết kiệm<\/span> <span class="hero-heading-line">/);
  assert.match(i18n, /'Chốt đơn, chốt đơn!': "It's time to shop!"/);
  assert.match(i18n, /'Vui lòng đăng ký tài khoản để kích hoạt tính năng lịch sử phân tích\.': 'Please sign up for an account to enable analysis history\.'/);
});

test('English mode clearly disables unsupported Assistant questions', async () => {
  const [client, css] = await Promise.all([
    readFile(publicFile('chatbot.js'), 'utf8'),
    readFile(publicFile('chatbot.css'), 'utf8')
  ]);
  assert.match(client, /English support isn’t available yet/);
  assert.match(client, /RealViewee currently supports Vietnamese only/);
  assert.match(client, /englishUnsupported[\s\S]*input\.disabled = isSending \|\| syncing \|\| englishUnsupported/);
  assert.match(client, /addEventListener\('realview:language-changed', syncResultMode\)/);
  assert.match(client, /data-chatbot-language-switch/);
  assert.match(client, /RealViewI18n\?\.setLanguage\?\.\('vi'\)/);
  assert.match(css, /\.chatbot-language-notice\s*\{/);
  assert.match(css, /\.chatbot-language-switch\s*\{/);
  assert.match(css, /\.chatbot-panel\.is-language-unsupported \.chatbot-input-shell\s*\{[^}]*display:\s*none/);
});

test('all main pages load the language runtime and legal content has English coverage', async () => {
  const names = ['index.html', 'results.html', 'criteria.html', 'contact.html', 'blog.html', 'privacy.html', 'terms.html'];
  const pages = await Promise.all(names.map((name) => readFile(publicFile(name), 'utf8')));
  pages.forEach((page, index) => {
    assert.match(page, /\/(?:nav|i18n)\.js/, `${names[index]} must load language support`);
  });

  const dictionary = await readFile(publicFile('i18n.js'), 'utf8');
  const textValues = [];
  const collect = (value, key = '') => {
    if (typeof value === 'string') {
      if (!['id', 'key', 'file', 'path'].includes(key)) textValues.push(value);
      return;
    }
    if (Array.isArray(value)) return value.forEach((item) => collect(item));
    if (value && typeof value === 'object') Object.entries(value).forEach(([childKey, child]) => collect(child, childKey));
  };
  LEGAL_PAGES.forEach((page) => collect(page));
  for (const value of new Set(textValues.filter((value) => /[À-ỹ]/.test(value)))) {
    assert.ok(dictionary.includes(value), `Missing English mapping for legal copy: ${value}`);
  }
});

test('English users navigate to Blog first and then receive a dismissible notice', async () => {
  const i18n = await readFile(publicFile('i18n.js'), 'utf8');
  const blogHandler = i18n.slice(i18n.indexOf("const blogLink = event.target.closest"), i18n.indexOf('\n    }, true);', i18n.indexOf("const blogLink = event.target.closest")));
  assert.match(blogHandler, /sessionStorage\.setItem\(BLOG_NOTICE_KEY, '1'\)/);
  assert.doesNotMatch(blogHandler, /preventDefault|location\.|window\.open/);
  assert.match(i18n, /dialog\.showModal\(\)/);
  assert.match(i18n, /Continue reading/);
  assert.match(i18n, /dialog\.querySelectorAll\('button'\)/);
  assert.match(i18n, /isBlogPage && parent\.closest\('main'\)/);
});

test('account primary actions center their labels independently of the arrow', async () => {
  const css = await readFile(publicFile('auth.css'), 'utf8');
  assert.match(css, /\.account-submit\s*\{[^}]*position:\s*relative[^}]*justify-content:\s*center[^}]*text-align:\s*center/s);
  assert.match(css, /\.account-submit > \[aria-hidden="true"\]\s*\{[^}]*position:\s*absolute[^}]*right:\s*18px/s);
});

test('chat requests carry the selected language through to the answer service', async () => {
  const [client, api, chatbot] = await Promise.all([
    readFile(publicFile('chatbot.js'), 'utf8'),
    readFile(new URL('../api/chat.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/site-chatbot.mjs', import.meta.url), 'utf8')
  ]);
  assert.match(client, /language:\s*window\.RealViewI18n\?\.getLanguage\?\.\(\) \|\| 'vi'/);
  assert.match(api, /language:\s*body\.language === 'en' \? 'en' : 'vi'/);
  assert.match(chatbot, /answerLanguage === 'en'/);
  assert.match(chatbot, /bằng tiếng Anh tự nhiên, chính xác/);
});

test('dynamic result, comparison, and account copy has complete English coverage', async () => {
  const [i18n, results, counterpart, auth, trust] = await Promise.all([
    readFile(publicFile('i18n.js'), 'utf8'),
    readFile(publicFile('results.js'), 'utf8'),
    readFile(publicFile('counterpart-widget.js'), 'utf8'),
    readFile(publicFile('auth.js'), 'utf8'),
    readFile(new URL('../src/trust-analysis.mjs', import.meta.url), 'utf8')
  ]);

  for (const copy of [
    'Moderate reliability',
    'Factors strengthening reliability',
    'Reviews checked: $1',
    'Publish and edit Blog posts',
    'Manage admin and editor roles',
    'Analyze this product'
  ]) assert.ok(i18n.includes(copy), `Missing English UI copy: ${copy}`);

  const combinedRule = i18n.indexOf('The first three ratios establish the initial reliability level');
  const shortRule = i18n.indexOf("'Reliability before the sample-coverage adjustment is $1.'");
  assert.ok(combinedRule > -1 && shortRule > combinedRule, 'the specific combined explanation rule must run before the generic rule');
  assert.match(results, /trust\?\.translations\?\.en\?\.\[key\]/);
  assert.match(results, /addEventListener\('realview:language-changed',[\s\S]*refreshSentimentLanguage/);
  assert.match(counterpart, /function currentLocale\(\)[\s\S]*'en-US'[\s\S]*'vi-VN'/);
  assert.match(counterpart, /addEventListener\('realview:language-changed',[\s\S]*renderSection/);
  assert.match(auth, /Email cập nhật RealView/);
  assert.match(trust, /translations\.en\.pros/);
  assert.match(trust, /fallbackEnglishTranslation/);
});
