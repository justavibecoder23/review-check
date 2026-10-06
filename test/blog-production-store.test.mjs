import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { previewFixture } from './helpers/blog-preview-fixture.mjs';
import { saveDraft,readDraft } from '../cloudflare/blog-preview/draft-store.mjs';
import { importLegacy,changePublication,publicPost,listProductionPosts,manageGrants } from '../cloudflare/blog-preview/production-store.mjs';
import worker from '../cloudflare/blog-preview/worker.mjs';
import { signBlogRequest } from '../cloudflare/blog-preview/request-auth.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const post={title:'Bài thử',slug:'bai-thu',category:'doc-review',blocks:[{type:'paragraph',text:'Nội dung thử'}],heroImage:{url:'/assets/blog/test.jpg',alt:'Ảnh thử'}};
function envelope(actorId,body={}) {return {environment:'production',actorId,requestId:randomUUID(),idempotencyKey:randomUUID(),bodyHash:sha(JSON.stringify(body))};}

test('production save uses production cycle, preserves public pointer on draft edit and rejects slug drift',async()=>{
  const f=previewFixture();f.enable();try{
    const input={post},e=envelope(f.actorId,input);
    const saved=await saveDraft(f.db,input,e);
    assert.equal(f.sqlite.prepare('SELECT environment FROM blog_idempotency').get().environment,'production');
    const record=await readDraft(f.db,saved.id);
    const published=await changePublication(f.db,{action:'publish',id:saved.id,expectedRevision:1,html:'<html>first</html>',documentHash:record.documentHash},envelope(f.actorId));
    assert.equal((await publicPost(f.db,post.slug)).html,'<html>first</html>');
    await saveDraft(f.db,{id:saved.id,expectedRevision:1,post:{...post,title:'Bản nháp mới'}},envelope(f.actorId));
    assert.equal((await publicPost(f.db,post.slug)).revision,1);
    assert.equal((await readDraft(f.db,saved.id)).meta.publishedRevision,1);
    await assert.rejects(saveDraft(f.db,{id:saved.id,expectedRevision:2,post:{...post,slug:'doi-slug'}},envelope(f.actorId)),{code:'BLOG_SLUG_CHANGE_REQUIRES_MIGRATION'});
    assert.equal(published.meta.hasUnpublishedChanges,false);
  }finally{f.close();}
});
test('publication retries are idempotent, stale/revoked commits cannot alter public content',async()=>{
  const f=previewFixture();f.enable();try{
    const saved=await saveDraft(f.db,{post},envelope(f.actorId)),record=await readDraft(f.db,saved.id);
    const input={action:'publish',id:saved.id,expectedRevision:1,html:'<html>first</html>',documentHash:record.documentHash},e=envelope(f.actorId,input);
    await changePublication(f.db,input,e);await changePublication(f.db,input,e);
    await changePublication(f.db,{...input,html:'<html>retry render</html>'},{...e,bodyHash:sha('another-render')});
    assert.equal((await publicPost(f.db,post.slug)).generation,1);
    await assert.rejects(changePublication(f.db,{...input,expectedRevision:2},envelope(f.actorId)),{code:'BLOG_REVISION_CONFLICT'});
    f.hooks.beforeBatch=()=>f.sqlite.exec('UPDATE blog_access_grants SET active=0');
    await assert.rejects(changePublication(f.db,{action:'unpublish',id:saved.id,expectedRevision:1},envelope(f.actorId)),{code:'BLOG_ACCESS_DENIED'});
    assert.equal((await publicPost(f.db,post.slug)).html,'<html>first</html>');
  }finally{f.close();}
});
test('legacy import keeps snapshots live, only creates new history; unpublish tombstone forbids fallback',async()=>{
  const f=previewFixture();f.enable();try{
    f.sqlite.prepare("INSERT INTO blog_slugs VALUES (?,'snapshot',?,0)").run(post.slug,'original.html');
    f.sqlite.prepare('INSERT INTO blog_legacy_articles VALUES (?,?,?,?)').run(post.slug,JSON.stringify({...post,status:'published',publishedAt:'2026-09-01T00:00:00Z'}),sha('original'),'original.html');
    const saved=await importLegacy(f.db,{post,sourceHash:sha('original')},envelope(f.actorId));
    assert.equal(saved.revision,1);assert.equal(f.count('blog_revisions'),1);assert.equal(f.count('blog_published'),0);
    assert.equal((await publicPost(f.db,post.slug)).kind,'snapshot');
    assert.equal((await listProductionPosts(f.db,{publicOnly:true})).length,1);
    assert.equal((await listProductionPosts(f.db))[0].heroImage.url,post.heroImage.url);
    await changePublication(f.db,{action:'unpublish',id:saved.id,expectedRevision:1},envelope(f.actorId));
    assert.equal((await publicPost(f.db,post.slug)).kind,'gone');
    assert.equal((await listProductionPosts(f.db,{publicOnly:true})).length,0);
    await assert.rejects(saveDraft(f.db,{post},envelope(f.actorId)),{code:'BLOG_SLUG_CONFLICT'});
  }finally{f.close();}
});
test('production Worker rejects unsigned writes and keeps unpublished media private',async()=>{
  const f=previewFixture();f.enable();try{
    const env={BLOG_ENVIRONMENT:'production',BLOG_DB:f.db,BLOG_MEDIA:f.bucket,BLOG_HMAC_SECRET:'production-secret-value-at-least-32-characters'};
    const unsigned=await worker.fetch(new Request('https://example.com/v1/save',{method:'POST',body:JSON.stringify({post})}),env);
    assert.equal(unsigned.status,401);assert.equal(f.count('blog_drafts'),0);
    const bytes=new TextEncoder().encode(JSON.stringify({post}));
    const headers=await signBlogRequest({secret:env.BLOG_HMAC_SECRET,environment:'production',method:'POST',url:'https://example.com/v1/save',
      timestamp:Math.floor(Date.now()/1000),requestId:randomUUID(),actorId:f.actorId,idempotencyKey:randomUUID(),contentType:'application/json',body:bytes});
    const response=await worker.fetch(new Request('https://example.com/v1/save',{method:'POST',headers,body:bytes}),env);
    assert.equal(response.status,200);
    const privateMedia=await worker.fetch(new Request('https://example.com/public/media?hash='+sha('image')+'&width=480'),env);
    assert.equal(privateMedia.status,404);
    assert.equal(f.count('blog_published'),0);
  }finally{f.close();}
});
test('grant management denies editor and cannot remove last active admin',async()=>{
  const f=previewFixture();f.enable();try{
    await assert.rejects(manageGrants(f.db,{action:'list'},envelope(f.actorId)),{code:'BLOG_ACCESS_DENIED'});
    const id=randomUUID();f.sqlite.prepare('UPDATE blog_access_grants SET actor_id=?,role=?').run(id,'admin');
    await assert.rejects(manageGrants(f.db,{action:'revoke',actorId:id,role:'editor',active:false,startsAt:0,expiresAt:null,email:'test@example.com'},envelope(id)));
    assert.equal(f.sqlite.prepare('SELECT active FROM blog_access_grants').get().active,1);
  }finally{f.close();}
});
