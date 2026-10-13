import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID,webcrypto} from 'node:crypto';
import vm from 'node:vm';
import {createServer} from 'node:http';
import {createCloudflareProductionHandler} from '../src/blog-cloudflare-production.mjs';
import {previewFixture} from './helpers/blog-preview-fixture.mjs';
import {saveDraft,readDraft} from '../cloudflare/blog-preview/draft-store.mjs';
import {changePublication,publicPost} from '../cloudflare/blog-preview/production-store.mjs';
import {migrateStaticBlogHtml} from '../src/blog-static-migration.mjs';
const ui=await readFile(new URL('../public/admin-blog.js',import.meta.url),'utf8');
const config=JSON.parse(await readFile(new URL('../vercel.json',import.meta.url),'utf8'));
const snapshot=await readFile(new URL('../public/blog/snapshots/trustscore-la-gi.html',import.meta.url),'utf8');
const root=new URL('../public/',import.meta.url);
const sha=value=>createHash('sha256').update(value).digest('hex');
const env=actorId=>({environment:'production',actorId,requestId:randomUUID(),idempotencyKey:randomUUID(),bodyHash:sha(randomUUID())});
function res(){return {headers:{},statusCode:200,setHeader(k,v){this.headers[k.toLowerCase()]=v;},status(v){this.statusCode=v;return this;},json(v){this.body=v;return this;},end(v){this.body=v;return this;}};}
function req(body={},method='POST'){return {method,query:{route:'admin',...(method==='GET'?body:{})},body,headers:{host:'www.realview.com.vn',origin:'https://www.realview.com.vn'}};}
function client(fetchImpl,storage=new Map()){
 const context=vm.createContext({crypto:webcrypto,TextEncoder,API_URL:'/api/admin-blog',requestKeys:new Map(),requestFlights:new Map(),uid:randomUUID,fetch:fetchImpl,
 sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},ApiError:class extends Error{constructor(m,s,p){super(m);this.status=s;this.payload=p;}}});
 vm.runInContext(ui.slice(ui.indexOf('async function apiPost(body)'),ui.indexOf('\nfunction publicationNotice('))+'\nglobalThis.send=apiPost;',context);
 return context.send;
}
const ok=payload=>({ok:true,status:200,json:async()=>payload});

test('completed publish/unpublish/publish commands get new keys; concurrent double-submit shares one request',async()=>{
 const sent=[];let unblock;const send=client(async(_,o)=>{sent.push(JSON.parse(o.body));if(sent.length===1)await new Promise(r=>unblock=r);return ok({id:'fixture',revision:1});});
 const publish={action:'publish',id:'fixture',expectedRevision:1};
 const first=send(publish),double=send(publish);while(!unblock)await new Promise(r=>setImmediate(r));unblock();await Promise.all([first,double]);assert.equal(sent.length,1);
 await send({action:'unpublish',id:'fixture',expectedRevision:1});await send(publish);
 assert.equal(new Set(sent.map(s=>s.idempotencyKey)).size,3);
});

test('unknown ACK retains key across tab reload, definite reject retires key, 202 retires committed key',async()=>{
 const storage=new Map(),sent=[];const publish={action:'publish',id:'fixture',expectedRevision:1};
 const send=client(async(_,o)=>{sent.push(JSON.parse(o.body));throw Error('ACK lost');},storage);
 await assert.rejects(send(publish));assert.equal(storage.size,1);assert.ok([...storage.keys()].every(k=>/^rv-blog-command:[a-f0-9]{64}$/.test(k)));
 const reloaded=client(async(_,o)=>{sent.push(JSON.parse(o.body));return ok({id:'fixture',publication:{status:'pending'}});},storage);
 await reloaded(publish);assert.equal(sent[0].idempotencyKey,sent[1].idempotencyKey);assert.equal(storage.size,0);
 await reloaded(publish);assert.notEqual(sent[1].idempotencyKey,sent[2].idempotencyKey);
 let count=0;const rejected=[];const retry=client(async(_,o)=>{rejected.push(JSON.parse(o.body));if(++count===1)return {ok:false,status:409,json:async()=>({error:'conflict'})};return ok({});});
 await assert.rejects(retry(publish));await retry(publish);assert.notEqual(rejected[0].idempotencyKey,rejected[1].idempotencyKey);
});

test('UI keys republish the same revision in the actual in-memory publication store',async()=>{
 const f=previewFixture();f.enable();f.sqlite.prepare("UPDATE blog_access_grants SET role='admin'").run();
 try{const saved=await saveDraft(f.db,{post:{title:'Fixture',slug:'fixture',blocks:[]}},env(f.actorId)),record=await readDraft(f.db,saved.id);
 const send=client(async(_,options)=>{const body=JSON.parse(options.body);const result=await changePublication(f.db,{...body,html:'<html>fixture</html>',documentHash:record.documentHash},{...env(f.actorId),idempotencyKey:body.idempotencyKey});return ok(result);});
 const input={action:'publish',id:saved.id,expectedRevision:1};await send(input);await send({...input,action:'unpublish'});assert.equal((await publicPost(f.db,'fixture')).kind,'gone');await send(input);assert.equal((await publicPost(f.db,'fixture')).kind,'published');
 }finally{f.close();}
});

function verificationHandler({visible=true,indexable=true,worker,fetcher}={}){
 const post=migrateStaticBlogHtml(snapshot,{sourcePath:'trustscore-la-gi.html'}).post;
 post.settings.allowIndexing=indexable;let mutations=0;
 const detail={id:randomUUID(),revision:1,slug:post.slug,post,documentHash:'fixture',meta:{slug:post.slug,status:'published',publishedAt:'2026-09-11T00:00:00Z'}};
 const handler=createCloudflareProductionHandler({currentAccountImpl:async()=>({id:'fixture'}),loggerImpl:()=>{},invalidateImpl:async()=>{},
 workerCallImpl:worker||(async path=>{if(path==='/v1/read')return detail;if(path==='/v1/publication'){mutations++;return detail;}throw Error(path);}),
 fetchImpl:fetcher||(async url=>url.endsWith('/'+post.slug)?new Response('article',{headers:{'x-blog-revision':'1'}}):new Response(visible&&indexable?(url.endsWith('sitemap.xml')?`<urlset><url><loc>https://www.realview.com.vn/bai-viet/${post.slug}</loc></url></urlset>`:`<a href="/bai-viet/${post.slug}">Post</a>`):''))});
 return {handler,detail,mutations:()=>mutations};
}
test('missing hub/sitemap is acknowledged as committed pending; read-only recheck never mutates',async()=>{
 const f=verificationHandler({visible:false});const response=res();await f.handler(req({action:'publish',id:f.detail.id,expectedRevision:1,idempotencyKey:randomUUID()}),response);
 assert.equal(response.statusCode,202);assert.equal(response.body.publication.checks.article,true);assert.equal(response.body.publication.checks.index,false);assert.equal(response.body.publication.checks.sitemap,false);
 const recheck=res();await f.handler(req({action:'verify_publication',id:f.detail.id,expectedRevision:1,publicationAction:'publish'},'GET'),recheck);
 assert.equal(recheck.statusCode,202);assert.equal(f.mutations(),1);
});
test('all public surfaces must verify; intentionally noindex post must remain absent from hub/sitemap',async()=>{
 for(const indexable of [true,false]){const f=verificationHandler({indexable});const response=res();await f.handler(req({action:'publish',id:f.detail.id,expectedRevision:1,idempotencyKey:randomUUID()}),response);assert.equal(response.statusCode,200);assert.equal(response.body.publication.status,'verified');}
});
test('verification rejects changed authoritative state and cannot be called unauthenticated',async()=>{
 const f=verificationHandler();const response=res();await f.handler(req({action:'verify_publication',id:f.detail.id,expectedRevision:2,publicationAction:'publish'},'GET'),response);assert.equal(response.statusCode,409);assert.equal(f.mutations(),0);
 const denied=createCloudflareProductionHandler({currentAccountImpl:async()=>null});const out=res();await denied(req({action:'verify_publication',id:f.detail.id},'GET'),out);assert.equal(out.statusCode,401);
});
test('unpublish verifies 410 AND removal from hub/sitemap, not just a successful article response',async()=>{
 const f=verificationHandler({fetcher:async url=>url.endsWith('/trustscore-la-gi')?new Response('',{status:410}):new Response('')});const response=res();await f.handler(req({action:'unpublish',id:f.detail.id,expectedRevision:1,idempotencyKey:randomUUID()}),response);assert.equal(response.statusCode,200);
 const stale=verificationHandler({fetcher:async url=>url.endsWith('/trustscore-la-gi')?new Response('',{status:410}):new Response('<a href="/bai-viet/trustscore-la-gi">stale</a>')});const output=res();await stale.handler(req({action:'unpublish',id:stale.detail.id,expectedRevision:1,idempotencyKey:randomUUID()}),output);assert.equal(output.statusCode,202);
});

test('actual HTTP requests through Vercel rewrite config preserve every legacy snapshot and honor CMS/tombstones',async()=>{
 const routes=config.rewrites.filter(r=>r.source.startsWith('/bai-viet/')&&!r.source.includes(':')&&r.destination.includes('route=post'));
 assert.equal(routes.length,19);assert.equal(config.rewrites.find(r=>r.source==='/bai-viet').destination,'/api/blog.mjs?route=index');assert.equal(config.rewrites.find(r=>r.source==='/sitemap.xml').destination,'/api/blog.mjs?route=sitemap');
 let record={kind:'snapshot'};const handler=createCloudflareProductionHandler({publicWorkerCallImpl:async()=>record});
 const server=createServer(async(request,response)=>{const rule=config.rewrites.find(r=>r.source===new URL(request.url,'http://localhost').pathname);const target=new URL(rule.destination,'http://localhost');response.status=v=>(response.statusCode=v,response);response.json=v=>response.end(JSON.stringify(v));await handler({method:request.method,query:Object.fromEntries(target.searchParams)},response);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{for(const route of routes){const slug=route.source.split('/').at(-1);assert.equal(route.destination,`/api/blog.mjs?route=post&slug=${slug}`);const r=await fetch(base+route.source);assert.equal(r.status,200);assert.equal(await r.text(),await readFile(new URL(`blog/snapshots/${slug}.html`,root),'utf8'));const head=await fetch(base+route.source,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');}
 record={kind:'published',html:'<html>Published only</html>',revision:2};let r=await fetch(base+routes[0].source);assert.equal(await r.text(),record.html);assert.equal(r.headers.get('x-blog-revision'),'2');
 record={kind:'gone'};r=await fetch(base+routes[0].source);assert.equal(r.status,410);assert.equal(r.headers.get('vercel-cdn-cache-control'),'no-store');
 }finally{await new Promise(r=>server.close(r));}
});


test('hosted preview public routes read the same public CMS without enabling admin writes',async()=>{
 const {default:router,blogRouterInternals}=await import('../api/blog.mjs');
 assert.equal(blogRouterInternals.previewPublicRoutes.has('admin'),false);
 assert.equal(blogRouterInternals.previewPublicRoutes.has('access-admin'),false);
 const previous={env:process.env.VERCEL_ENV,backend:process.env.BLOG_STORAGE_BACKEND,fetch:globalThis.fetch};
 process.env.VERCEL_ENV='preview';delete process.env.BLOG_STORAGE_BACKEND;let reads=0;
 globalThis.fetch=async url=>{assert.equal(new URL(url).pathname,'/public/list');reads++;return new Response(JSON.stringify({posts:[],changed:false}),{headers:{'content-type':'application/json'}});};
 try{
  const index=res();await router({method:'GET',query:{route:'index'}},index);assert.equal(index.statusCode,200);assert.equal(reads,1);
  const denied=res();await router({method:'POST',query:{route:'post',slug:'trustscore-la-gi'}},denied);assert.equal(denied.statusCode,405);assert.equal(reads,1);
 }finally{
  globalThis.fetch=previous.fetch;
  if(previous.env===undefined)delete process.env.VERCEL_ENV;else process.env.VERCEL_ENV=previous.env;
  if(previous.backend===undefined)delete process.env.BLOG_STORAGE_BACKEND;else process.env.BLOG_STORAGE_BACKEND=previous.backend;
 }
});
