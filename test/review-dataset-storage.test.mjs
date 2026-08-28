import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveReviewDatasets } from '../src/review-dataset-storage.mjs';

test('mỗi lượt local lưu đúng cặp file raw và labeled có chung runId', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'realview-dataset-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const review = { rating: 2, text: 'Pin yếu và sạc không vào.', verified: true, labels: { has_defect: true }, labeling: { pipelineVersion: '2.0.0' } };
  const saved = await saveReviewDatasets({
    rawReviews: [review],
    labeledReviews: [{ ...review, labelId: 'r0001' }],
    product: { platform: 'Shopee', itemId: '123', title: 'Sạc dự phòng' },
    source: { type: 'test' },
    labeling: { engine: 'layer1-only' }
  }, { localRoot: root, runId: 'test-run', now: new Date('2026-08-27T10:00:00.000Z') });

  assert.equal(saved.saved, true);
  const raw = JSON.parse(await readFile(saved.rawPath, 'utf8'));
  const labeled = JSON.parse(await readFile(saved.labeledPath, 'utf8'));
  assert.equal(raw.runId, 'test-run');
  assert.equal(labeled.runId, 'test-run');
  assert.equal(raw.reviews[0].labels, undefined);
  assert.equal(labeled.reviews[0].labels.has_defect, true);
});

test('Vercel không có Blob token phải báo không lưu thay vì ghi vào filesystem tạm', async () => {
  const previousVercel = process.env.VERCEL;
  const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
  process.env.VERCEL = '1';
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    const result = await saveReviewDatasets({ rawReviews: [], labeledReviews: [] }, { runId: 'no-token' });
    assert.equal(result.saved, false);
    assert.equal(result.provider, 'none');
    assert.match(result.warning, /BLOB_READ_WRITE_TOKEN/);
  } finally {
    if (previousVercel) process.env.VERCEL = previousVercel;
    else delete process.env.VERCEL;
    if (previousToken) process.env.BLOB_READ_WRITE_TOKEN = previousToken;
    else delete process.env.BLOB_READ_WRITE_TOKEN;
  }
});
