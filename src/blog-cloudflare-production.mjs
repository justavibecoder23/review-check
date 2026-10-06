import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { currentAccount } from '../api/auth.mjs';
import { redisCommand } from './redis-rest.mjs';
import { productionWorkerCall as call, publicWorkerCall } from './blog-cloudflare-client.mjs';
import { preparePreviewMedia } from './blog-cloudflare-preview.mjs';
import { parseRequestBody,sendAdminJson,firstQueryValue } from './blog-admin-http.mjs';
import { normalizeBlogPost,validateBlogPost } from './blog-post-model.mjs';
import { migrateStaticBlogHtml } from './blog-static-migration.mjs';
import { renderBlogPost,renderBlogIndexTemplate,renderSitemap,renderRss } from './blog-renderer.mjs';
import { renderBlogPreviewDocument } from './blog-admin-preview.mjs';
import { summaryToBlogRecord } from './blog-public-data.mjs';
import { STATIC_SITEMAP_ENTRIES } from './blog-public-config.mjs';
import { invalidateByTag } from '@vercel/functions';

const TAG='realview-blog-public';
const fail=(code,statusCode)=>Object.assign(new Error(code),{code,statusCode});
const read=path=>readFile(new URL(`../public/${path}`,import.meta.url),'utf8');
async function legacyRecord(slug) {
  if(!/^[a-z0-9-]{1,160}$/.test(slug))throw fail('BLOG_POST_NOT_FOUND',404);
  const html=await read(`blog/snapshots/${slug}.html`),source=migrateStaticBlogHtml(html,{sourcePath:`public/blog/snapshots/${slug}.html`});
  const sourceHash=createHash('sha256').update(html).digest('hex');
  // Stable editor IDs make import retries deterministic; original HTML is untouched.
  source.post.blocks=source.post.blocks.map((block,index)=>({...block,id:`legacy-${sourceHash.slice(0,16)}-${index}`}));
  return {...source,sourceHash};
}
function sameOrigin(request) {
  const host=String(request.headers?.['x-forwarded-host']||request.headers?.host||'').split(',')[0].trim();
  try {const origin=new URL(request.headers?.origin);if(origin.protocol!=='https:'||origin.host!==host||origin.origin!==request.headers.origin
    ||request.headers?.['sec-fetch-site']==='cross-site')throw Error();}catch{throw fail('INVALID_ORIGIN',403);}
}
function publicHeaders(response,type='text/html; charset=utf-8') {
  response.setHeader('Content-Type',type); response.setHeader('Cache-Control','public, max-age=0, must-revalidate');
  response.setHeader('Vercel-CDN-Cache-Control','public, s-maxage=60, must-revalidate');
  response.setHeader('Vercel-Cache-Tag',TAG);response.setHeader('X-Content-Type-Options','nosniff');
}
async function servePublic(request,response,route,options={}) {
  const currentAccount=options.currentAccountImpl||defaultCurrentAccount;
  const publicWorkerCall=options.publicWorkerCallImpl||defaultPublicWorkerCall;
  const call=options.workerCallImpl||defaultWorkerCall;
  if(!['GET','HEAD'].includes(request.method))throw fail('METHOD_NOT_ALLOWED',405);
  if(route==='cloudflare-media') {
    let object;
    try {object=await publicWorkerCall('/public/media',{hash:firstQueryValue(request.query.hash),width:firstQueryValue(request.query.width)},{raw:true});}
    catch(error) {
      if(error.statusCode!==404)throw error;
      const account=await currentAccount(request);if(!account?.id)throw fail('BLOG_MEDIA_NOT_FOUND',404);
      object=await call('/v1/media/read',{hash:firstQueryValue(request.query.hash),width:firstQueryValue(request.query.width)},account.id,{raw:true});
      response.setHeader('Cache-Control','private, no-store');
      response.setHeader('Vercel-CDN-Cache-Control','private, no-store');
    }
    if(object.headers.get('cache-control')?.includes('immutable')) {
      response.setHeader('Cache-Control','public, max-age=31536000, immutable');
      response.setHeader('Vercel-CDN-Cache-Control','public, s-maxage=31536000, immutable');
    }
    response.setHeader('Content-Type','image/webp');response.setHeader('X-Content-Type-Options','nosniff');
    return response.status(200).end(request.method==='HEAD'?undefined:Buffer.from(await object.arrayBuffer()));
  }
  if(route==='post') {
    const slug=String(firstQueryValue(request.query.slug)||'');
    if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)||slug.length>160)throw fail('BLOG_POST_NOT_FOUND',404);
    const record=await publicWorkerCall('/public/post',{slug});
    if(record.kind==='gone') {response.setHeader('Cache-Control','no-store');return response.status(410).end('Bài viết đã được gỡ đăng.');}
    let html;
    if(record.kind==='published') {html=record.html;response.setHeader('X-Blog-Revision',String(record.revision));}
    else {try {html=await read(`blog/snapshots/${slug}.html`);}catch {throw fail('BLOG_POST_NOT_FOUND',404);}}
    publicHeaders(response);return response.status(200).end(request.method==='HEAD'?undefined:html);
  }
  const {posts,changed}=await publicWorkerCall('/public/list');
  const records=posts.map(summaryToBlogRecord);
  if(route==='public') {
    publicHeaders(response,'application/json; charset=utf-8');return response.status(200).json({posts,managedSlugs:posts.map(p=>p.slug),cmsAvailable:true});
  }
  let output,type='text/html; charset=utf-8';
  if(route==='index')output=!changed?await read('blog/snapshots/index-snapshot.html'):
    renderBlogIndexTemplate(await read('blog.html'),records,{baseUrl:'https://www.realview.com.vn'});
  else if(route==='sitemap') {
    type='application/xml; charset=utf-8';
    output=!changed?await read('blog/snapshots/sitemap-snapshot.xml'):
      renderSitemap(records,STATIC_SITEMAP_ENTRIES.filter(e=>!/^\/bai-viet\/[^/]+$/.test(e.path)),{baseUrl:'https://www.realview.com.vn'});
  } else if(route==='rss') {type='application/rss+xml; charset=utf-8';output=renderRss(records,{baseUrl:'https://www.realview.com.vn',limit:50});}
  else throw fail('INVALID_BLOG_ACTION',404);
  publicHeaders(response,type);return response.status(200).end(request.method==='HEAD'?undefined:output);
}
async function accountByEmail(email) {
  email=String(email||'').trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw fail('INVALID_ACCESS_EMAIL',400);
  const id=await redisCommand(['GET',`realview:account:v1:email:${email}`]);
  const raw=id&&await redisCommand(['GET',`realview:account:v1:user:${id}`]);
  let user;try{user=JSON.parse(raw);}catch{}
  if(!user||user.id!==id||user.email?.toLowerCase()!==email||user.disabledAt||user.deletedAt)throw fail('ACCOUNT_NOT_FOUND',404);
  return user;
}
async function refreshPublished(result,action,options={}) {
  // D1 commit is already durable. Invalidation is NEVER run before that commit.
  try {
    await (options.invalidateImpl||invalidateByTag)(TAG);
    for(const delay of [0,3000,7000]) {
      if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
      const response=await (options.fetchImpl||fetch)(`https://www.realview.com.vn/bai-viet/${result.slug}`,{signal:AbortSignal.timeout(4000)});
      await response.body?.cancel();
      if(action==='publish'?response.ok&&Number(response.headers.get('x-blog-revision'))===result.revision:response.status===410)return;
      await (options.invalidateImpl||invalidateByTag)(TAG);
    }
  }catch{}
  throw fail('BLOG_PUBLICATION_COMMITTED_VERIFY_PENDING',503);
}
const defaultCurrentAccount=currentAccount,defaultWorkerCall=call,defaultPublicWorkerCall=publicWorkerCall;
export function createCloudflareProductionHandler(options={}) {
  const currentAccount=options.currentAccountImpl||defaultCurrentAccount;
  const call=options.workerCallImpl||defaultWorkerCall;
  return async function handler(request,response) {
  const route=String(firstQueryValue(request.query?.route)||'admin');
  try {
    if(['post','index','public','rss','sitemap','cloudflare-media'].includes(route))return await servePublic(request,response,route,options);
    response.setHeader('X-Blog-Storage-Backend','cloudflare');
    if(!['GET','POST','DELETE'].includes(request.method))throw fail('METHOD_NOT_ALLOWED',405);
    const account=await currentAccount(request);if(!account?.id)throw fail('AUTH_REQUIRED',401);
    if(request.method!=='GET')sameOrigin(request);
    const body=request.method==='GET'?request.query:parseRequestBody(request);
    const action=String(firstQueryValue(body.action)||'list');
    const mutationOptions={idempotencyKey:body.idempotencyKey};
    let result;
    if(route==='access-admin') {
      // Check D1 admin privilege BEFORE looking up another account.
      const access=await call('/v1/read',{action:'access'},account.id);
      if(access.role!=='admin')throw fail('BLOG_ACCESS_DENIED',403);
      if(request.method==='GET')result=await call('/v1/grants',{action:'list'},account.id);
      else {
        const target=await accountByEmail(body.email),revoke=request.method==='DELETE'||action==='revoke';
        result=await call('/v1/grants',{action:revoke?'revoke':'grant',actorId:target.id,email:target.email.toLowerCase(),displayName:target.username,
          role:body.role||'editor',active:!revoke,startsAt:Math.floor(Date.parse(body.startsAt||new Date().toISOString())/1000),
          expiresAt:body.expiresAt?Math.floor(Date.parse(body.expiresAt)/1000):null},account.id,mutationOptions);
      }
    } else if(request.method==='GET') {
      result=await call('/v1/read',{action,id:firstQueryValue(body.id),revision:firstQueryValue(body.revision)},account.id);
      if(action==='preview')result.preview=renderBlogPreviewDocument(result.post,{relatedPosts:{}}).html;
    } else if(action==='save') {
      if(!/^[a-zA-Z0-9:_-]{16,128}$/.test(body.idempotencyKey||''))throw fail('BLOG_IDEMPOTENCY_REQUIRED',400);
      const post=normalizeBlogPost(body.post||{});validateBlogPost(post,{forPublish:false});
      if(String(body.id||'').startsWith('static:')) {
        const source=await legacyRecord(String(body.id).slice(7));
        if(post.slug!==source.post.slug)throw fail('BLOG_SLUG_CHANGE_REQUIRES_MIGRATION',409);
        result=await call('/v1/import',{post,sourceHash:source.sourceHash},account.id,mutationOptions);
      } else result=await call('/v1/save',{id:body.id||null,expectedRevision:body.expectedRevision||0,post},account.id,mutationOptions);
    } else if(action==='import_legacy') {
      await call('/v1/read',{action:'access'},account.id);
      const source=await legacyRecord(String(body.slug||''));
      // Opening an old article is READ-ONLY. Its first D1 revision is created
      // only when the editor explicitly saves, not when clicking "Chỉnh sửa".
      result={id:`static:${source.post.slug}`,revision:0,post:source.post,
        meta:{...source.meta,id:`static:${source.post.slug}`,slug:source.post.slug,revision:0,publishedRevision:0,hasUnpublishedChanges:false}};
    } else if(action==='upload_media') {
      const access=await call('/v1/read',{action:'access'},account.id);if(access.readOnly)throw fail('BLOG_READ_ONLY',503);
      result=await call('/v1/media/upload',await preparePreviewMedia(body),account.id,mutationOptions);
      result.asset.alt=String(body.alt||'').slice(0,300);result.url=result.asset.url;
    } else if(action==='preview') {
      await call('/v1/read',{action:'access'},account.id);
      const post=normalizeBlogPost(body.post||{}),rendered=renderBlogPreviewDocument(post,{relatedPosts:{}});
      result={post,preview:rendered.html,validation:validateBlogPost(post,{forPublish:false})};
    } else if(['publish','unpublish','archive'].includes(action)) {
      if(!/^[a-zA-Z0-9:_-]{16,128}$/.test(body.idempotencyKey||''))throw fail('BLOG_IDEMPOTENCY_REQUIRED',400);
      const payload={action,id:body.id,expectedRevision:body.expectedRevision};
      if(String(body.id||'').startsWith('static:')) {
        const source=await legacyRecord(String(body.id).slice(7));
        const imported=await call('/v1/import',{post:source.post,sourceHash:source.sourceHash},account.id,
          {idempotencyKey:body.idempotencyKey+'-import'});
        payload.id=imported.id;payload.expectedRevision=imported.revision;
      }
      if(action==='publish') {
        const record=await call('/v1/read',{action:'detail',id:payload.id},account.id);
        if(record.revision!==payload.expectedRevision)throw fail('BLOG_REVISION_CONFLICT',409);
        const validation=validateBlogPost(record.post,{forPublish:true});
        if(!validation.valid)throw fail('BLOG_PUBLISH_VALIDATION_FAILED',400);
        // readDraft carries authoritative body hash, not a reserialized view hash.
        payload.documentHash=record.documentHash;
        payload.html=renderBlogPost({...record,meta:{...record.meta,publishedAt:record.meta.publishedAt||new Date().toISOString(),updatedAt:new Date().toISOString()}},
          {baseUrl:'https://www.realview.com.vn',forPublish:true,relatedPosts:{}});
      }
      result=await call('/v1/publication',payload,account.id,{idempotencyKey:body.idempotencyKey});await refreshPublished(result,action,options);
    } else if(['restore','discard_draft'].includes(action))result=await call('/v1/restore',{...body,action},account.id,mutationOptions);
    else throw fail('INVALID_BLOG_ACTION',400);
    return sendAdminJson(response,200,result);
  } catch(error) {
    if(['post','index','rss','sitemap','cloudflare-media','public'].includes(route)) {
      response.setHeader('Cache-Control','private, no-store');response.setHeader('Vercel-CDN-Cache-Control','private, no-store');
      if((error.statusCode||503)===503)response.setHeader('Retry-After','3');
      return response.status(error.statusCode||503).end('Không thể tải nội dung lúc này. Vui lòng thử lại.');
    }
    const messages={BLOG_READ_ONLY:'Blog Studio đang khóa ghi. Vui lòng thử lại sau.',
      BLOG_ACCESS_DENIED:'Tài khoản không có quyền quản trị bài viết.',
      BLOG_LEGACY_REVISION_UNAVAILABLE:'Revision cũ chưa thể khôi phục. Bài công khai vẫn giữ nguyên bản HTML hiện tại.',
      BLOG_SLUG_CHANGE_REQUIRES_MIGRATION:'Chưa thể đổi slug của bài hiện có. URL công khai được giữ nguyên để bảo vệ SEO.',
      BLOG_PUBLICATION_COMMITTED_VERIFY_PENDING:'Thay đổi đã được ghi. Chưa xác nhận được bản công khai mới; hãy thử lại để kiểm tra, không tạo bản sao.',
      BLOG_WORKER_RETRY:'Chưa thể kết nối kho Blog Cloudflare. Vui lòng thử lại.'};
    return sendAdminJson(response,error.statusCode||503,{error:messages[error.code]||error.code||messages.BLOG_WORKER_RETRY,code:error.code||'BLOG_WORKER_RETRY',
      ...(error.currentRevision!=null?{currentRevision:error.currentRevision}:{})});
  }
}
}
export default createCloudflareProductionHandler();
