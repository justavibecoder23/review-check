#!/usr/bin/env node
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { migrateStaticBlogHtml } from '../src/blog-static-migration.mjs';
import {
  createBlogPost,
  getBlogPostBySlug,
  publishBlogPost
} from '../src/blog-cms-store.mjs';

function argumentValue(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inputDirectory = path.resolve(root, argumentValue('--input') || 'public/blog');
const outputArgument = argumentValue('--output');
const outputDirectory = outputArgument ? path.resolve(root, outputArgument) : '';
const applyMigration = process.argv.includes('--apply');
const files = (await readdir(inputDirectory)).filter((name) => name.endsWith('.html')).sort();
const migrated = [];

for (const file of files) {
  const sourcePath = path.join(inputDirectory, file);
  const html = await readFile(sourcePath, 'utf8');
  const post = migrateStaticBlogHtml(html, { sourcePath: path.relative(root, sourcePath) });
  migrated.push(post);
  if (outputDirectory) {
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(path.join(outputDirectory, `${post.post.slug}.json`), `${JSON.stringify(post, null, 2)}\n`, 'utf8');
  }
}

const summary = migrated.map((post) => ({
  slug: post.post.slug,
  valid: post.migrationValidation.valid,
  words: post.migration.originalWordCount,
  faqSchema: post.migration.hadFaqSchema,
  sourceHash: post.migration.sourceHash.slice(0, 12)
}));

const applied = [];
if (applyMigration) {
  if (migrated.some((post) => !post.migrationValidation.valid)) {
    throw new Error('Không thể import vì có bài viết chưa vượt qua kiểm tra xuất bản.');
  }
  const actor = {
    role: 'admin',
    account: {
      id: 'static-blog-migration',
      username: 'Static blog migration',
      email: 'system@realview.com.vn'
    }
  };
  for (const item of migrated) {
    let existing = null;
    try {
      existing = await getBlogPostBySlug(item.post.slug);
    } catch (error) {
      if (error?.code !== 'BLOG_POST_NOT_FOUND') throw error;
    }
    if (existing?.meta?.status === 'published') {
      applied.push({ slug: item.post.slug, action: 'skipped', reason: 'already-published', id: existing.meta.id });
      continue;
    }
    if (existing) {
      const published = await publishBlogPost(existing.meta.id, existing.revision, actor, {
        publishedAt: item.meta.publishedAt,
        now: item.meta.updatedAt || item.meta.publishedAt || new Date()
      });
      applied.push({ slug: item.post.slug, action: 'published-existing', id: published.meta.id, revision: published.meta.revision });
      continue;
    }
    const created = await createBlogPost(item.post, actor, {
      allowLegacySlug: true,
      now: item.meta.publishedAt || item.meta.updatedAt || new Date()
    });
    const published = await publishBlogPost(created.meta.id, created.revision, actor, {
      publishedAt: item.meta.publishedAt,
      now: item.meta.updatedAt || item.meta.publishedAt || new Date()
    });
    applied.push({ slug: item.post.slug, action: 'created-and-published', id: published.meta.id, revision: published.meta.revision });
  }
}

process.stdout.write(`${JSON.stringify({
  mode: applyMigration ? 'apply' : (outputDirectory ? 'write' : 'dry-run'),
  inputDirectory,
  outputDirectory: outputDirectory || null,
  count: migrated.length,
  posts: summary,
  ...(applyMigration ? { applied } : {})
}, null, 2)}\n`);

if (migrated.some((post) => !post.migrationValidation.valid)) process.exitCode = 1;
