// Read-only, manually run audit. Blob list() is an Advanced Operation.
// This script never deletes objects, and refuses to report an incomplete scan.
import { list } from '@vercel/blob';
import { pathToFileURL } from 'node:url';
import { getBlogPost, listBlogPosts, blogCmsInternals } from '../src/blog-cms-store.mjs';
import { redisCommand } from '../src/redis-rest.mjs';

const PREFIX = 'blog/assets/v1/';
const MIN_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function mediaPath(value) {
  const text = String(value || '');
  const index = text.indexOf(PREFIX);
  return index < 0 ? '' : text.slice(index).split(/[?#]/, 1)[0];
}

function collectReferences(value, target) {
  if (typeof value === 'string') {
    const path = mediaPath(value);
    if (path) target.add(path);
  } else if (Array.isArray(value)) {
    value.forEach((entry) => collectReferences(entry, target));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((entry) => collectReferences(entry, target));
  }
}

export async function reportBlogMediaOrphans(options = {}) {
  const token = options.blobToken || process.env.BLOG_MEDIA_BLOB_TOKEN;
  if (!token) throw new Error('BLOG_MEDIA_BLOB_TOKEN is required; do not scan the private Blob store.');
  const posts = await (options.listPostsImpl || listBlogPosts)({ all: true });
  if (posts.length >= blogCmsInternals.LIST_ALL_LIMIT) throw new Error('CMS post scan reached its limit; report would be incomplete.');
  const references = new Set();
  let scannedRevisions = 0;
  for (const post of posts) {
    const revisions = await (options.redisCommandImpl || redisCommand)(
      ['ZREVRANGE', blogCmsInternals.revisionIndexKey(post.id), '0', '-1']);
    if (!Array.isArray(revisions)) throw new Error(`Cannot list revisions for ${post.id}`);
    for (const revision of revisions) {
      const record = await (options.getPostImpl || getBlogPost)(post.id, { revision: Number(revision) });
      collectReferences(record.post, references);
      scannedRevisions += 1;
    }
    // Also cover any URL retained in metadata beyond a stored revision.
    collectReferences(post, references);
  }
  const blobList = options.blobListImpl || list;
  let cursor;
  let listCalls = 0;
  const seenCursors = new Set();
  const candidates = [];
  do {
    const page = await blobList({ prefix: PREFIX, cursor, limit: 1000, token });
    listCalls += 1;
    for (const blob of page.blobs || []) {
      if (!references.has(blob.pathname) && Date.now() - new Date(blob.uploadedAt).getTime() >= MIN_AGE_MS) {
        candidates.push({ pathname: blob.pathname, url: blob.url, uploadedAt: blob.uploadedAt, size: blob.size });
      }
    }
    if (page.hasMore && !page.cursor) throw new Error('Blob pagination incomplete; no orphan report generated.');
    if (page.hasMore && seenCursors.has(page.cursor)) throw new Error('Blob pagination repeated a cursor; no orphan report generated.');
    if (page.hasMore) seenCursors.add(page.cursor);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return { scannedPosts: posts.length, scannedRevisions, referencedObjects: references.size,
    listCalls, candidates, deletionPerformed: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes('--acknowledge-list-cost')) {
    console.error('Pass --acknowledge-list-cost: each Blob list() page is an Advanced Operation.');
    process.exitCode = 2;
  } else {
    reportBlogMediaOrphans().then((report) => console.log(JSON.stringify(report, null, 2)))
      .catch((error) => { console.error(error.message); process.exitCode = 1; });
  }
}
