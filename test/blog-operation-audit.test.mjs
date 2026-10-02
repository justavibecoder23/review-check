import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import worker from '../cloudflare/blog-preview/worker.mjs';
import { signBlogRequest } from '../cloudflare/blog-preview/request-auth.mjs';
import { preparePreviewMedia } from '../src/blog-cloudflare-preview.mjs';
import { maintainBlogPreview, readMaintenanceStatus } from '../cloudflare/blog-preview/operation-audit.mjs';
import { previewFixture } from './helpers/blog-preview-fixture.mjs';
const secret='audit-fixture-secret-only-not-production-123456';
async function call(f,path,body,requestId=randomUUID(),idempotencyKey=randomUUID()) {
  const url='https://realview-blog-preview.wwpk-cloudflare-relay.workers.dev'+path;
  const bytes=new TextEncoder().encode(JSON.stringify(body));
  const headers=await signBlogRequest({secret,environment:'preview',method:'POST',url,body:bytes,
    timestamp:Math.floor(Date.now()/1000),requestId,idempotencyKey,actorId:f.actorId,contentType:'application/json'});
  return worker.fetch(new Request(url,{method:'POST',headers,body:bytes}),{
    BLOG_HMAC_SECRET:secret,BLOG_DB:f.db,BLOG_MEDIA:f.bucket});
}
async function image() {
  const data=await sharp({create:{width:80,height:40,channels:3,background:'#ff7518'}}).png().toBuffer();
  return preparePreviewMedia({contentType:'image/png',data:data.toString('base64')});
}
test('durable 30-day audit distinguishes attempted, confirmed, unknown; no content copied',async()=>{
  for(const ambiguous of [false,true]) {
    const f=previewFixture();f.enable();
    try {
      if(ambiguous) f.hooks.afterPut=()=>{throw new Error('response lost');};
      const input=await image(),id=randomUUID();
      assert.equal((await call(f,'/v1/media/upload',input,id)).status,200);
      const row=f.sqlite.prepare('SELECT * FROM blog_operation_audit').get();
      assert.equal(row.state,'finished');assert.equal(row.status,200);
      assert.equal(row.expires_at-row.started_at,30*86400);
      const put=f.sqlite.prepare('SELECT * FROM blog_media_put_audit').get();
      assert.equal(put.state,ambiguous?'unknown':'confirmed');
      assert.equal((await call(f,'/v1/media/upload',input,id)).status,409);
      assert.equal(f.count('blog_operation_audit'),1);
      assert.equal(f.sqlite.prepare('SELECT status FROM blog_operation_audit').get().status,200);
      assert.equal((await call(f,'/v1/media/upload',input)).status,200);
      assert.equal(f.count('blog_media_put_audit'),1);assert.equal(f.counts.put,1);
      assert.equal(JSON.stringify(row).includes(input.variants[0].data),false);
    } finally {f.close();}
  }
});
test('audit start/attempt/confirmation failures stop writes and never publish unaudited media',async()=>{
  for(const phase of ['start','attempt','confirmation']) {
    const f=previewFixture();f.enable();
    try {
      f.hooks.beforeRun=sql=>{
        if((phase==='start'&&sql.includes('INSERT INTO blog_operation_audit'))
          ||(phase==='attempt'&&sql.includes('INSERT INTO blog_media_put_audit'))
          ||(phase==='confirmation'&&sql.includes('UPDATE blog_media_put_audit'))) throw new Error('audit unavailable');
      };
      const response=await call(f,'/v1/media/upload',await image());
      assert.equal(response.status,503);assert.equal((await response.json()).code,'BLOG_AUDIT_UNAVAILABLE');
      assert.equal(f.counts.put,phase==='confirmation'?1:0);
      assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM blog_media WHERE state='ready'").get().n,0);
      if(phase==='confirmation') assert.equal(f.sqlite.prepare('SELECT state FROM blog_media_put_audit').get().state,'attempted');
    } finally {f.close();}
  }
});
test('lost audit finish is explicit 503; same logical save retry cannot duplicate revision',async()=>{
  const f=previewFixture();f.enable();
  try {
    const input={post:{title:'Private draft not in audit',slug:'audit-test',blocks:[{type:'paragraph',text:'Secret text'}]}};
    const key=randomUUID();
    f.hooks.beforeRun=sql=>{if(sql.includes("SET state='finished'"))throw new Error('audit lost');};
    assert.equal((await call(f,'/v1/save',input,randomUUID(),key)).status,503);
    assert.equal(f.count('blog_revisions'),1);
    f.hooks.beforeRun=null;
    assert.equal((await call(f,'/v1/save',input,randomUUID(),key)).status,200);
    assert.equal(f.count('blog_revisions'),1);
    assert.equal(JSON.stringify(f.sqlite.prepare('SELECT * FROM blog_operation_audit').all()).includes('Secret text'),false);
  } finally {f.close();}
});
test('hourly maintenance is bounded, honors ms/seconds and retention, preserves fences/content',async()=>{
  const f=previewFixture();f.enable();
  try {
    const now=Date.now(),sec=Math.floor(now/1000);
    const insert=f.sqlite.prepare('INSERT INTO blog_request_replays VALUES (?,?,?,?,?)');
    for(let i=0;i<501;i++)insert.run('preview','expired-'+i,f.actorId,sec-600,sec-1);
    insert.run('preview','valid',f.actorId,sec,sec+300);
    f.sqlite.prepare('INSERT INTO blog_idempotency VALUES (?,?,?,?,?,?,?,?,?)')
      .run('preview',f.actorId,'save','expired','sha','complete','{}',now-1000,now-1);
    f.sqlite.prepare('INSERT INTO blog_idempotency VALUES (?,?,?,?,?,?,?,?,?)')
      .run('preview',f.actorId,'save','valid','sha','complete','{}',now,now+1000);
    f.sqlite.prepare('INSERT INTO blog_media VALUES (?,?,?,?,?,?,?,?)').run('hash','[]','pending','owner',99,sec-10,sec-100,null);
    f.sqlite.prepare(`INSERT INTO blog_operation_audit VALUES (?,?,?,?,'started',?,NULL,NULL,NULL,NULL,?)`)
      .run('old',f.actorId,'save','sha',sec-31*86400,sec-1);
    f.sqlite.prepare(`INSERT INTO blog_operation_audit VALUES (?,?,?,?,'started',?,NULL,NULL,NULL,NULL,?)`)
      .run('retain',f.actorId,'save','sha',sec,sec+30*86400);
    f.sqlite.prepare('INSERT INTO blog_media_put_audit VALUES (?,?,?,?,?,?,?)').run('old',1,'path',12,'attempted',sec-31*86400,null);
    assert.equal((await readMaintenanceStatus(f.db)).stale,true);
    const result=await maintainBlogPreview(f.db,{now});
    assert.equal(result.deleted.blog_request_replays,500);assert.equal(result.warning,true);
    assert.equal(f.count('blog_request_replays'),2);assert.equal(f.count('blog_idempotency'),1);
    assert.equal(f.count('blog_operation_audit'),1);assert.equal(f.count('blog_media_put_audit'),0);
    assert.equal(f.sqlite.prepare('SELECT fence FROM blog_media').get().fence,99);
    assert.equal(f.count('blog_access_grants'),1);assert.equal((await readMaintenanceStatus(f.db)).stale,false);
    assert.equal((await maintainBlogPreview(f.db,{now})).warning,false);
    await worker.scheduled({}, {BLOG_DB:f.db});
    assert.equal((await readMaintenanceStatus(f.db)).stale,false);
    f.sqlite.prepare("UPDATE blog_migration_settings SET value=? WHERE setting='maintenance_status'")
      .run(JSON.stringify({completedAt:sec-3*3600-1}));
    assert.equal((await readMaintenanceStatus(f.db)).stale,true);
    f.hooks.beforeRun=()=>{throw new Error('cron DB unavailable');};
    await assert.rejects(worker.scheduled({}, {BLOG_DB:f.db}),/BLOG_MAINTENANCE_FAILED/);
  }finally{f.close();}
});
