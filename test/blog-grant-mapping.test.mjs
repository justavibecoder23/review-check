import test from 'node:test';
import assert from 'node:assert/strict';
import { mapLegacyBlogGrants } from '../tools/blog-grant-mapping.mjs';
import { hash } from '../tools/blog-migration-inventory.mjs';

const id = 'c727c725-bd33-4bce-b54d-115f3543f3d0';
function fixture() {
  const entry = { email: 'editor@example.test', role: 'editor', startsAt: '2026-01-01T00:00:00Z', expiresAt: null };
  const key = `realview:blog:access:v1:grant:${hash(entry.email)}`;
  const raw = JSON.stringify(entry);
  const record = { key, raw, sha256: hash(JSON.stringify(raw)) };
  const store = new Map([[key, raw], ['realview:account:v1:email:editor@example.test', id],
    [`realview:account:v1:user:${id}`, JSON.stringify({ id, email: entry.email, username: 'editor', passwordHash: 'never exported' })],
    ['realview:account:v1:username:editor', id]]);
  const calls = [];
  const get = async command => { calls.push(command); return store.get(command[1]) || null; };
  return { record, store, get, calls };
}

test('maps official email index to stable account and reverse username index without activating or exporting credentials', async () => {
  const f = fixture();
  const result = await mapLegacyBlogGrants([f.record], f.get);
  assert.equal(result.summary.mapped, 1);
  assert.equal(result.summary.activated, 0);
  assert.equal(result.mappings[0].actorId, id);
  assert.equal(result.mappings[0].active, false);
  assert.ok(f.calls.every(call => call[0] === 'GET'));
  assert.ok(!JSON.stringify(result).includes('never exported'));
  assert.ok(!JSON.stringify(result).includes('editor@example.test'));
});

test('changed source, missing account, inconsistent identity and reverse index fail closed', async () => {
  for (const [key, value] of [[null, 'changed'], ['realview:account:v1:email:editor@example.test', null],
    [`realview:account:v1:user:${id}`, JSON.stringify({ id, email: 'another@example.test', username: 'editor' })],
    ['realview:account:v1:username:editor', 'another-id']]) {
    const f = fixture(); f.store.set(key || f.record.key, value);
    const result = await mapLegacyBlogGrants([f.record], f.get);
    assert.equal(result.summary.mapped, 0);
    assert.equal(result.summary.activated, 0);
  }
});
