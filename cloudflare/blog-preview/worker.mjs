import { canonicalBlogTarget, verifyBlogRequest } from './request-auth.mjs';
import { consumeBlogRequest } from './access-guard.mjs';
import { blogError, saveDraft, readDraft, listDrafts, postId } from './draft-store.mjs';
import { uploadMedia, readMedia } from './media-store.mjs';
import { measuredD1, measuredR2 } from './usage-audit.mjs';
import { beginOperationAudit, maintainBlogPreview, readMaintenanceStatus } from './operation-audit.mjs';
import { publicPost, listProductionPosts, importLegacy, changePublication, restoreDraft, manageGrants } from './production-store.mjs';

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    const environment = env.BLOG_ENVIRONMENT || 'preview';
    if (environment === 'production' && request.method === 'GET' && url.pathname.startsWith('/public/')) {
      try {
        const headers = {'cache-control':'no-store','x-content-type-options':'nosniff'};
        if (url.pathname === '/public/post') return Response.json(await publicPost(env.BLOG_DB,url.searchParams.get('slug')), {headers});
        if (url.pathname === '/public/list') {
          const state=await env.BLOG_DB.prepare(`SELECT (SELECT COUNT(*) FROM blog_published)+
            (SELECT COUNT(*) FROM blog_slugs WHERE tombstone=1) AS changed`).first();
          return Response.json({posts:await listProductionPosts(env.BLOG_DB,{publicOnly:true}),changed:!!state.changed},{headers});
        }
        if (url.pathname === '/public/media') {
          const hash=url.searchParams.get('hash'),width=url.searchParams.get('width');
          if (!/^[a-f0-9]{64}$/.test(hash||'')) throw blogError('BLOG_MEDIA_NOT_FOUND',404);
          const visible=await env.BLOG_DB.prepare('SELECT 1 FROM blog_public_media WHERE hash=? LIMIT 1').bind(hash).first();
          if (!visible) throw blogError('BLOG_MEDIA_NOT_FOUND',404);
          const response=await readMedia(env.BLOG_DB,env.BLOG_MEDIA,hash,width);
          response.headers.set('Cache-Control','public, max-age=31536000, immutable');
          return response;
        }
      } catch(error) {return Response.json({code:error.code||'BLOG_PUBLIC_RETRY'},{status:error.statusCode||503,headers:{'cache-control':'no-store'}});}
      return new Response(null,{status:404});
    }
    if (request.method === 'GET' && url.pathname === '/health') return Response.json({
      service: environment==='production'?'realview-blog':'realview-blog-preview', phase: environment==='production'?'production':'draft-media-preview', productionCutover: environment==='production'
    }, { headers: { 'cache-control': 'no-store' } });
    if (!['/v1/read', '/v1/save', '/v1/media/upload', '/v1/media/read', ...(environment==='production'?['/v1/import','/v1/publication','/v1/restore','/v1/grants']:[])].includes(url.pathname) || request.method !== 'POST') {
      return Response.json({ error: 'NOT_FOUND' }, { status: 404, headers: { 'cache-control': 'no-store' } });
    }
    const metrics = { d1RowsRead:0, d1RowsWritten:0, r2PutAttempted:0, r2PutConfirmed:0, r2Head:0, r2Get:0 };
    const started = Date.now();
    const requestId = (request.headers.get('x-blog-request-id') || '').slice(0, 128);
    const log = fields => console.log(JSON.stringify({ service:environment==='production'?'realview-blog':'realview-blog-preview', requestId, ...fields }));
    let operationAudit = null;
    const audit = async fields => { await operationAudit?.event(fields); log(fields); };
    const finish = async response => {
      if (operationAudit) {
        try {
          const code = response.status >= 400 ? (await response.clone().json()).code : null;
          // Stored metrics exclude this final bookkeeping UPDATE; headers below
          // include it when SDK metadata is available.
          await operationAudit.finish(response.status, code, metrics);
        } catch {
          log({ event:'audit_finish_unconfirmed' });
          response = Response.json({ error:'BLOG_AUDIT_UNAVAILABLE',code:'BLOG_AUDIT_UNAVAILABLE' },
            { status:503,headers:{'cache-control':'private, no-store','retry-after':'3'} });
        }
      }
      response.headers.set('X-Blog-D1-Rows-Read', String(metrics.d1RowsRead));
      response.headers.set('X-Blog-D1-Rows-Written', String(metrics.d1RowsWritten));
      response.headers.set('X-Blog-R2-Put-Attempted', String(metrics.r2PutAttempted));
      response.headers.set('X-Blog-R2-Put-Confirmed', String(metrics.r2PutConfirmed));
      response.headers.set('X-Blog-R2-Head', String(metrics.r2Head));
      response.headers.set('X-Blog-R2-Get', String(metrics.r2Get));
      log({ event:'request_finished', route:url.pathname,status:response.status,elapsedMs:Date.now()-started,...metrics });
      return response;
    };
    env = { ...env, BLOG_DB:env.BLOG_DB && measuredD1(env.BLOG_DB,metrics), BLOG_MEDIA:measuredR2(env.BLOG_MEDIA,metrics,audit) };
    try {
      if (!env.BLOG_HMAC_SECRET || !env.BLOG_DB) throw blogError('BLOG_AUTH_NOT_CONFIGURED', 503);
      if (Number(request.headers.get('content-length')) > 4_300_000) throw blogError('BLOG_BODY_TOO_LARGE', 413);
      // Bounded streaming: do not buffer an arbitrary body before validating its size.
      const reader = request.body?.getReader();
      const chunks = []; let length = 0;
      if (reader) for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        length += value.length;
        if (length > 4_300_000) { await reader.cancel(); throw blogError('BLOG_BODY_TOO_LARGE', 413); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const target = canonicalBlogTarget(request.url);
      if (target !== url.pathname) throw blogError('BLOG_AUTH_INVALID', 401);
      const envelope = await verifyBlogRequest({ secret: env.BLOG_HMAC_SECRET, environment,
        method: request.method, url: request.url, headers: request.headers, body: bytes });
      envelope.environment = environment;
      const write = ['/v1/save', '/v1/media/upload','/v1/import','/v1/publication','/v1/restore'].includes(target);
      await consumeBlogRequest(env.BLOG_DB, envelope, { environment, write,adminOnly:target==='/v1/grants' });
      if (['/v1/save','/v1/media/upload'].includes(target)) operationAudit = await beginOperationAudit(env.BLOG_DB, envelope,
        target === '/v1/save' ? 'save' : 'media-upload');
      let input;
      try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { throw blogError('INVALID_JSON', 400); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw blogError('INVALID_JSON', 400);
      let payload;
      if (target === '/v1/save') payload = await saveDraft(env.BLOG_DB, input, envelope);
      else if (target === '/v1/import') payload = await importLegacy(env.BLOG_DB,input,envelope);
      else if (target === '/v1/publication') payload = await changePublication(env.BLOG_DB,input,envelope);
      else if (target === '/v1/restore') payload = await restoreDraft(env.BLOG_DB,input,envelope);
      else if (target === '/v1/grants') payload = await manageGrants(env.BLOG_DB,input,envelope);
      else if (target === '/v1/media/upload') payload = { asset: await uploadMedia(env.BLOG_DB, env.BLOG_MEDIA, input, envelope) };
      else if (target === '/v1/media/read') return finish(await readMedia(env.BLOG_DB, env.BLOG_MEDIA, input.hash, input.width));
      else if (input.action === 'access') {
        const grant = await env.BLOG_DB.prepare('SELECT role FROM blog_access_grants WHERE actor_id=?').bind(envelope.actorId).first();
        const settings = await env.BLOG_DB.prepare("SELECT value FROM blog_migration_settings WHERE setting='studio_read_only'").first();
        payload = { authorized: true, role: grant.role, readOnly: settings?.value !== 'false', backend: environment==='production'?'cloudflare':'cloudflare-preview',
          capabilities: { managePosts: true, publishPosts: environment==='production', manageAccess: environment==='production'&&grant.role==='admin' } };
      } else if (input.action === 'list') {
        const posts = environment==='production'?await listProductionPosts(env.BLOG_DB):await listDrafts(env.BLOG_DB);
        const grant = await env.BLOG_DB.prepare('SELECT role FROM blog_access_grants WHERE actor_id=?').bind(envelope.actorId).first();
        const settings = await env.BLOG_DB.prepare("SELECT value FROM blog_migration_settings WHERE setting='studio_read_only'").first();
        payload = { posts, items: posts, role: grant.role, readOnly: settings?.value !== 'false', backend: environment==='production'?'cloudflare':'cloudflare-preview',
          maintenance: await readMaintenanceStatus(env.BLOG_DB),
          capabilities: { managePosts: true, publishPosts: environment==='production', manageAccess: environment==='production'&&grant.role==='admin' } };
      }
      else if (input.action === 'detail' || input.action === 'preview') payload = await readDraft(env.BLOG_DB, input.id, input.revision);
      else if (input.action === 'revisions') {
        postId(input.id);
        const rows = await env.BLOG_DB.prepare('SELECT revision,created_at AS createdAt,body_sha256 AS sha256 FROM blog_revisions WHERE post_id=? ORDER BY revision DESC LIMIT 100').bind(input.id).all();
        payload = { revisions: rows.results, audit: environment==='production'?
          (await env.BLOG_DB.prepare('SELECT operation AS action,created_at AS createdAt FROM blog_mutation_audit WHERE post_id=? ORDER BY created_at DESC LIMIT 50').bind(input.id).all()).results:[] };
      } else throw blogError('INVALID_BLOG_ACTION', 400);
      return finish(Response.json(payload, { headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } }));
    } catch (error) {
      return finish(Response.json({ error: error.code || 'BLOG_INTERNAL_ERROR', code: error.code || 'BLOG_INTERNAL_ERROR',
        ...(error.currentRevision != null ? { currentRevision: error.currentRevision } : {}) }, {
        status: error.statusCode || 503,
        headers: { 'cache-control': 'private, no-store', ...(error.statusCode === 503 ? { 'retry-after': '3' } : {}) }
      }));
    }
  },
  async scheduled(controller, env) {
    const metrics = { d1RowsRead:0, d1RowsWritten:0 };
    try {
      const result = await maintainBlogPreview(measuredD1(env.BLOG_DB,metrics));
      console.log(JSON.stringify({service:'realview-blog-preview',event:'maintenance_finished',...result,...metrics}));
    } catch {
      console.error(JSON.stringify({service:'realview-blog-preview',event:'maintenance_failed',...metrics}));
      throw new Error('BLOG_MAINTENANCE_FAILED');
    }
  }
};
