import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { answerWebsiteQuestion } from '../src/site-chatbot.mjs';
import { chatbotAttemptTimeout, retryDecision } from '../src/chatbot-reliability.mjs';
import { geminiCredentialId, nextPacificResetAt } from '../src/gemini-credential-store.mjs';
import { GEMINI_HEALTH_KEY, finishGeminiRoute } from '../src/gemini-health.mjs';
import { CHATBOT_GEMINI_POOL_KEY, CHATBOT_GEMINI_HEALTH_KEY, CHATBOT_GEMINI_POOL_STATES_KEY,
  beginChatbotGeminiRoute, finishChatbotGeminiRoute } from '../src/chatbot-gemini-pool.mjs';
import { requestGeminiWithFallback } from '../src/gemini-response.mjs';
import { redisLuaMock } from './helpers/redis-lua.mjs';
import { createChatHandler } from '../api/chat.mjs';

const model='gemini-3.5-flash-lite';
const messages=[{role:'user',content:'Giải thích RealView theo cách khác và giới hạn khi đọc review nhé.'}];
const envNames=['CHATBOT_GEMINI_API_KEY','CHATBOT_GEMINI_API_KEY_VAULT_KEY','GEMINI_API_KEY',
  'UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN','KV_REST_API_URL','KV_REST_API_TOKEN',
  'CHATBOT_ADAPTIVE_ROUTING_ENABLED','CHATBOT_POOL_INDEPENDENT_PROJECTS'];
const ok=()=>new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{
  text:JSON.stringify({supported:true,answer:'RealView tổng hợp review công khai để bạn tham khảo.'})}]}}]}));
const fail=status=>new Response(JSON.stringify({error:{status:status===429?'RESOURCE_EXHAUSTED':'UNAVAILABLE',
  message:status===429?'Quota exceeded for requests per day':'temporary failure'}}),{status});
async function fixture(run,{keys=['primary-test-key','backup-one','backup-two'],primary='primary-test-key'}={}) {
  const previous=Object.fromEntries(envNames.map(name=>[name,process.env[name]]));
  for(const name of envNames)delete process.env[name];
  Object.assign(process.env,{UPSTASH_REDIS_REST_URL:'https://redis.test',UPSTASH_REDIS_REST_TOKEN:'test-token',
    CHATBOT_GEMINI_API_KEY_VAULT_KEY:Buffer.alloc(32,2).toString('base64'),GEMINI_API_KEY:'layer-two-secret'});
  if(primary)process.env.CHATBOT_GEMINI_API_KEY=primary;
  const redis=redisLuaMock(),calls=[],events=[];
  const credentials=keys.map((apiKey,index)=>{
    const iv=Buffer.alloc(12,index+1),cipher=createCipheriv('aes-256-gcm',Buffer.alloc(32,2),iv);
    const ciphertext=Buffer.concat([cipher.update(apiKey,'utf8'),cipher.final()]);
    return {id:geminiCredentialId(apiKey),label:`test-${index}`,iv:iv.toString('base64'),
      tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};
  });
  redis.command(['SET',CHATBOT_GEMINI_POOL_KEY,JSON.stringify({models:[model],credentials})]);
  const layerState=JSON.stringify({dayRequests:123,permissionDisabled:false});
  redis.command(['HSET',GEMINI_HEALTH_KEY,'analysis-route',layerState]);
  const route=key=>`${geminiCredentialId(key)}:${model}`;
  const ask=(provider,options={})=>answerWebsiteQuestion(messages,{redisFetchImpl:redis.fetchImpl,
    waitForRetryImpl:async()=>{},randomImpl:()=>0,onProviderAttempt:event=>events.push(event),
    fetchImpl:async(url,init)=>{calls.push(init.headers['x-goog-api-key']);return provider(url,init);},...options});
  try {
    await run({redis,calls,events,route,ask});
    assert.equal(redis.command(['HGET',GEMINI_HEALTH_KEY,'analysis-route']),layerState);
    assert.ok(!calls.includes('layer-two-secret'));
    assert.ok(redis.commands.every(command=>!command.includes('realview:gemini:credential-pool:v1')));
    assert.doesNotMatch(JSON.stringify(events),/primary-test-key|backup-one|backup-two|layer-two-secret/);
  } finally {for(const name of envNames){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];}}
}

test('allocation uses eligible routes, reserves completion, and refuses tiny retry windows',()=>{
  assert.equal(chatbotAttemptTimeout({remainingMs:10000,eligibleRoutes:2,attempts:0}),4000);
  assert.equal(chatbotAttemptTimeout({remainingMs:10000,eligibleRoutes:1,attempts:0}),9000);
  assert.equal(chatbotAttemptTimeout({remainingMs:5300,eligibleRoutes:4,attempts:1}),4800);
  assert.equal(chatbotAttemptTimeout({remainingMs:3400,eligibleRoutes:4,attempts:1}),0);
  const options={independentProjects:true,minimumAttemptMs:3000,completionReserveMs:500};
  assert.equal(retryDecision({statusCode:429,quotaExhausted:true,retryAfterMs:60000},9000,()=>0,options).retry,true);
  assert.equal(retryDecision({statusCode:429,quotaExhausted:true},9000).retry,false);
  assert.equal(retryDecision({statusCode:503},3700,()=>0,options).retry,false);
  for(const statusCode of [400,401,402,403,404])assert.equal(retryDecision({statusCode,transient:true},9000,()=>0,options).retry,false);
});

test('quarantined primary consumes no attempt; pool can fail over between two remaining keys',()=>fixture(async({redis,route,ask,calls,events})=>{
  redis.command(['HSET',CHATBOT_GEMINI_HEALTH_KEY,route('primary-test-key'),JSON.stringify({permissionDisabled:true})]);
  const result=await ask(async()=>calls.length===1?fail(503):ok());
  assert.equal(result.engine,'gemini');assert.deepEqual(calls,['backup-one','backup-two']);
  assert.equal(events.filter(event=>event.phase==='start').length,2);
  assert.equal(events.find(event=>event.phase==='attempt_budget').timeoutMs,4000);
}));

test('two failures stop after two calls even with several healthy keys remaining',()=>fixture(async({ask,calls})=>{
  const result=await ask(async()=>fail(503));
  assert.equal(result.fallbackReason,'provider_overloaded');assert.equal(calls.length,2);
}));

test('independent project daily quota fails over, persists exhaustion, and skips the source on the next question',()=>fixture(async({redis,route,ask,calls})=>{
  const first=await ask(async(_url,init)=>init.headers['x-goog-api-key']==='primary-test-key'?fail(429):ok());
  assert.equal(first.engine,'gemini');assert.deepEqual(calls,['primary-test-key','backup-one']);
  const state=JSON.parse(redis.command(['HGET',CHATBOT_GEMINI_HEALTH_KEY,route('primary-test-key')]));
  assert.equal(state.lastError,'daily-quota');
  assert.ok(state.cooldownUntilMs>=Date.parse(nextPacificResetAt(new Date()))-1);
  assert.ok(redis.command(['HGET',CHATBOT_GEMINI_POOL_STATES_KEY,geminiCredentialId('primary-test-key')]));
  assert.equal((await ask(async()=>ok())).engine,'gemini');
  assert.ok(calls.slice(2).every(key=>key!=='primary-test-key'));
}));

test('quota failover can be disabled without reverting permission quarantine',()=>fixture(async({ask,calls})=>{
  const result=await ask(async()=>fail(429),{independentProjects:false});
  assert.equal(result.fallbackReason,'quota_exhausted');assert.equal(calls.length,1);
}));

test('all exhausted vault keys, including a duplicate dedicated key, stay exhausted on later requests',()=>fixture(async({ask,calls})=>{
  const first=await ask(async()=>fail(429));
  assert.equal(first.fallbackReason,'quota_exhausted');assert.equal(calls.length,2);
  const second=await ask(async()=>ok());
  assert.equal(second.fallbackReason,'quota_exhausted');assert.equal(second.providerAttempted,false);
  assert.equal(calls.length,2);
},{keys:['primary-test-key','backup-one']}));

test('rollback restores legacy single-backup behavior and never calls a quarantined key',()=>fixture(async({redis,route,ask,calls})=>{
  redis.command(['HSET',CHATBOT_GEMINI_HEALTH_KEY,route('primary-test-key'),JSON.stringify({permissionDisabled:true})]);
  const result=await ask(async()=>fail(503),{adaptiveRouting:false});
  assert.equal(result.fallbackReason,'provider_overloaded');assert.deepEqual(calls,['backup-one']);
}));

test('insufficient remaining time never starts a second provider call',()=>fixture(async({ask,calls})=>{
  const result=await ask(async()=>fail(503),{timeoutMs:2800});
  assert.equal(result.fallbackReason,'provider_overloaded');assert.equal(calls.length,1);
}));

test('pool lookup failure still allows a healthy dedicated source but never bypasses its health check',()=>fixture(async({ask,calls,events})=>{
  const result=await ask(async()=>ok(),{redisFetchImpl:async(url,init)=>{
    if(url.endsWith('/multi-exec'))throw new Error('private pool failure');
    const command=JSON.parse(init.body);
    if(command[0]==='HMGET')return new Response(JSON.stringify({result:command.slice(2).map(()=>null)}));
    if(command[0]==='EVAL')return new Response(JSON.stringify({result:JSON.stringify({ok:true,state:{}})}));
    throw new Error('unexpected command');
  }});
  assert.equal(result.engine,'gemini');assert.deepEqual(calls,['primary-test-key']);
  assert.equal(events.find(event=>event.phase==='attempt_budget').timeoutMs,9000);
  assert.ok(events.some(event=>event.phase==='pool_unavailable'));
  assert.doesNotMatch(JSON.stringify(events),/private pool failure/);
}));

test('atomic BUSY rejection does not consume a provider attempt and allocation uses remaining routes',()=>fixture(async({redis,route,ask,calls,events})=>{
  let rejected=false;
  const result=await ask(async()=>ok(),{redisFetchImpl:async(url,init)=>{
    const command=JSON.parse(init.body);
    if(!rejected && command[0]==='EVAL' && command[1].includes('GEMINI_HEALTH_BEGIN')) {
      rejected=true;return new Response(JSON.stringify({result:JSON.stringify({ok:false,code:'BUSY',state:{inFlight:1,lastStartedAtMs:Date.now()}})}));
    }
    return redis.fetchImpl(url,init);
  }});
  assert.equal(result.engine,'gemini');assert.deepEqual(calls,['backup-one']);
  assert.equal(events.filter(event=>event.phase==='start').length,1);
  assert.ok(events.some(event=>event.phase==='route_skipped' && event.code==='BUSY'));
}));

test('actual single-source transfer may take 8 seconds without the old 5.5 second cutoff',()=>fixture(async({redis,route,ask,calls,events})=>{
  redis.command(['HSET',CHATBOT_GEMINI_HEALTH_KEY,route('primary-test-key'),JSON.stringify({permissionDisabled:true})]);
  const start=Date.now();
  const result=await ask(async(_url,init)=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{init.signal.removeEventListener('abort',abort);resolve(ok());},8000);
    const abort=()=>{clearTimeout(timer);reject(init.signal.reason);};init.signal.addEventListener('abort',abort,{once:true});
  }));
  assert.equal(result.engine,'gemini');assert.equal(calls.length,1);
  assert.equal(events.find(event=>event.phase==='attempt_budget').timeoutMs,9000);
  assert.ok(Date.now()-start<10000);
},{keys:['primary-test-key','backup-one']}));

test('headers followed by a hanging response body time out and fail over within the overall deadline',()=>fixture(async({ask,calls,events})=>{
  const guard=setTimeout(()=>{},11000);
  try {
  const start=Date.now();
  const result=await ask(async()=>calls.length===1
    ? {arrayBuffer:()=>new Promise(()=>{}),status:200,headers:new Headers()} : ok());
  assert.equal(result.engine,'gemini');assert.deepEqual(calls,['primary-test-key','backup-one']);
  assert.ok(events.some(event=>event.phase==='error' && event.timeoutBoundary==='attempt_deadline'));
  assert.ok(Date.now()-start>=3900 && Date.now()-start<10000);
  }finally{clearTimeout(guard);}
}));

test('real Lua respects minute Retry-After and dedicated daily exhaustion even without a vault record',()=>fixture(async({redis,route})=>{
  const options={fetchImpl:redis.fetchImpl,model},now=Date.parse('2026-10-03T18:00:00Z');
  const key=route('primary-test-key');
  await beginChatbotGeminiRoute(key,{...options,nowMs:now});
  await finishChatbotGeminiRoute(key,{ok:false,statusCode:429,errorType:'rate-limit',retryAfterMs:180000},{...options,nowMs:now});
  assert.equal((await beginChatbotGeminiRoute(key,{...options,nowMs:now+60001})).code,'COOLDOWN');
  await finishChatbotGeminiRoute(key,{ok:false,statusCode:429,errorType:'daily-quota'},{...options,nowMs:now});
  assert.equal((await beginChatbotGeminiRoute(key,{...options,nowMs:now+180001})).code,'COOLDOWN');
  const generic='generic-test-route';
  await finishGeminiRoute(generic,{ok:false,statusCode:429,errorType:'rate-limit',minCooldownUntilMs:now+180000},{...options,nowMs:now});
  const genericState=JSON.parse(redis.command(['HGET',GEMINI_HEALTH_KEY,generic]));
  assert.equal(genericState.cooldownUntilMs,now+60000);
  // This explicit generic test is allowed to write its own test key, never the existing analysis route.
}));

test('shared Layer 2 router still uses its original attempt cap and three-source fallback',async()=>{
  const calls=[],events=[];
  const result=await requestGeminiWithFallback({listCredentialsImpl:async()=>[1,2,3].map(n=>({id:`layer-${n}`,apiKey:`layer-secret-${n}`})),
    getHealthSnapshotImpl:async()=>({}),beginRouteImpl:async()=>({ok:true}),finishRouteImpl:async()=>null,
    markModelExhaustedImpl:async()=>{},buildRequest:(_model,key)=>({headers:{'x-goog-api-key':key}}),
    onRoutingEvent:event=>events.push(event),fetchImpl:async(_url,init)=>{
      calls.push(init.headers['x-goog-api-key']);return calls.length<3?fail(403):ok();
    }});
  assert.equal(result.attempts,3);assert.equal(calls.length,3);
  assert.ok(events.filter(event=>event.phase==='attempt_budget').every(event=>event.timeoutMs===25000));
});

test('API uses two independent pool sources then replays the completed generation with zero additional calls',()=>fixture(async({redis,route,calls})=>{
  redis.command(['HSET',CHATBOT_GEMINI_HEALTH_KEY,route('primary-test-key'),JSON.stringify({permissionDisabled:true})]);
  const logs=[],background=[];
  const handler=createChatHandler({redisCommandImpl:async command=>redis.command(command),redisFetchImpl:redis.fetchImpl,
    persistGenerationImpl:async()=>true,waitUntilImpl:work=>background.push(work),logger:{log:value=>logs.push(JSON.parse(value))},
    providerFetchImpl:async(_url,init)=>{calls.push(init.headers['x-goog-api-key']);return calls.length===1?fail(503):ok();}});
  const req={method:'POST',headers:{},socket:{remoteAddress:'test'},body:{messages,
    clientRequestId:'request_pool_1234567890123456',clientSessionId:'session_pool_1234567890123456'}};
  const response=()=>({headers:{},setHeader(key,value){this.headers[key]=value;},status(value){this.statusCode=value;return this;},json(value){this.body=value;return this;}});
  const first=response(),second=response();await handler(req,first);await handler(req,second);await Promise.all(background);
  assert.equal(first.body.status,'answered');assert.equal(second.body.idempotency.replayed,true);
  assert.equal(first.body.generationId,second.body.generationId);assert.deepEqual(calls,['backup-one','backup-two']);
  assert.equal(logs[0].providerAttempts,2);assert.equal(logs[1].providerAttempts,0);
  assert.ok(logs[0].providerOutcomes.some(event=>event.phase==='attempt_budget'));
  assert.doesNotMatch(JSON.stringify(logs),/primary-test-key|backup-one|backup-two|đọc review nhé/);
}));
