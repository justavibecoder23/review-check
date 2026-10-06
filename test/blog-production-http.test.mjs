import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createCloudflareProductionHandler} from '../src/blog-cloudflare-production.mjs';
import {previewFixture} from './helpers/blog-preview-fixture.mjs';
import {importLegacy,changePublication,publicPost,listProductionPosts} from '../cloudflare/blog-preview/production-store.mjs';
import {readDraft} from '../cloudflare/blog-preview/draft-store.mjs';
import {migrateStaticBlogHtml} from '../src/blog-static-migration.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
function response(){return {headers:{},statusCode:200,setHeader(k,v){this.headers[k.toLowerCase()]=v;},status(v){this.statusCode=v;return this;},json(v){this.body=v;return this;},end(v){this.body=v;return this;}};}
const request=(route,body={},method='GET')=>({method,query:{route,...(method==='GET'?body:{})},body,
  headers:{host:'www.realview.com.vn',origin:'https://www.realview.com.vn','sec-fetch-site':'same-origin'}});

test('production HTTP preserves snapshot bytes, blocks tombstone fallback and temporary errors are 503 no-store',async()=>{
  const slug='trustscore-la-gi',html=await readFile(new URL('../public/blog/snapshots/'+slug+'.html',import.meta.url),'utf8');
  for(const [record,status] of [[{kind:'snapshot'},200],[{kind:'gone'},410],[null,503]]){
    const handler=createCloudflareProductionHandler({publicWorkerCallImpl:async()=>{if(!record)throw Error('network');return record;}});
    const res=response();await handler(request('post',{slug}),res);
    assert.equal(res.statusCode,status);
    if(status===200){assert.equal(res.body,html);assert.equal(res.headers['vercel-cache-tag'],'realview-blog-public');}
    else {assert.match(res.headers['cache-control'],/no-store/);assert.notEqual(res.body,html);}
  }
});
test('production HTTP list and detail call only D1 bridge even with an old Blob token present',async()=>{
  const old=process.env.BLOB_READ_WRITE_TOKEN;process.env.BLOB_READ_WRITE_TOKEN='retired-token-must-not-be-used';
  const calls=[];try{
    const handler=createCloudflareProductionHandler({currentAccountImpl:async()=>({id:'test-account'}),workerCallImpl:async(path,input)=>{
      calls.push({path,action:input.action});return {backend:'cloudflare',posts:[],post:{title:'D1 draft'}};
    }});
    const list=response(),detail=response();await handler(request('admin',{action:'list'}),list);await handler(request('admin',{action:'detail',id:randomUUID()}),detail);
    assert.equal(list.statusCode,200);assert.equal(detail.body.post.title,'D1 draft');
    assert.deepEqual(calls,[{path:'/v1/read',action:'list'},{path:'/v1/read',action:'detail'}]);
    assert.equal(list.headers['x-blog-storage-backend'],'cloudflare');
  }finally{if(old===undefined)delete process.env.BLOB_READ_WRITE_TOKEN;else process.env.BLOB_READ_WRITE_TOKEN=old;}
});
test('production publish commits D1 before invalidation and verifies public revision before success',async()=>{
  const f=previewFixture();f.enable();const slug='trustscore-la-gi';
  try{
    const html=await readFile(new URL('../public/blog/snapshots/'+slug+'.html',import.meta.url),'utf8');
    const post=migrateStaticBlogHtml(html,{sourcePath:slug+'.html'}).post;
    f.sqlite.prepare("INSERT INTO blog_slugs VALUES (?,'snapshot',?,0)").run(slug,slug+'.html');
    f.sqlite.prepare('INSERT INTO blog_legacy_articles VALUES (?,?,?,?)').run(slug,JSON.stringify({...post,publishedAt:'2026-09-11T00:00:00Z'}),hash(html),slug+'.html');
    const e={environment:'production',actorId:f.actorId,requestId:randomUUID(),idempotencyKey:randomUUID(),bodyHash:hash('import')};
    const saved=await importLegacy(f.db,{post,sourceHash:hash(html)},e);
    const order=[];
    const handler=createCloudflareProductionHandler({currentAccountImpl:async()=>({id:f.actorId}),workerCallImpl:async(path,input,_actor,options)=>{
      if(path==='/v1/read')return readDraft(f.db,input.id);
      if(path==='/v1/publication'){const result=await changePublication(f.db,input,{...e,requestId:randomUUID(),idempotencyKey:options.idempotencyKey,bodyHash:hash(JSON.stringify(input))});order.push('commit');return result;}
      throw Error('Unexpected non-D1 route');
    },invalidateImpl:async()=>{assert.equal((await publicPost(f.db,slug)).kind,'published');order.push('invalidate');},
    fetchImpl:async()=>{order.push('verify');return new Response('ok',{headers:{'x-blog-revision':'1'}});}});
    const res=response();await handler(request('admin',{action:'publish',id:saved.id,expectedRevision:1,idempotencyKey:randomUUID()},'POST'),res);
    assert.equal(res.statusCode,200,JSON.stringify(res.body));assert.deepEqual(order,['commit','invalidate','verify']);
    assert.equal((await listProductionPosts(f.db,{publicOnly:true})).length,1);
  }finally{f.close();}
});

test('opening legacy editor writes no revision; explicit first save writes D1 and keeps public snapshot',async()=>{
  const f=previewFixture();f.enable();const slug='trustscore-la-gi';
  try{
    const html=await readFile(new URL('../public/blog/snapshots/'+slug+'.html',import.meta.url),'utf8');
    const original=migrateStaticBlogHtml(html,{sourcePath:slug+'.html'}).post;
    f.sqlite.prepare("INSERT INTO blog_slugs VALUES (?,'snapshot',?,0)").run(slug,slug+'.html');
    f.sqlite.prepare('INSERT INTO blog_legacy_articles VALUES (?,?,?,?)').run(slug,JSON.stringify(original),hash(html),slug+'.html');
    const handler=createCloudflareProductionHandler({currentAccountImpl:async()=>({id:f.actorId}),workerCallImpl:async(path,input,_actor,options)=>{
      if(path==='/v1/read')return {authorized:true,readOnly:false};
      if(path==='/v1/import')return importLegacy(f.db,input,{environment:'production',actorId:f.actorId,requestId:randomUUID(),idempotencyKey:options.idempotencyKey,bodyHash:hash(JSON.stringify(input))});
      throw Error('Unexpected write');
    }});
    const opened=response();await handler(request('admin',{action:'import_legacy',slug},'POST'),opened);
    assert.equal(opened.statusCode,200);assert.equal(f.count('blog_revisions'),0);
    const body={action:'save',id:`static:${slug}`,expectedRevision:0,post:{...opened.body.post,title:'Bản nháp được sửa'},idempotencyKey:randomUUID()};
    const saved=response();await handler(request('admin',body,'POST'),saved);
    assert.equal(saved.statusCode,200);assert.equal(f.count('blog_revisions'),1);
    assert.equal((await publicPost(f.db,slug)).kind,'snapshot');assert.equal(f.count('blog_published'),0);
    const retry=response();await handler(request('admin',body,'POST'),retry);
    assert.equal(retry.statusCode,200);assert.equal(f.count('blog_revisions'),1);
    const competing=response();await handler(request('admin',{...body,idempotencyKey:randomUUID()},'POST'),competing);
    assert.equal(competing.statusCode,409);assert.equal(f.count('blog_revisions'),1);
  }finally{f.close();}
});
