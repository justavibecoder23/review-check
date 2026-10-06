import { randomUUID } from 'node:crypto';
import { signBlogRequest } from '../cloudflare/blog-preview/request-auth.mjs';

export function productionBlogEnabled(env=process.env) {return env.BLOG_STORAGE_BACKEND==='cloudflare'||env.VERCEL_ENV==='production';}
export function blogWorkerOrigin(env=process.env) {
  const url=new URL(env.BLOG_WORKER_URL||'https://realview-blog.wwpk-cloudflare-relay.workers.dev');
  if(url.origin!=='https://realview-blog.wwpk-cloudflare-relay.workers.dev'||url.pathname!=='/'||url.search||url.hash) {
    throw Object.assign(new Error('BLOG_WORKER_URL_INVALID'),{code:'BLOG_WORKER_URL_INVALID',statusCode:503});
  }
  return url;
}
export async function productionWorkerCall(path,payload,actorId,options={}) {
  const env=options.env||process.env,target=new URL(path,blogWorkerOrigin(env));
  const body=new TextEncoder().encode(JSON.stringify(payload));
  if(body.length>4300000)throw Object.assign(new Error('BLOG_BODY_TOO_LARGE'),{statusCode:413});
  const headers=await signBlogRequest({secret:env.BLOG_HMAC_SECRET,environment:'production',method:'POST',url:target.toString(),
    timestamp:Math.floor(Date.now()/1000),requestId:randomUUID(),actorId,idempotencyKey:options.idempotencyKey||randomUUID(),
    contentType:'application/json',body});
  let response;
  try {response=await(options.fetchImpl||fetch)(target,{method:'POST',headers,body,redirect:'error',signal:AbortSignal.timeout(24000)});}
  catch {throw Object.assign(new Error('BLOG_WORKER_RETRY'),{code:'BLOG_WORKER_RETRY',statusCode:503});}
  if(options.raw&&response.ok)return response;
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(new Error(result.code||'BLOG_WORKER_RETRY'),{...result,statusCode:response.status});
  return result;
}
export async function publicWorkerCall(path,params={},options={}) {
  const target=new URL(path,blogWorkerOrigin(options.env));
  for(const [key,value] of Object.entries(params))target.searchParams.set(key,String(value));
  const response=await(options.fetchImpl||fetch)(target,{redirect:'error',signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw Object.assign(new Error('BLOG_PUBLIC_RETRY'),{statusCode:response.status});
  return options.raw?response:response.json();
}
