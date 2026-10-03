import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { answerWebsiteQuestion } from '../src/site-chatbot.mjs';
import { geminiCredentialId } from '../src/gemini-credential-store.mjs';
import { geminiHttpError } from '../src/gemini-response.mjs';
import { geminiRouteScore, beginGeminiRoute } from '../src/gemini-health.mjs';
import { CHATBOT_GEMINI_POOL_KEY, CHATBOT_GEMINI_HEALTH_KEY, beginChatbotGeminiRoute,
  finishChatbotGeminiRoute, getChatbotGeminiHealthSnapshot, updateChatbotGeminiAdminPool,
  readChatbotGeminiAdminStatus } from '../src/chatbot-gemini-pool.mjs';
import configHandler from '../api/chatbot-gemini-config.mjs';
import { redisLuaMock } from './helpers/redis-lua.mjs';

const model = 'gemini-3.5-flash-lite';
const envNames = ['CHATBOT_GEMINI_API_KEY', 'CHATBOT_GEMINI_API_KEY_VAULT_KEY', 'GEMINI_API_KEY_VAULT_KEY',
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN'];
async function fixture(run) {
  const before = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  for (const name of envNames) delete process.env[name];
  Object.assign(process.env, { CHATBOT_GEMINI_API_KEY:'primary-test-secret',
    CHATBOT_GEMINI_API_KEY_VAULT_KEY:Buffer.alloc(32, 2).toString('base64'),
    UPSTASH_REDIS_REST_URL:'https://redis.test', UPSTASH_REDIS_REST_TOKEN:'test-token' });
  const redis = redisLuaMock();
  const options = {fetchImpl:redis.fetchImpl};
  const primaryRoute = `${geminiCredentialId(process.env.CHATBOT_GEMINI_API_KEY)}:${model}`;
  const encrypt = apiKey => {
    const iv = Buffer.alloc(12, 3), cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32,2), iv);
    const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'),cipher.final()]);
    return {id:geminiCredentialId(apiKey),label:'test',iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};
  };
  redis.command(['SET', CHATBOT_GEMINI_POOL_KEY, JSON.stringify({models:[model], credentials:[encrypt('primary-test-secret'),encrypt('backup-test-secret')]})]);
  try { await run({redis,options,primaryRoute}); }
  finally { for (const name of envNames) { if(before[name]===undefined)delete process.env[name];else process.env[name]=before[name]; } }
}
const messages = [{role:'user',content:'Giải thích RealView theo cách khác và những giới hạn khi đọc review nhé.'}];
const success = () => new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({supported:true,answer:'RealView tổng hợp review công khai để bạn tham khảo.'})}]}}]}));

test('normalize permission failures without using model metadata GET as a health check', async () => {
  const denied = await geminiHttpError(new Response(JSON.stringify({error:{status:'PERMISSION_DENIED',message:'Your project has been denied access. Please contact support.'}}),{status:403}));
  assert.equal(denied.permissionReason,'project_denied');
  const invalid = await geminiHttpError(new Response(JSON.stringify({error:{details:[{reason:'API_KEY_INVALID'}]}}),{status:403}));
  assert.equal(invalid.permissionReason,'api_key_invalid');
  assert.equal((await geminiHttpError(new Response('{}',{status:429}))).permissionReason,undefined);
});

test('actual Lua keeps permission quarantine across cooldown, midnight and late success; generic pipeline is opt-out', () => fixture(async ({options,primaryRoute}) => {
  const now = Date.now();
  assert.equal((await beginChatbotGeminiRoute(primaryRoute,{...options,model,nowMs:now})).ok,true);
  await finishChatbotGeminiRoute(primaryRoute,{ok:false,statusCode:403,errorType:'request-error',permissionReason:'project_denied'}, {...options,nowMs:now});
  const tomorrow = now + 86_400_000;
  assert.equal((await beginChatbotGeminiRoute(primaryRoute,{...options,model,nowMs:tomorrow})).code,'PERMISSION_DISABLED');
  await finishChatbotGeminiRoute(primaryRoute,{ok:true,statusCode:200}, {...options,nowMs:tomorrow});
  const state = (await getChatbotGeminiHealthSnapshot({...options,routeIds:[primaryRoute]}))[primaryRoute];
  assert.equal(state.permissionDisabled,true);
  assert.equal(state.permissionReason,'project_denied');
  assert.equal(geminiRouteScore(state,model,tomorrow,{honorPermissionDisabled:true}),Infinity);
  assert.ok(Number.isFinite(geminiRouteScore(state,model,tomorrow)));
  // Same shared Lua is unchanged for the review pipeline's separate namespace.
  assert.equal((await beginGeminiRoute(primaryRoute,{...options,model,nowMs:tomorrow})).ok,true);
}));

test('pre-fix 403 is skipped without provider attempt; existing healthy backup is selected', () => fixture(async ({redis,primaryRoute}) => {
  redis.command(['HSET',CHATBOT_GEMINI_HEALTH_KEY,primaryRoute,JSON.stringify({lastStatusCode:403,cooldownUntilMs:1})]);
  const calls=[],events=[];
  const result = await answerWebsiteQuestion(messages,{redisFetchImpl:redis.fetchImpl,onProviderAttempt:event=>events.push(event),fetchImpl:async (_url,init)=>{
    calls.push(init.headers['x-goog-api-key']);return success();
  }});
  assert.equal(result.engine,'gemini');
  assert.deepEqual(calls,['backup-test-secret']);
  assert.equal(events.filter(event=>event.phase==='start').length,1);
  const event = events.find(event=>event.phase==='response');
  assert.equal(event.fingerprint,geminiCredentialId('backup-test-secret'));
  assert.equal(event.source,'chatbot_pool');
  assert.doesNotMatch(JSON.stringify([result,events]),/primary-test-secret|backup-test-secret|test-token/);
}));

test('new project denial stops the request and persists before response, not in background; next request skips it', () => fixture(async ({redis,primaryRoute}) => {
  const calls=[],events=[],background=[];
  const options = {redisFetchImpl:redis.fetchImpl,onProviderAttempt:event=>events.push(event),onBackgroundWork:work=>background.push(work),fetchImpl:async (_url,init)=>{
    const key = init.headers['x-goog-api-key'];calls.push(key);
    return key==='primary-test-secret' ? new Response(JSON.stringify({error:{status:'PERMISSION_DENIED',message:'Your project has been denied access. Please contact support.'}}),{status:403}) : success();
  }};
  const first = await answerWebsiteQuestion(messages,options);
  assert.equal(first.fallbackReason,'authentication_failed');
  assert.deepEqual(calls,['primary-test-secret']);
  assert.equal(JSON.parse(redis.command(['HGET',CHATBOT_GEMINI_HEALTH_KEY,primaryRoute])).permissionDisabled,true);
  assert.equal(events.find(event=>event.phase==='provider_failure').reason,'project_denied');
  assert.equal(events.find(event=>event.phase==='permission_quarantine').persisted,true);
  const second = await answerWebsiteQuestion(messages,options);
  assert.equal(second.engine,'gemini');
  assert.deepEqual(calls,['primary-test-secret','backup-test-secret']);
  await Promise.all(background);
  assert.doesNotMatch(JSON.stringify([first,second,events]),/Your project|primary-test-secret|backup-test-secret/);
}));

test('primary is not retried under a duplicate pool ID after transient failure', () => fixture(async ({redis}) => {
  const calls=[];
  const result=await answerWebsiteQuestion(messages,{redisFetchImpl:redis.fetchImpl,waitForRetryImpl:async()=>{},fetchImpl:async (_url,init)=>{
    const key=init.headers['x-goog-api-key'];calls.push(key);
    return key==='primary-test-secret'?new Response('{}',{status:503}):success();
  }});
  assert.equal(result.engine,'gemini');
  assert.deepEqual(calls,['primary-test-secret','backup-test-secret']);
}));

test('all permission-disabled sources return a classified fallback without any Google call', () => fixture(async ({redis}) => {
  for (const key of ['primary-test-secret','backup-test-secret']) {
    redis.command(['HSET',CHATBOT_GEMINI_HEALTH_KEY,`${geminiCredentialId(key)}:${model}`,JSON.stringify({permissionDisabled:true,permissionReason:'project_denied'})]);
  }
  let calls=0;
  const result=await answerWebsiteQuestion(messages,{redisFetchImpl:redis.fetchImpl,fetchImpl:async()=>{calls++;return success();}});
  assert.equal(calls,0);
  assert.equal(result.fallbackReason,'authentication_failed');
  assert.equal(result.providerAttempted,false);
}));

test('explicit admin recovery preserves daily quota and requires confirmed provider access', () => fixture(async ({redis,options,primaryRoute}) => {
  const original={permissionDisabled:true,permissionReason:'project_denied',lastStatusCode:403,dayRequests:499,inFlight:0,cooldownUntilMs:100};
  redis.command(['HSET',CHATBOT_GEMINI_HEALTH_KEY,primaryRoute,JSON.stringify(original)]);
  const body={action:'restore-permission',credentialId:geminiCredentialId('primary-test-secret'),model};
  const status=await readChatbotGeminiAdminStatus(options);
  assert.equal(status.health.routes.find(route=>route.credentialId===body.credentialId).status,'permission_disabled');
  assert.equal(status.health.totals.permissionDisabled,1);
  await assert.rejects(()=>updateChatbotGeminiAdminPool(body,options),error=>error.statusCode===400);
  assert.equal(JSON.parse(redis.command(['HGET',CHATBOT_GEMINI_HEALTH_KEY,primaryRoute])).permissionDisabled,true);
  assert.equal((await updateChatbotGeminiAdminPool({...body,confirmedProviderAccess:true},options)).permissionRestored,true);
  const restored=JSON.parse(redis.command(['HGET',CHATBOT_GEMINI_HEALTH_KEY,primaryRoute]));
  assert.equal(restored.permissionDisabled,undefined);
  assert.equal(restored.lastStatusCode,null);
  assert.equal(restored.dayRequests,499);
  assert.equal(restored.cooldownUntilMs,100);
}));

test('admin recovery fails atomically when a request is still in flight', () => fixture(async ({redis,options,primaryRoute}) => {
  redis.command(['HSET',CHATBOT_GEMINI_HEALTH_KEY,primaryRoute,JSON.stringify({permissionDisabled:true,inFlight:1})]);
  await assert.rejects(()=>updateChatbotGeminiAdminPool({action:'restore-permission',credentialId:geminiCredentialId('primary-test-secret'),model,confirmedProviderAccess:true},options),error=>error.statusCode===409);
  assert.equal(JSON.parse(redis.command(['HGET',CHATBOT_GEMINI_HEALTH_KEY,primaryRoute])).permissionDisabled,true);
}));

test('recovery endpoint rejects unauthenticated calls before touching Redis', async () => {
  const res={setHeader(){},status(value){this.statusCode=value;return this;},json(value){this.body=value;return this;}};
  await configHandler({method:'PUT',headers:{},body:{action:'restore-permission',confirmedProviderAccess:true}},res);
  assert.equal(res.statusCode,401);
});

test('quarantine storage failure is visible in telemetry and does not trigger a second Google call', () => fixture(async ({redis}) => {
  let calls=0;const events=[];
  const result=await answerWebsiteQuestion(messages,{onProviderAttempt:event=>events.push(event),redisFetchImpl:async(url,init)=>{
    const command=JSON.parse(init.body);
    if(command[0]==='EVAL' && command[1].includes('GEMINI_HEALTH_FINISH'))throw new Error('Redis unavailable');
    return redis.fetchImpl(url,init);
  },fetchImpl:async()=>{calls++;return new Response(JSON.stringify({error:{message:'Your project has been denied access.'}}),{status:403});}});
  assert.equal(calls,1);
  assert.equal(result.fallbackReason,'authentication_failed');
  assert.equal(events.find(event=>event.phase==='permission_quarantine').persisted,false);
}));
