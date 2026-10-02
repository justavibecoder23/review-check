// Explicit preview-only permission import. Fresh GET-only identity verification,
// encrypted evidence, no role elevation, no production grant/session mutation.
import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mapLegacyBlogGrants, readEncryptedBlogBackup } from './blog-grant-mapping.mjs';
import { encryptBackup, hash } from './blog-migration-inventory.mjs';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const quote=value=>value===null?'NULL':"'"+String(value).replaceAll("'","''")+"'";
let phase='arguments';
export function eligiblePreviewGrants(report, now=Date.now()) {
  const captured=Date.parse(report?.capturedAt),sec=Math.floor(now/1000);
  if(!Number.isFinite(captured)||now-captured<0||now-captured>300_000)throw new Error('PREVIEW_MAPPING_STALE');
  const rows=report.mappings.filter(r=>r.mappingStatus==='mapped'&&!r.legacyRevoked
    &&r.startsAt<=sec&&(r.expiresAt===null||r.expiresAt>sec));
  for(const r of rows)if(!UUID.test(r.actorId)||!['admin','editor'].includes(r.role)
    ||!Number.isSafeInteger(r.startsAt)||(r.expiresAt!==null&&!Number.isSafeInteger(r.expiresAt))
    ||!/^realview:blog:access:v1:grant:[a-f0-9]{64}$/.test(r.recordKey)||!/^[a-f0-9]{64}$/.test(r.sourceHash))throw new Error('PREVIEW_MAPPING_INVALID');
  if(new Set(rows.map(r=>r.actorId)).size!==rows.length)throw new Error('PREVIEW_MAPPING_DUPLICATE');
  return rows;
}
function cli(binary,argv) {
  return new Promise((accept,reject)=>{
    const child=spawn(binary,argv,{cwd:new URL('../',import.meta.url),stdio:['ignore','pipe','pipe']});
    let out='';child.stdout.on('data',b=>{out+=b;});child.stderr.resume();
    child.on('error',()=>reject(new Error('PREVIEW_CLI_FAILED')));
    child.on('close',code=>code===0?accept(out):reject(new Error('PREVIEW_CLI_FAILED')));
  });
}
async function main() {
  const args=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
  if(args.confirm!=='preview-only'||!args.wrangler||!args.backup||!args.key||!args['public-key']||!args.out)throw new Error('PREVIEW_ARGS_REQUIRED');
  const config='cloudflare/blog-preview/wrangler.jsonc';
  const cfg=JSON.parse(await readFile(new URL('../'+config,import.meta.url),'utf8'));
  if(cfg.name!=='realview-blog-preview'||cfg.account_id!=='84e83ee7665b51263769f065a0e9ad93'
    ||cfg.d1_databases?.[0]?.database_id!=='e71ba88a-6bd6-4b7d-975f-b9df1650cdcd'
    ||cfg.r2_buckets?.[0]?.bucket_name!=='realview-blog-media-preview')throw new Error('PREVIEW_CONFIG_MISMATCH');
  const temporary=await mkdtemp('/private/tmp/realview-preview-grants-');
  const envPath=temporary+'/preview.env',sqlPath=temporary+'/grants.sql';
  const metrics={d1RowsRead:0,d1RowsWritten:0};
  try {
    phase='read-vercel-preview-config';
    await cli('/opt/homebrew/bin/vercel',['env','pull',envPath,'--environment','preview','--yes']);
    const vars=parseEnv(await readFile(envPath,'utf8'));
    await unlink(envPath);
    const url=String(vars.KV_REST_API_URL||'').replace(/\/$/,'');
    const token=vars.KV_REST_API_READ_ONLY_TOKEN||vars.KV_REST_API_TOKEN;
    if(!url.startsWith('https://')||!token)throw new Error('PREVIEW_REDIS_CONFIG_MISSING');
    const get=async command=>{
      if(command[0]!=='GET')throw new Error('PREVIEW_REDIS_WRITE_FORBIDDEN');
      const response=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
        body:JSON.stringify(command),signal:AbortSignal.timeout(6000)});
      if(!response.ok)throw new Error('PREVIEW_REDIS_UNAVAILABLE');
      const result=await response.json();if(result.error)throw new Error('PREVIEW_REDIS_UNAVAILABLE');return result.result;
    };
    phase='decrypt-backup';
    const backup=await readEncryptedBlogBackup(args.backup,args.key);
    for(const r of backup.records)if(hash(JSON.stringify(r.raw))!==r.sha256)throw new Error('PREVIEW_BACKUP_HASH');
    phase='fresh-redis-verification';
    const report=await mapLegacyBlogGrants(backup.records,get),rows=eligiblePreviewGrants(report);
    const execute=async (command,mutation=false)=>{
      if(mutation)await writeFile(sqlPath,command,{mode:0o600});
      try {
        // Wrangler file import reports aggregate metadata, not SELECT rows,
        // and writes upload progress before its JSON even with --json.
        // Only non-sensitive aggregate SELECTs use --command; grant SQL stays
        // in a private temp file rather than process argv.
        const out=await cli('node',[args.wrangler,'d1','execute','realview-blog-preview','--remote','--config',config,'--json',
          ...(mutation?['--file',sqlPath]:['--command',command])]);
        const start=out.search(/^\[\s*$/m);
        const data=JSON.parse(start>=0?out.slice(start):out);
        for(const r of data){metrics.d1RowsRead+=r.meta?.rows_read||0;metrics.d1RowsWritten+=r.meta?.rows_written||0;}
        return data.at(-1).results;
      }finally{await unlink(sqlPath).catch(()=>{});}
    };
    phase='verify-preview-state';
    const state=(await execute(`SELECT (SELECT COUNT(*) FROM blog_access_grants) AS grants,
      (SELECT COUNT(*) FROM blog_media WHERE state='pending' AND lease_until>CAST(strftime('%s','now') AS INTEGER)) AS leases,
      (SELECT value FROM blog_migration_settings WHERE setting='studio_read_only') AS locked;`))[0];
    // First import only; no overwriting subsequent D1 grant changes/revocations.
    if(state.grants!==0||state.leases!==0||state.locked!=='true')throw new Error('PREVIEW_NOT_EMPTY_OR_LOCKED');
    const now=Math.floor(Date.now()/1000);
    eligiblePreviewGrants(report); // stale verification must still fail before import.
    const sql=rows.map(r=>`INSERT INTO blog_access_grants(actor_id,role,active,updated_at,starts_at,expires_at)
      SELECT ${quote(r.actorId)},${quote(r.role)},1,${now},${r.startsAt},${r.expiresAt===null?'NULL':r.expiresAt}
      WHERE EXISTS(SELECT 1 FROM blog_migration_settings WHERE setting='studio_read_only' AND value='true')
      AND EXISTS(SELECT 1 FROM blog_import_records WHERE record_key=${quote(r.recordKey)} AND sha256=${quote(r.sourceHash)});`).join('\n');
    // Encrypt verification evidence BEFORE mutation; a CLI timeout is ambiguous.
    phase='persist-encrypted-evidence';
    await writeFile(args.out,encryptBackup({...report,planned:rows.length},await readFile(args['public-key'])),{mode:0o600,flag:'wx'});
    phase='activate-preview-grants';
    if(rows.length)await execute(sql,true);
    const after=(await execute(`SELECT COUNT(*) AS grants,SUM(active) AS active,
      SUM(role='admin') AS admins,SUM(role='editor') AS editors FROM blog_access_grants;`))[0];
    if(after.grants!==rows.length||after.active!==rows.length)throw new Error('PREVIEW_IMPORT_UNCONFIRMED');
    console.log(JSON.stringify({freshVerification:report.summary,previewGrants:after,readOnly:true,...metrics,
      note:'Read-only preview access only. No Redis writes, publish, production mutation, or content import.'}));
  }finally{
    await unlink(envPath).catch(()=>{});await unlink(sqlPath).catch(()=>{});await rmdir(temporary).catch(()=>{});
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{
  console.error(error.message?.startsWith('PREVIEW_')?error.message:'PREVIEW_GRANT_IMPORT_FAILED_AT_'+phase+': private data suppressed');process.exitCode=1;
});
