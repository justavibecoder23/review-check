import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const pages = ['index.html', 'results.html', 'criteria.html', 'contact.html'];

test('Google Analytics is initialized on every public page', async () => {
  for (const page of pages) {
    const html = await readFile(new URL(`../public/${page}`, import.meta.url), 'utf8');
    assert.match(html, /<head>\s*<script defer src="\/analytics\.js"><\/script>/);
  }

  const analytics = await readFile(new URL('../public/analytics.js', import.meta.url), 'utf8');
  assert.match(analytics, /G-VRX4RKBXN6/);
  assert.match(analytics, /allowedParameters/);
  assert.match(analytics, /requestIdleCallback/);
  assert.doesNotMatch(analytics, /\b(email|username|review_content|product_url)\b/);
});

test('Search Console verification tag is present only on the homepage', async () => {
  const token = 'H--HdDunPPMXTSdXmH-FUJPCk7K_f1G3NUbMH-82o3I';
  const homepage = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(homepage, new RegExp(`name="google-site-verification" content="${token}"`));

  for (const page of pages.slice(1)) {
    const html = await readFile(new URL(`../public/${page}`, import.meta.url), 'utf8');
    assert.doesNotMatch(html, /google-site-verification/);
  }
});

test('Key user actions emit privacy-safe analytics events', async () => {
  const [results, auth, contact] = await Promise.all([
    readFile(new URL('../public/results.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/auth.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/contact.js', import.meta.url), 'utf8')
  ]);

  assert.match(results, /'analysis_start'/);
  assert.match(results, /'analysis_complete'/);
  assert.match(results, /'analysis_error'/);
  assert.match(auth, /'sign_up'/);
  assert.match(auth, /'login'/);
  assert.match(contact, /'generate_lead'/);
});

