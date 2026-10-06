import { mkdtemp,readFile,writeFile,unlink,rmdir,readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';
import { inventoryRedis,encryptBackup,hash } from './blog-migration-inventory.mjs';
import { mapLegacyBlogGrants } from './blog-grant-mapping.mjs';
import { migrateStaticBlogHtml } from '../src/blog-static-migration.mjs';

const args=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
const config='cloudflare/blog-preview/wrangler.production.jsonc';
const quote=value=>value==null?'NULL':"'"+String(value).replaceAll("'","''")+"'";
const projectEnv={...process.env,VERCEL_PROJECT_ID:'prj_JgsU3RUeOG2pQ543INoVpslfrleE',VERCEL_ORG_ID:'team_qC5riAr1mMNGxndFQ0NLe60H'};
function cli(bin,argv,input) {return new Promise((resolve,reject)=>{
  const child=spawn(bin,argv,{env:projectEnv,stdio:['pipe','pipe','pipe']});let out='';
  child.stdout.on('data',b=>out+=b);child.stderr.resume();child.on('error',reject);
  child.on('close',code=>code===0?resolve(out):reject(Error('BOOTSTRAP_CLI_FAILED')));
  child.stdin.end(input);
});}
let phase='arguments';
const tmp=await mkdtemp('/private/tmp/realview-blog-production-');
try {
  if(args.confirm!=='production-bootstrap'||!args.wrangler||!args['public-key']||!args.backup)throw Error('BOOTSTRAP_ARGUMENTS');
  phase='read-config';
  const envFile=tmp+'/production.env';
  await cli('/opt/homebrew/bin/vercel',['env','pull',envFile,'--environment','production','--yes']);
  const vars=parseEnv(await readFile(envFile,'utf8'));await unlink(envFile);
  const redisUrl=vars.KV_REST_API_URL,redisToken=vars.KV_REST_API_READ_ONLY_TOKEN||vars.KV_REST_API_TOKEN;
  if(!redisUrl?.startsWith('https://')||!redisToken)throw Error('BOOTSTRAP_REDIS_CONFIG');
  const command=async cmd=>{
    if(!['GET','ZRANGE','ZREVRANGE','LRANGE'].includes(cmd[0]))throw Error('REDIS_WRITE_FORBIDDEN');
    const res=await fetch(redisUrl,{method:'POST',headers:{authorization:'Bearer '+redisToken,'content-type':'application/json'},body:JSON.stringify(cmd),signal:AbortSignal.timeout(8000)});
    if(!res.ok)throw Error('REDIS_READ_FAILED');const payload=await res.json();if(payload.error)throw Error('REDIS_READ_FAILED');return payload.result;
  };
  phase='inventory';
  const inventory=await inventoryRedis(command);if(!inventory.summary.observedStable)throw Error('LEGACY_CHANGED_DURING_EXPORT');
  const mapping=await mapLegacyBlogGrants(inventory.records,command);
  const grants=mapping.mappings.filter(r=>r.mappingStatus==='mapped'&&!r.legacyRevoked);
  let unresolvedConfigured=0;
  const account=async id=>{let user;try{user=JSON.parse(await command(['GET',`realview:account:v1:user:${id}`]));}catch{}
    if(!user||user.id!==id||user.disabledAt||user.deletedAt)throw Error('ACCOUNT_VERIFY_FAILED');return user;};
  // Resolve existing environment roles through stable account IDs, never create new permissions.
  for(const [ids,emails,role] of [[vars.BLOG_ADMIN_USER_IDS,vars.BLOG_ADMIN_EMAILS,'admin'],[vars.BLOG_EDITOR_USER_IDS,vars.BLOG_EDITOR_EMAILS,'editor']]) {
    const candidates=new Set(String(ids||'').split(',').map(v=>v.trim()).filter(Boolean));
    for(const email of String(emails||'').split(',').map(v=>v.trim().toLowerCase()).filter(Boolean)) {
      const id=await command(['GET',`realview:account:v1:email:${email}`]);if(!id){unresolvedConfigured++;continue;}
      const user=await account(id);if(user.email.toLowerCase()!==email){unresolvedConfigured++;continue;}candidates.add(id);
    }
    for(const actorId of candidates) {try{await account(actorId);}catch{unresolvedConfigured++;continue;}const old=grants.find(g=>g.actorId===actorId);
      if(!old)grants.push({actorId,role,startsAt:0,expiresAt:null});else if(role==='admin')Object.assign(old,{role,startsAt:0,expiresAt:null});}
  }
  if(!grants.some(g=>g.role==='admin'&&g.startsAt<=Date.now()/1000&&(!g.expiresAt||g.expiresAt>Date.now()/1000)))throw Error('NO_ACTIVE_ADMIN');
  const snapshots=[];
  for(const name of(await readdir('public/blog/snapshots')).filter(n=>n.endsWith('.html')&&!n.startsWith('index-'))) {
    const path='public/blog/snapshots/'+name,html=await readFile(path,'utf8');
    const source=migrateStaticBlogHtml(html,{sourcePath:path});if(!source.post.slug||!source.post.title)throw Error('SNAPSHOT_PARSE_FAILED');
    snapshots.push({path,html,sha256:hash(html),summary:{...source.post,...source.meta,status:'published'}});
  }
  phase='encrypted-backup';
  await writeFile(args.backup,encryptBackup({capturedAt:new Date().toISOString(),inventory,mapping,snapshots},await readFile(args['public-key'])),{mode:0o600,flag:'wx'});
  const sql=[];
  for(const s of snapshots) {
    sql.push(`INSERT OR IGNORE INTO blog_slugs VALUES (${quote(s.summary.slug)},'snapshot',${quote(s.path)},0);`);
    sql.push(`INSERT OR IGNORE INTO blog_legacy_articles VALUES (${quote(s.summary.slug)},${quote(JSON.stringify(s.summary))},${quote(s.sha256)},${quote(s.path)});`);
  }
  for(const r of inventory.records) {
    if(/:revision:\d+$/.test(r.key))sql.push(`INSERT OR IGNORE INTO blog_legacy_locators VALUES (${quote(r.key)},${quote(r.raw)},${quote(r.sha256)},'legacy_unrecoverable');`);
    if(r.key.endsWith(':meta')) {const meta=JSON.parse(r.raw);
      for(const slug of new Set([meta.slug,meta.publishedSlug,...(meta.managedSlugs||[])].filter(Boolean)))sql.push(`INSERT OR IGNORE INTO blog_slugs VALUES (${quote(slug)},'legacy_reserved',${quote(meta.id)},0);`);}
  }
  for(const g of grants) {const user=await account(g.actorId);
    sql.push(`INSERT OR IGNORE INTO blog_access_grants(actor_id,role,active,updated_at,starts_at,expires_at,email,display_name)
      VALUES (${quote(g.actorId)},${quote(g.role)},1,${Date.now()},${g.startsAt},${g.expiresAt||'NULL'},${quote(user.email)},${quote(user.username)});`);}
  phase='import-locked';
  const sqlFile=tmp+'/import.sql';await writeFile(sqlFile,sql.join('\n'),{mode:0o600});
  await cli('node',[args.wrangler,'d1','execute','realview-blog','--remote','--config',config,'--file',sqlFile,'--yes']);await unlink(sqlFile);
  if(args['configure-secret']==='yes') {
    phase='configure-secret';const secret=randomBytes(32).toString('hex');
    await cli('node',[args.wrangler,'secret','put','BLOG_HMAC_SECRET','--config',config],secret);
    await cli('/opt/homebrew/bin/vercel',['env','add','BLOG_HMAC_SECRET','production','--yes'],secret);
  }
  console.log(JSON.stringify({phase:'complete',snapshots:snapshots.length,legacyPointers:inventory.summary.revisionPointers,
    grants:grants.length,unresolved:mapping.summary.unresolved,unresolvedConfigured,redisWrites:0,blobCalls:0,productionRoutingChanged:false}));
}catch(error){console.error('BLOG_BOOTSTRAP_FAILED phase='+phase+' code='+error.message);process.exitCode=1;}
finally {for(const file of await readdir(tmp))await unlink(tmp+'/'+file);await rmdir(tmp);}
