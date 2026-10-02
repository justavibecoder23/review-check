import test from 'node:test';
import assert from 'node:assert/strict';
import { eligiblePreviewGrants } from '../tools/blog-preview-grants.mjs';
const now=Date.now(),sec=Math.floor(now/1000);
const row={mappingStatus:'mapped',legacyRevoked:false,startsAt:sec-1,expiresAt:null,
  actorId:'c727c725-bd33-4bce-b54d-115f3543f3d0',role:'editor',
  recordKey:'realview:blog:access:v1:grant:'+'a'.repeat(64),sourceHash:'b'.repeat(64)};
const report=mappings=>({capturedAt:new Date(now).toISOString(),mappings});
test('preview import skips revoked, scheduled, expired or unresolved grants, preserves original role',()=>{
  const result=eligiblePreviewGrants(report([row,{...row,legacyRevoked:true},{...row,startsAt:sec+60},
    {...row,expiresAt:sec},{...row,mappingStatus:'unresolved'}]),now);
  assert.deepEqual(result,[row]);assert.equal(result[0].role,'editor');
});
test('preview import rejects stale, duplicate or invalid stable identity evidence',()=>{
  assert.throws(()=>eligiblePreviewGrants(report([row]),now+300001),/STALE/);
  assert.throws(()=>eligiblePreviewGrants(report([row,row]),now),/DUPLICATE/);
  assert.throws(()=>eligiblePreviewGrants(report([{...row,actorId:'email@example.test'}]),now),/INVALID/);
});
