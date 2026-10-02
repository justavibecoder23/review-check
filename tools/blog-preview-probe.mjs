// Explicitly opt-in preview probe. Does NOT import credentials from requests,
// touch production, activate legacy grants, or list arbitrary R2 objects.
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { signBlogRequest } from '../cloudflare/blog-preview/request-auth.mjs';
import { preparePreviewMedia } from '../src/blog-cloudflare-preview.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const i = arg.indexOf('='); return [arg.slice(2, i), arg.slice(i + 1)];
}));
const config = 'cloudflare/blog-preview/wrangler.jsonc';
const root = new URL('../', import.meta.url);
const origin = 'https://realview-blog-preview.wwpk-cloudflare-relay.workers.dev';
const actor = 'preview-probe-' + randomUUID();
function cli(argv, stdin) {
  return new Promise((resolve, reject) => {
    const process = spawn('node', [args.wrangler, ...argv], { cwd: root, stdio: ['pipe','pipe','pipe'] });
    let out = '', err = '';
    process.stdout.on('data', b => { out += b; }); process.stderr.on('data', b => { err += b; });
    process.on('error', reject);
    process.on('close', code => code === 0 ? resolve(out) : reject(new Error(`PREVIEW_CLI_FAILED_${code}`)));
    process.stdin.end(stdin || '');
  });
}
const metrics = { workerRequests: 0, sqlRowsRead: 0, sqlRowsWritten: 0, workerRowsRead:0,workerRowsWritten:0,
  r2PutAttempted:0,r2PutConfirmed:0,r2Head:0,r2Get:0,statuses: [], r2ProbePutAttempted: 0, r2ProbeHeadExpected: 0, r2ProbeGetExpected: 0, r2CleanupDelete: 0 };
async function sql(command) {
  const data = JSON.parse(await cli(['d1','execute','realview-blog-preview','--remote','--config',config,'--json','--command',command]));
  for (const item of data) {
    metrics.sqlRowsRead += item.meta?.rows_read || 0; metrics.sqlRowsWritten += item.meta?.rows_written || 0;
  }
  return data.at(-1).results;
}
function expect(value, message) { if (!value) throw new Error(message); }
async function main() {
  if (!args.wrangler || !args.secret || args.confirm !== 'preview-only') throw new Error('PREVIEW_EXPLICIT_ARGS_REQUIRED');
  const cfg = JSON.parse(await readFile(new URL('../' + config, import.meta.url), 'utf8'));
  expect(cfg.name === 'realview-blog-preview' && cfg.d1_databases[0].database_id === 'e71ba88a-6bd6-4b7d-975f-b9df1650cdcd'
    && cfg.r2_buckets[0].bucket_name === 'realview-blog-media-preview', 'PREVIEW_RESOURCE_MISMATCH');
  let secret;
  if (args.init === 'true') {
    const path = new URL('file://' + args.secret);
    await mkdir(new URL('.', path), { recursive: true, mode: 0o700 });
    await writeFile(path, randomBytes(48).toString('base64url'), { mode: 0o600, flag: 'wx' });
    await chmod(new URL('.', path), 0o700);
    secret = (await readFile(path, 'utf8')).trim();
    await cli(['secret','put','BLOG_HMAC_SECRET','--config',config], secret);
    console.log(JSON.stringify({ secretInstalled: true, valuePrinted: false }));
    return;
  }
  secret = (await readFile(args.secret, 'utf8')).trim();
  async function call(path, payload, key = randomUUID(), alter) {
    const body = new TextEncoder().encode(JSON.stringify(payload));
    const headers = await signBlogRequest({ secret, environment: 'preview', method: 'POST', url: origin + path,
      actorId: actor, requestId: randomUUID(), timestamp: Math.floor(Date.now()/1000), idempotencyKey: key,
      contentType: 'application/json', body });
    alter?.(headers);
    metrics.workerRequests++;
    const response = await fetch(origin + path, { method:'POST', headers, body, redirect:'error', signal:AbortSignal.timeout(35_000) });
    metrics.statuses.push(response.status);
    for (const [name,header] of [['workerRowsRead','D1-Rows-Read'],['workerRowsWritten','D1-Rows-Written'],['r2PutAttempted','R2-Put-Attempted'],
      ['r2PutConfirmed','R2-Put-Confirmed'],['r2Head','R2-Head'],['r2Get','R2-Get']]) metrics[name] += Number(response.headers.get('X-Blog-' + header) || 0);
    return response;
  }
  expect((await fetch(origin + '/health')).ok, 'HEALTH_FAILED');
  expect((await call('/v1/save', {}, undefined, h => { h['x-blog-signature']='0'.repeat(64); })).status === 401, 'FORGED_NOT_DENIED');
  expect((await call('/v1/read', {action:'access'})).status === 403, 'MISSING_GRANT_NOT_DENIED');
  const baseline = (await sql("SELECT (SELECT COUNT(*) FROM blog_access_grants WHERE active=1) AS active,(SELECT COUNT(*) FROM blog_drafts) AS drafts,(SELECT COUNT(*) FROM blog_media) AS media,(SELECT value FROM blog_migration_settings WHERE setting='studio_read_only') AS locked"))[0];
  expect(baseline.active === 0 && baseline.drafts === 0 && baseline.media === 0 && baseline.locked === 'true', 'PREVIEW_NOT_EMPTY_OR_LOCKED');
  let fixtureCreated = false, asset;
  try {
    // SQL transport failure is also ambiguous. Always attempt exact cleanup
    // once the activation request is sent, not only after its response arrives.
    fixtureCreated = true;
    await sql(`INSERT INTO blog_access_grants(actor_id,role,active,updated_at,expires_at) VALUES('${actor}','editor',1,0,CAST(strftime('%s','now') AS INTEGER)+600); UPDATE blog_migration_settings SET value='false' WHERE setting='studio_read_only';`);
    const input = { expectedRevision:0, post:{ title:'Disposable preview test', slug:actor, category:'doc-review', blocks:[{id:'one',type:'paragraph',text:'Synthetic test only.'}] } };
    const key = randomUUID();
    const first = await call('/v1/save', input, key); expect(first.status === 200,'REMOTE_SAVE_FAILED');
    const saved = await first.json();
    const second = await call('/v1/save', input, key); expect(second.status === 200,'REMOTE_IDEMPOTENCY_FAILED');
    expect((await second.json()).id === saved.id,'REMOTE_SAVE_DUPLICATED');
    const changed = { ...input, id:saved.id,expectedRevision:1,post:{...input.post,title:'Updated fixture'} };
    expect((await call('/v1/save',changed)).status === 200,'REMOTE_UPDATE_FAILED');
    expect((await call('/v1/save',changed)).status === 409,'REMOTE_CAS_NOT_ENFORCED');
    const png = await sharp({ create:{ width:80,height:40,channels:3,background:{r:randomBytes(1)[0],g:142,b:53} } }).png().toBuffer();
    const media = await preparePreviewMedia({contentType:'image/png',data:png.toString('base64')});
    metrics.r2ProbePutAttempted += media.variants.length;
    const upload = await call('/v1/media/upload', media); expect(upload.status === 200,'REMOTE_R2_UPLOAD_FAILED');
    asset = (await upload.json()).asset;
    metrics.r2ProbeHeadExpected += media.variants.length;
    const repeat = await call('/v1/media/upload', media); expect(repeat.status === 200,'REMOTE_R2_DEDUP_FAILED');
    expect((await repeat.json()).asset.id === asset.id && repeat.headers.get('X-Blog-R2-Put-Attempted') === '0','REMOTE_R2_DEDUP_HASH_MISMATCH');
    const get = await call('/v1/media/read', {hash:asset.id,width:asset.width}); expect(get.status === 200,'REMOTE_R2_READ_FAILED');
    metrics.r2ProbeGetExpected++;
    expect((await get.arrayBuffer()).byteLength === asset.size,'REMOTE_R2_SIZE_MISMATCH');
    expect(get.headers.get('cache-control') === 'private, no-store','PRIVATE_MEDIA_CACHE_FAILED');
    await sql("UPDATE blog_migration_settings SET value='true' WHERE setting='studio_read_only'");
    expect((await call('/v1/save',changed)).status === 503,'REMOTE_LOCK_NOT_ENFORCED');
    expect((await call('/v1/media/upload',media)).status === 503,'REMOTE_MEDIA_LOCK_NOT_ENFORCED');
    await sql(`UPDATE blog_access_grants SET active=0 WHERE actor_id='${actor}'`);
    expect((await call('/v1/read',{action:'list'})).status === 403,'REMOTE_REVOCATION_NOT_ENFORCED');
    for (const path of ['/v1/publish','/v1/unpublish','/sitemap.xml']) expect((await call(path,{})).status === 404,'DISABLED_ENDPOINT_EXPOSED');
  } finally {
    if (fixtureCreated) {
      // Lock BEFORE cleanup. Exact ownership predicates, no arbitrary deletes.
      await sql(`UPDATE blog_migration_settings SET value='true' WHERE setting='studio_read_only'; UPDATE blog_access_grants SET active=0 WHERE actor_id='${actor}';`);
      if (asset) {
        for (const item of asset.responsiveSources) {
          await cli(['r2','object','delete',`realview-blog-media-preview/${item.pathname}`,'--remote','--config',config]);
          metrics.r2CleanupDelete++;
        }
        await sql(`DELETE FROM blog_media WHERE hash='${asset.id}' AND state='ready'`);
      }
      await sql(`DELETE FROM blog_revisions WHERE post_id IN(SELECT id FROM blog_drafts WHERE created_by='${actor}');
        DELETE FROM blog_slugs WHERE ownership='studio' AND owner_id IN(SELECT id FROM blog_drafts WHERE created_by='${actor}');
        DELETE FROM blog_drafts WHERE created_by='${actor}'; DELETE FROM blog_idempotency WHERE actor_id='${actor}';
        DELETE FROM blog_request_replays WHERE actor_id='${actor}'; DELETE FROM blog_access_grants WHERE actor_id='${actor}';`);
    }
  }
  const state = (await sql("SELECT (SELECT COUNT(*) FROM blog_access_grants) AS grants,(SELECT COUNT(*) FROM blog_drafts) AS drafts,(SELECT COUNT(*) FROM blog_revisions) AS revisions,(SELECT COUNT(*) FROM blog_media) AS media,(SELECT COUNT(*) FROM blog_request_replays) AS replays,(SELECT COUNT(*) FROM blog_idempotency) AS idempotency,(SELECT value FROM blog_migration_settings WHERE setting='studio_read_only') AS locked"))[0];
  expect(state.grants === 0 && state.drafts === 0 && state.revisions === 0 && state.media === 0 && state.locked === 'true', 'REMOTE_CLEANUP_INCOMPLETE');
  console.log(JSON.stringify({ passed:true, state, ...metrics,
    costNote:'Worker counters come from SDK response metadata and attempted/confirmed operations, not account billing analytics. SQL counters include explicit CLI queries only.' }));
}
main().catch(error => { console.error(error.message?.startsWith('PREVIEW_') || error.message?.startsWith('REMOTE_') ? error.message : 'PREVIEW_TEST_FAILED: private data suppressed'); process.exitCode=1; });
