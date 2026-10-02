import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {readEncryptedBlogBackup} from './blog-grant-mapping.mjs';
import {signBlogRequest} from '../cloudflare/blog-preview/request-auth.mjs';
const args=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
const origin='https://realview-blog-preview.wwpk-cloudflare-relay.workers.dev';
async function main(){
  if(args.confirm!=='preview-only'||!args.mapping||!args.key||!args.secret)throw new Error('PREVIEW_ARGS_REQUIRED');
  const report=await readEncryptedBlogBackup(args.mapping,args.key);
  const secret=(await readFile(args.secret,'utf8')).trim();
  const rows=report.mappings.filter(r=>r.mappingStatus==='mapped'&&!r.legacyRevoked);
  const metrics={requests:0,d1RowsRead:0,d1RowsWritten:0,statuses:[],roles:{admin:0,editor:0}};
  const build=async(r,path,body,timestamp=Math.floor(Date.now()/1000))=>{
    const bytes=new TextEncoder().encode(JSON.stringify(body)),url=origin+path;
    const headers=await signBlogRequest({secret,environment:'preview',method:'POST',url,body:bytes,
      actorId:r.actorId,requestId:randomUUID(),timestamp,idempotencyKey:randomUUID(),contentType:'application/json'});
    return {url,headers,body:bytes};
  };
  const call=async request=>{
    const response=await fetch(request.url,{method:'POST',headers:request.headers,body:request.body,redirect:'error',signal:AbortSignal.timeout(15_000)});
    metrics.requests++;metrics.statuses.push(response.status);
    metrics.d1RowsRead+=Number(response.headers.get('X-Blog-D1-Rows-Read')||0);
    metrics.d1RowsWritten+=Number(response.headers.get('X-Blog-D1-Rows-Written')||0);
    return response;
  };
  const expect=(condition)=>{if(!condition)throw new Error('PREVIEW_PERMISSION_PROBE_FAILED');};
  for(const r of rows){
    const response=await call(await build(r,'/v1/read',{action:'access'}));expect(response.status===200);
    const payload=await response.json();expect(payload.role===r.role&&payload.readOnly===true
      &&payload.capabilities.publishPosts===false&&payload.capabilities.manageAccess===false);
    metrics.roles[r.role]++;
    // Invalid empty write is intentional: read-only must reject BEFORE parsing
    // or writing a draft/media/audit row, even for a valid administrator.
    expect((await call(await build(r,'/v1/save',{}))).status===503);
  }
  expect(rows.length>0);
  const envelope=await build(rows[0],'/v1/read',{action:'access'});
  expect((await call(envelope)).status===200);expect((await call(envelope)).status===409);
  expect((await call(await build(rows[0],'/v1/read',{action:'access'},Math.floor(Date.now()/1000)-301))).status===401);
  expect((await call(await build(rows[0],'/v1/publish',{}))).status===404);
  console.log(JSON.stringify({passed:true,readOnly:true,...metrics,note:'Signed Worker permission checks, not a browser-session end-to-end test.'}));
}
main().catch(error=>{console.error(error.message?.startsWith('PREVIEW_')?error.message:'PREVIEW_PERMISSION_PROBE_FAILED: private data suppressed');process.exitCode=1;});
