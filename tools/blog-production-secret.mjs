// Synchronize the private bridge without printing or passing secrets in argv.
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
const argv=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
const env={...process.env,VERCEL_PROJECT_ID:'prj_JgsU3RUeOG2pQ543INoVpslfrleE',VERCEL_ORG_ID:'team_qC5riAr1mMNGxndFQ0NLe60H'};
function run(bin,args,input){return new Promise((resolve,reject)=>{const child=spawn(bin,args,{env,stdio:['pipe','pipe','pipe']});let out='';
  child.stdout.on('data',b=>out+=b);child.stderr.resume();child.on('error',reject);child.on('close',c=>c===0?resolve(out):reject(Error('SECRET_SYNC_CLI_FAILED')));child.stdin.end(input);});}
try {
  if(!argv.wrangler)throw Error('WRANGLER_REQUIRED');
  // Generate and set ONLY this migration's secret. Never extract production env.
  const secret=randomBytes(32).toString('hex');
  await run('/opt/homebrew/bin/vercel',['env','update','BLOG_HMAC_SECRET','production','--yes'],secret);
  await run('node',[argv.wrangler,'secret','put','BLOG_HMAC_SECRET','--config','cloudflare/blog-preview/wrangler.production.jsonc'],secret+'\n');
  console.log(JSON.stringify({secretLength:secret.length,vercelUpdated:true,workerSynchronized:true}));
  let verifyUrl=argv['verify-url'];
  if(argv['deploy-and-verify']==='yes') {
    const deployed=await run('/opt/homebrew/bin/vercel',['deploy','--prod','--skip-domain','--env','BLOG_STORAGE_BACKEND=cloudflare','--yes']);
    verifyUrl=deployed.match(/https:\/\/realview-[a-z0-9]+-tnt-s-projects1\.vercel\.app/g)?.at(-1);
    if(!verifyUrl)throw Error('STAGED_DEPLOYMENT_URL_MISSING');
    console.log(JSON.stringify({stagedDeployment:verifyUrl,domainPromoted:false}));
  }
  if(verifyUrl) {
    const child=spawn(process.execPath,['tools/blog-production-verify.mjs','--url='+verifyUrl,'--wrangler='+argv.wrangler,'--smoke=yes'],
      {env:{...env,BLOG_VERIFY_HMAC_SECRET:secret},stdio:['ignore','inherit','inherit']});
    process.exitCode=await new Promise(resolve=>child.on('close',resolve));
  }
}catch(e){console.error(e.message);process.exitCode=1;}
