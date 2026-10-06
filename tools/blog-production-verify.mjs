import { readFile,readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash,randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { productionWorkerCall } from '../src/blog-cloudflare-client.mjs';
import { preparePreviewMedia } from '../src/blog-cloudflare-preview.mjs';

const args=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
const projectEnv={...process.env,VERCEL_PROJECT_ID:'prj_JgsU3RUeOG2pQ543INoVpslfrleE',VERCEL_ORG_ID:'team_qC5riAr1mMNGxndFQ0NLe60H'};
const hash=b=>createHash('sha256').update(b).digest('hex');
const config='cloudflare/blog-preview/wrangler.production.jsonc';
function cli(bin,argv) {return new Promise((resolve,reject)=>{
  const child=spawn(bin,argv,{env:projectEnv,stdio:['ignore','pipe','pipe']});let output='';
  child.stdout.on('data',b=>output+=b);child.stderr.resume();child.on('error',reject);
  child.on('close',code=>code===0?resolve(output):reject(Error('VERIFY_CLI_FAILED')));
});}
async function query(sql) {
  const raw=await cli('node',[args.wrangler,'d1','execute','realview-blog','--remote','--config',config,'--json','--command',sql]);
  return JSON.parse(raw.slice(raw.indexOf('['))).at(-1).results;
}
const origin=new URL(args.url);
async function stageGet(path) {
  // Use the authenticated CLI; keep Deployment Protection enabled.
  const text=await cli('/opt/homebrew/bin/vercel',['curl',path,'--deployment',origin.origin,'--','--silent','--show-error','--write-out','\n%{http_code}','--max-time','15']);
  const boundary=text.lastIndexOf('\n');
  return {status:Number(text.slice(boundary+1)),body:Buffer.from(text.slice(0,boundary))};
}
let testId=null,testSlug=null,asset=null,phase='snapshot-hashes';
try {
  if(origin.protocol!=='https:'||!origin.hostname.endsWith('.vercel.app')||!args.wrangler)throw Error('VERIFY_ARGUMENTS');
  let matches=0;
  for(const name of(await readdir('public/blog/snapshots')).filter(n=>n.endsWith('.html')&&!n.startsWith('index-'))) {
    const expected=await readFile('public/blog/snapshots/'+name),slug=name.slice(0,-5);
    const response=await stageGet('/bai-viet/'+slug);
    if(response.status!==200||hash(response.body)!==hash(expected))throw Error('SNAPSHOT_CHANGED');
    matches++;
  }
  for(const [path,file] of [['/bai-viet','index-snapshot.html'],['/sitemap.xml','sitemap-snapshot.xml']]) {
    const response=await stageGet(path);
    if(response.status!==200||hash(response.body)!==hash(await readFile('public/blog/snapshots/'+file)))throw Error('INDEX_OR_SITEMAP_CHANGED');
  }
  const hashes=await query('SELECT slug,html_sha256 FROM blog_legacy_articles');
  for(const r of hashes)if(hash(await readFile('public/blog/snapshots/'+r.slug+'.html'))!==r.html_sha256)throw Error('D1_SNAPSHOT_HASH_MISMATCH');
  const unauthorized=await stageGet('/api/admin-blog?action=list');
  if(unauthorized.status!==401)throw Error('UNAUTHENTICATED_STUDIO_NOT_DENIED');
  phase='signed-worker';
  const env={BLOG_HMAC_SECRET:process.env.BLOG_VERIFY_HMAC_SECRET};
  if(!env.BLOG_HMAC_SECRET||env.BLOG_HMAC_SECRET.length<32)throw Error('VERIFY_SECRET_REQUIRED');
  const admins=await query("SELECT actor_id FROM blog_access_grants WHERE role='admin' AND active=1 AND starts_at<=CAST(strftime('%s','now') AS INTEGER) AND (expires_at IS NULL OR expires_at>CAST(strftime('%s','now') AS INTEGER)) LIMIT 1");
  if(!admins.length)throw Error('ADMIN_MISSING');const actor=admins[0].actor_id;
  const call=(path,input,key)=>productionWorkerCall(path,input,actor,{env,idempotencyKey:key});
  const access=await call('/v1/read',{action:'access'});if(access.backend!=='cloudflare'||!access.readOnly)throw Error('CUTOVER_NOT_LOCKED');
  let locked=false;try{await call('/v1/save',{post:{title:'Test lock',slug:'test-lock',blocks:[]}});}catch(e){locked=e.code==='BLOG_READ_ONLY';}
  if(!locked)throw Error('READ_ONLY_BYPASSED');
  if(args.smoke==='yes') {
    phase='private-write-smoke';
    await query("UPDATE blog_migration_settings SET value='false' WHERE setting='studio_read_only'");
    testSlug='migration-smoke-'+randomUUID();
    const post={title:'Private migration smoke test',slug:testSlug,category:'doc-review',blocks:[{type:'paragraph',text:'Temporary private test. Never publish.'}]};
    const key=randomUUID(),saved=await call('/v1/save',{post},key);testId=saved.id;
    const retry=await call('/v1/save',{post},key);if(retry.id!==testId||retry.revision!==1)throw Error('LIVE_IDEMPOTENCY_FAILED');
    const revision=await call('/v1/read',{action:'detail',id:testId});if(revision.post.title!==post.title)throw Error('LIVE_DRAFT_READ_FAILED');
    const privateList=await fetch('https://realview-blog.wwpk-cloudflare-relay.workers.dev/public/list').then(r=>r.json());
    if(privateList.posts.some(p=>p.slug===testSlug))throw Error('DRAFT_PUBLIC_LEAK');
    const pixel=await sharp({create:{width:3,height:3,channels:3,background:{r:Math.floor(Math.random()*255),g:Math.floor(Math.random()*255),b:Math.floor(Math.random()*255)}}}).png().toBuffer();
    const processed=await preparePreviewMedia({contentType:'image/png',data:pixel.toString('base64')});
    asset=(await call('/v1/media/upload',processed)).asset;
    const image=await productionWorkerCall('/v1/media/read',{hash:asset.id,width:asset.width},actor,{env,raw:true});
    if(!image.ok||image.headers.get('content-type')!=='image/webp')throw Error('LIVE_PRIVATE_MEDIA_READ_FAILED');await image.body?.cancel();
    const hidden=await fetch(`https://realview-blog.wwpk-cloudflare-relay.workers.dev/public/media?hash=${asset.id}&width=${asset.width}`);
    if(hidden.status!==404)throw Error('PRIVATE_MEDIA_PUBLIC_LEAK');
  }
  console.log(JSON.stringify({verifiedSnapshots:matches,d1Hashes:hashes.length,indexUnchanged:true,sitemapUnchanged:true,
    anonymousDenied:true,readOnlyEnforced:true,privateSaveAndRetry:!!testId,privateR2Upload:!!asset,publicationsCreated:0}));
}catch(error){console.error('BLOG_VERIFY_FAILED phase='+phase+' code='+error.message);process.exitCode=1;}
finally {
  if(args.smoke==='yes')await query("UPDATE blog_migration_settings SET value='true' WHERE setting='studio_read_only'").catch(()=>{process.exitCode=1;});
  if(testId&&/^[a-f0-9-]{36}$/.test(testId)&&/^migration-smoke-[a-f0-9-]{36}$/.test(testSlug)) {
    // Delete ONLY the exact private fixture that this run created, never user content.
    await query(`DELETE FROM blog_revisions WHERE post_id='${testId}' AND EXISTS(SELECT 1 FROM blog_drafts WHERE id='${testId}' AND slug='${testSlug}' AND title='Private migration smoke test');
      DELETE FROM blog_drafts WHERE id='${testId}' AND slug='${testSlug}' AND title='Private migration smoke test';
      DELETE FROM blog_slugs WHERE owner_id='${testId}' AND slug='${testSlug}';`).catch(()=>{process.exitCode=1;});
  }
  if(asset?.id&&/^[a-f0-9]{64}$/.test(asset.id)) {
    for(const source of asset.responsiveSources)await cli('node',[args.wrangler,'r2','object','delete','realview-blog-media/'+source.pathname,'--remote']).catch(()=>{process.exitCode=1;});
    await query(`DELETE FROM blog_media WHERE hash='${asset.id}' AND NOT EXISTS(SELECT 1 FROM blog_public_media WHERE hash='${asset.id}')`).catch(()=>{process.exitCode=1;});
  }
}
