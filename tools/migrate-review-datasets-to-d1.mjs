import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { datasetFingerprint } from '../src/review-dataset-storage.mjs';
import { saveCloudflareReviewBundle, verifyCloudflareReviewBundle } from '../src/cloudflare-review-store.mjs';

const MAX_BYTES = 10 * 1024 * 1024;

async function readJson(blob, get, token) {
  const response = await get(blob.pathname, { access: 'private', token });
  if (response?.statusCode !== 200 || !response.stream || Number(response.blob?.size) > MAX_BYTES) {
    throw new Error('BLOB_NOT_READABLE');
  }
  const text = await new Response(response.stream).text();
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('BLOB_TOO_LARGE');
  return JSON.parse(text);
}

export async function migrateReviewDatasets(options = {}) {
  const token = options.blobToken || process.env.BLOB_READ_WRITE_TOKEN;
  const list = options.blobListImpl || (await import('@vercel/blob')).list;
  const get = options.blobGetImpl || (await import('@vercel/blob')).get;
  const store = options.saveImpl || saveCloudflareReviewBundle;
  const verify = options.verifyImpl || verifyCloudflareReviewBundle;
  const inventory = [];
  let cursor;
  let listCalls = 0;
  do {
    const page = await list({ prefix: 'review-datasets/', limit: 1000, token, cursor });
    listCalls += 1;
    inventory.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  const paths = new Map(inventory.map(blob => [blob.pathname, blob]));
  const cutoff = new Date(options.now || Date.now()).getTime() - 5 * 86400_000;
  const candidates = inventory.filter(blob => {
    if (!/\/(reviews\.dataset|reviews\.raw)\.json$/.test(blob.pathname)) return false;
    if (options.scope === 'all') return true;
    const date = blob.pathname.match(/^review-datasets\/(\d{4})\/(\d{2})\/(\d{2})\//);
    return date && Date.parse(`${date[1]}-${date[2]}-${date[3]}T00:00:00Z`) + 86400_000 > cutoff;
  }).sort((a, b) => a.pathname.localeCompare(b.pathname));
  const report = { apply: Boolean(options.apply), scope: options.scope || 'recent', listCalls,
    totalObjects: inventory.length, candidates: candidates.length, migrated: 0, verified: 0,
    failures: [], records: [] };
  const selected = options.limit ? candidates.slice(0, options.limit) : candidates;
  for (const blob of selected) {
    try {
      const payload = await readJson(blob, get, token);
      let bundle = payload;
      if (payload.datasetKind !== 'review-dataset-bundle') {
        const labeled = paths.get(blob.pathname.replace(/reviews\.raw\.json$/, 'reviews.labeled.json'));
        if (!labeled) throw new Error('LEGACY_LABELED_DATASET_MISSING');
        const labeledDataset = await readJson(labeled, get, token);
        bundle = { schemaVersion: '2.0.0', datasetKind: 'review-dataset-bundle', runId: payload.runId,
          createdAt: payload.createdAt, product: payload.product, rawDataset: payload, labeledDataset };
      }
      const record = { pathname: blob.pathname, runId: bundle.runId, createdAt: bundle.createdAt,
        rawCount: bundle.rawDataset.reviews.length, labeledCount: bundle.labeledDataset.reviews.length,
        bytes: Buffer.byteLength(JSON.stringify(bundle)) };
      if (options.apply) {
        const location = await store(bundle, datasetFingerprint(bundle.product, bundle.rawDataset), {
          ...options, importedFrom: blob.pathname
        });
        report.migrated += 1;
        const checked = await verify(location.datasetId, bundle, options);
        if (!checked.matches) throw new Error('D1_CONTENT_MISMATCH');
        report.verified += 1;
        Object.assign(record, { datasetId: location.datasetId, verified: true });
      }
      report.records.push(record);
      options.onRecord?.(record);
    } catch (error) {
      report.failures.push({ pathname: blob.pathname, reason: error.message });
    }
  }
  return report;
}

async function main() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('Thiếu BLOB_READ_WRITE_TOKEN.');
  const args = process.argv.slice(2);
  const scope = args.includes('--all') ? 'all' : 'recent';
  const reportPath = args.find(arg => arg.startsWith('--report='))?.slice(9);
  const limit = Number(args.find(arg => arg.startsWith('--limit='))?.slice(8)) || undefined;
  const report = await migrateReviewDatasets({ apply: args.includes('--apply'), scope, limit,
    cloudflareTimeoutMs: 20_000,
    onRecord: record => console.log(JSON.stringify({ event: 'review_migration_record', ...record })) });
  if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ...report, records: undefined }));
  if (report.failures.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
