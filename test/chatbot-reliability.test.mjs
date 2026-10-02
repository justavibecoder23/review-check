import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatHandler } from '../api/chat.mjs';
import { claimChatRequest, completeChatRequest, chatRequestScope, CHAT_REQUEST_LEASE_MS, releaseUnstartedChatRequest } from '../src/chatbot-idempotency.mjs';
import { chatError, retryDecision, responseState } from '../src/chatbot-reliability.mjs';
import { geminiHttpError, requestGeminiWithFallback } from '../src/gemini-response.mjs';
import { redisLuaMock } from './helpers/redis-lua.mjs';
import { answerWebsiteQuestion } from '../src/site-chatbot.mjs';

const body=()=>({messages:[{role:'user',content:'Giải thích RealView chi tiết nhé.'}],clientRequestId:'request_12345678901234567890',clientSessionId:'session_12345678901234567890'});
const request=(value=body())=>({method:'POST',body:value,headers:{},socket:{remoteAddress:'test'}});
function response(){return {headers:{},setHeader(key,value){this.headers[key]=value;},status(value){this.statusCode=value;return this;},json(value){this.body=value;return this;}};}
function fixture(overrides={}){
  const redis=redisLuaMock(),logs=[],background=[];let calls=0;
  const deps={redisCommandImpl:async command=>redis.command(command),logger:{log:value=>logs.push(JSON.parse(value))},
    waitUntilImpl:task=>background.push(task),persistGenerationImpl:async()=>true,
    answerImpl:async(_messages,options)=>{calls++;options.onProviderAttempt({phase:'start'});options.onProviderAttempt({phase:'response',status:200,durationMs:2});
      options.onTokenUsage({input:20,output:10,total:30});return{answer:'Đáp án đã xác nhận.',engine:'gemini'};},...overrides};
  return{redis,logs,background,deps,handler:createChatHandler(deps),calls:()=>calls};
}
async function run(f,value=body()){const res=response();await f.handler(request(value),res);return res;}

test('actual Lua claim/publish preserves JSON empty arrays, owner, fingerprint and TTL',async()=>{
  const redis=redisLuaMock(),options={commandImpl:async cmd=>redis.command(cmd)};
  const scope=chatRequestScope(body(),null,request());
  assert.equal((await claimChatRequest(scope,options)).state,'claimed');
  const expiry=redis.expiry.get(scope.key);
  assert.equal((await claimChatRequest({...scope,owner:'someone-else'},options)).state,'pending');
  assert.equal(await completeChatRequest({...scope,owner:'wrong'}, {answer:'wrong'},options),false);
  assert.equal((await claimChatRequest({...scope,fingerprint:'different'},options)).state,'conflict');
  const payload={answer:'Đáp án',answerDocument:{version:'2.0',sections:[],limitations:[],actions:[],evidenceRefs:[]},evidence:[]};
  assert.equal(await completeChatRequest(scope,payload,options),true);
  assert.deepEqual((await claimChatRequest(scope,options)).response,payload);
  assert.ok(redis.expiry.get(scope.key)>=expiry);
});
test('expired lease becomes uncertain without takeover; original owner can reconcile a late result',async()=>{
  const redis=redisLuaMock(),options={commandImpl:async cmd=>redis.command(cmd)},scope=chatRequestScope(body(),null,request());
  const now=Date.now();await claimChatRequest(scope,{...options,nowMs:now});const expiry=redis.expiry.get(scope.key);
  const value=await claimChatRequest({...scope,owner:'new-owner'},{...options,nowMs:now+CHAT_REQUEST_LEASE_MS+1});
  assert.equal(value.state,'uncertain');assert.equal(redis.expiry.get(scope.key),expiry);
  assert.equal(await completeChatRequest({...scope,owner:'new-owner'},{answer:'wrong'},options),false);
  assert.equal(await completeChatRequest(scope,{answer:'recovered'},options),true);
  assert.equal((await claimChatRequest(scope,options)).response.answer,'recovered');
});
test('release of unstarted work is owner-gated and cannot delete completed answers',async()=>{
  const redis=redisLuaMock(),options={commandImpl:async cmd=>redis.command(cmd)},scope=chatRequestScope(body(),null,request());
  await claimChatRequest(scope,options);assert.equal(await releaseUnstartedChatRequest({...scope,owner:'wrong'},options),false);
  assert.equal(await releaseUnstartedChatRequest(scope,options),true);
  await claimChatRequest(scope,options);await completeChatRequest(scope,{answer:'ok'},options);
  assert.equal(await releaseUnstartedChatRequest(scope,options),false);
});
test('same ID completed response is replayed without AI, extra rate charge or generation write',async()=>{
  const f=fixture(),first=await run(f),second=await run(f);
  assert.equal(first.body.status,'answered');assert.equal(second.body.idempotency.replayed,true);
  assert.equal(f.calls(),1);assert.equal(f.background.length,1);
  assert.equal(f.redis.commands.filter(c=>c[0]==='INCR').length,1);
  assert.notEqual(first.body.requestId,second.body.requestId);assert.equal(second.body.generationId,first.body.generationId);
});
test('20 concurrent duplicates share one provider call and pending requests do not open another',async()=>{
  let finish,start;const gate=new Promise(resolve=>{finish=resolve;});const started=new Promise(resolve=>{start=resolve;});let calls=0;
  const f=fixture({answerImpl:async(_m,options)=>{calls++;options.onProviderAttempt({phase:'start'});start();await gate;return{answer:'ok',engine:'gemini'};}});
  const first=run(f);await started;
  const duplicates=await Promise.all(Array.from({length:20},()=>run(f)));
  for(const item of duplicates){assert.equal(item.statusCode,409);assert.equal(item.body.code,'CHAT_REQUEST_IN_PROGRESS');}
  assert.equal(calls,1);finish();assert.equal((await first).statusCode,200);assert.equal((await run(f)).body.idempotency.replayed,true);
});
test('changing messages with the same ID yields 409 without a provider call',async()=>{
  const f=fixture();await run(f);const changed=body();changed.messages[0].content='Câu hỏi khác';
  assert.equal((await run(f,changed)).body.code,'CHAT_REQUEST_ID_CONFLICT');assert.equal(f.calls(),1);
});
test('ambiguous publish timeout is reconciled by replay, not another provider call',async()=>{
  const f=fixture();const command=f.deps.redisCommandImpl;
  f.handler=createChatHandler({...f.deps,redisCommandImpl:async parts=>{
    const result=await command(parts);
    if(parts[0]==='EVAL' && parts[1].includes('CHAT_REQUEST_COMPLETE_V1'))throw new Error('network lost after commit');
    return result;
  }});
  const first=await run(f),second=await run(f);
  assert.equal(first.body.idempotency.stored,false);assert.equal(second.body.idempotency.replayed,true);assert.equal(f.calls(),1);
});
test('timeout after provider start never releases ownership or restarts on duplicate',async()=>{
  const f=fixture({answerImpl:async(_m,options)=>{options.onProviderAttempt({phase:'start'});throw chatError('CHAT_DEADLINE_EXCEEDED');}});
  const first=await run(f);assert.equal(first.body.code,'CHAT_DEADLINE_EXCEEDED');
  const second=await run(f);assert.equal(second.body.code,'CHAT_REQUEST_IN_PROGRESS');
  assert.equal(f.redis.commands.filter(c=>c[0]==='DEL').length,0);
});
test('context expired/forbidden/preparing is not silently converted to website, no AI or claim',async()=>{
  for(const [code,status] of [['RESULT_CONTEXT_FORBIDDEN',403],['RESULT_CONTEXT_NOT_FOUND',404],['RESULT_CONTEXT_PREPARING',409]]){
    const f=fixture({loadContextImpl:async()=>{throw chatError(code,status);}}),b=body();b.context={type:'current_result',resultId:'secret-report',accessToken:'secret-token'};
    const result=await run(f,b);assert.equal(result.body.code,code);assert.equal(result.statusCode,status);assert.equal(f.calls(),0);
    assert.equal(f.redis.commands.length,0);assert.doesNotMatch(JSON.stringify(f.logs),/secret-report|secret-token/);
  }
});
test('history cached responses require current authorization and cannot cross accounts',async()=>{
  let actor='alice';const f=fixture({currentAccountImpl:async()=>actor?{id:actor}:null,
    getHistoryImpl:async(id,item)=>({id:item,analyzedAt:new Date().toISOString(),fullReport:{product:{title:id},trust:{score:71}}}),
    answerImpl:async(_m,o)=>({answer:o.resultContext.product.title,engine:'rules'})});
  const b=body();b.context={type:'history_item',historyItemId:'private-item'};
  assert.equal((await run(f,b)).body.answer,'alice');actor='bob';assert.equal((await run(f,b)).body.answer,'bob');
  actor=null;const blocked=await run(f,b);assert.equal(blocked.body.code,'AUTH_REQUIRED');assert.equal(blocked.statusCode,401);
});
test('current-result capabilities, anonymous sessions and login cookies bind private replay scopes',()=>{
  const b=body();b.context={type:'current_result',resultId:'private',accessToken:'token-one'};
  const scope=chatRequestScope(b,null,request(b));
  const other=structuredClone(b);other.context.accessToken='token-two';
  assert.notEqual(scope.key,chatRequestScope(other,null,request(other)).key);
  other.clientSessionId='another_session_1234567890';assert.notEqual(scope.key,chatRequestScope(other,null,request(other)).key);
  const logged=request(b);logged.headers.cookie='realview_session=private-login-cookie';assert.notEqual(scope.key,chatRequestScope(b,null,logged).key);
  assert.doesNotMatch(JSON.stringify(scope),/token-one|private-login-cookie|private-item/);
});
test('Redis outage fails closed for AI but exact FAQ remains available without provider calls',async()=>{
  const f=fixture({redisCommandImpl:async()=>{throw new Error('redis private error');},answerImpl:undefined});
  const b=body();b.messages[0].content='RealView hoạt động thế nào?';const faq=await run(f,b);
  assert.equal(faq.body.engine,'knowledge-base');assert.equal(faq.body.status,'answered');
  const open=await run(f);assert.equal(open.body.code,'CHAT_IDEMPOTENCY_UNAVAILABLE');assert.equal(open.body.providerAttempted,false);
  assert.doesNotMatch(JSON.stringify(f.logs),/redis private error/);
});
test('rate limit carries real wait time, never calls AI, and releases only unstarted work',async()=>{
  const f=fixture({rateLimitImpl:async()=>{throw chatError('CHAT_RATE_LIMITED',429,12500);}});
  const r=await run(f);assert.equal(r.statusCode,429);assert.equal(r.headers['Retry-After'],'13');assert.equal(r.body.retryAfterMs,12500);
  assert.equal(f.calls(),0);await Promise.all(f.background);
  const scope=chatRequestScope(body(),null,request());assert.equal(f.redis.strings.has(scope.key),false);
});
test('one deadline includes slow context and model; background persistence cannot delay a sent answer',async()=>{
  const f=fixture({budgetMs:120,loadContextImpl:async()=>{await new Promise(r=>setTimeout(r,50));return{resultId:'x'};},
    answerImpl:async(_m,o)=>{o.onProviderAttempt({phase:'start'});await new Promise(r=>setTimeout(r,100));return{answer:'late',engine:'gemini'};}});
  const b=body();b.context={type:'current_result',resultId:'x',accessToken:'test'};
  const start=Date.now(),r=await run(f,b);assert.equal(r.body.code,'CHAT_DEADLINE_EXCEEDED');assert.ok(Date.now()-start<300);
  const fast=fixture({persistGenerationImpl:async()=>new Promise(()=>{})});const start2=Date.now();
  assert.equal((await run(fast)).body.status,'answered');assert.ok(Date.now()-start2<150);assert.equal(fast.background.length,1);
});
test('structured telemetry records stage, tokens and fallback vs HTTP200 without content or secrets',async()=>{
  const f=fixture({answerImpl:async(_m,o)=>{o.onProviderAttempt({phase:'start'});o.onTokenUsage({input:12,output:8,total:20});
    return{answer:'Số liệu từ báo cáo',engine:'rules',fallbackReason:'timeout',fallbackUseful:true};}});
  const b=body();b.messages[0].content='private question words';b.retryCause='frontend_timeout';
  const r=await run(f,b);assert.equal(r.statusCode,200);assert.equal(r.body.status,'fallback');assert.equal(r.body.code,'AI_TIMEOUT');
  const log=f.logs[0];assert.equal(log.providerAttempts,1);assert.equal(log.tokenUsage.total,20);assert.equal(log.clientRetryCause,'frontend_timeout');
  for(const phase of ['context','rate_limit','answer','idempotency_read','idempotency_write'])assert.ok(Number.isFinite(log.timingsMs[phase]));
  assert.doesNotMatch(JSON.stringify(log),/private question words|Số liệu từ báo cáo|clientSessionId/);
});
test('error envelope separates unavailable answers from useful fallback',()=>{
  assert.equal(responseState({fallbackReason:'timeout',fallbackUseful:true},'r').status,'fallback');
  assert.equal(responseState({fallbackReason:'quota_exhausted'},'r').retryable,false);
  assert.equal(responseState({engine:'knowledge-base'},'r').status,'answered');
});
test('provider Retry-After and Google RetryInfo are parsed, excessive wait and unknown/day quota forbid retry',async()=>{
  const error=await geminiHttpError(new Response(JSON.stringify({error:{details:[{'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay:'3.5s'}]}}),{status:503,headers:{'Retry-After':'2'}}));
  assert.equal(error.retryAfterMs,3500);assert.equal(retryDecision(error,3000).retry,false);
  assert.equal(retryDecision(error,8000).delayMs,3500);
  for(const status of [400,401,402,403,404,429])assert.equal(retryDecision({statusCode:status,transient:true},9000).retry,false);
});
for(const [status,expected] of [[503,2],[408,2],[429,1],[403,1],[400,1]])test(`chatbot opt-in routing status ${status} makes at most ${expected} provider attempts`,async()=>{
  let calls=0,waits=[];
  const result=()=>requestGeminiWithFallback({listCredentialsImpl:async()=>[1,2,3].map(n=>({id:`key-${n}`,apiKey:`secret-${n}`})),
    getHealthSnapshotImpl:async()=>({}),beginRouteImpl:async()=>({ok:true}),finishRouteImpl:async()=>null,markModelExhaustedImpl:async()=>{},
    buildRequest:()=>({}),maxRetries:1,deadlineAt:Date.now()+8000,retryPolicy:retryDecision,waitForRetryImpl:async ms=>waits.push(ms),
    fetchImpl:async()=>{calls++;return calls===1?new Response(JSON.stringify({error:{status:status===429?'RESOURCE_EXHAUSTED':'UNAVAILABLE'}}),{status}):new Response('{}');}});
  if(expected===1)await assert.rejects(result);else await result();
  assert.equal(calls,expected);assert.equal(waits.length,expected-1);
});
test('429 daily quota never moves to another key even if nominal retries remain',async()=>{
  const error=await geminiHttpError(new Response(JSON.stringify({error:{message:'Quota exceeded: requests per day'}}),{status:429}));
  assert.equal(error.quotaScope,'day');assert.equal(retryDecision(error,9000).retry,false);
});
test('website fallback answers only verified subquestions, notes missing parts and respects rollback',async()=>{
  const messages=[{role:'user',content:'TrustScore là gì? Thời tiết hôm nay thế nào?'}];
  const r=await answerWebsiteQuestion(messages,{providerDisabled:true,disabledReason:'pool_unavailable'});
  assert.equal(r.fallbackUseful,true);assert.match(r.answer,/độ tin cậy/);assert.match(r.answer,/Các yêu cầu còn lại/);
  assert.equal(r.answerDocument.sections.length,1);
  const plain=await answerWebsiteQuestion(messages,{providerDisabled:true,structuredAnswers:false});
  assert.equal(plain.answerDocument,undefined);assert.equal(plain.answer,r.answer);
});
test('actual chatbot/API tracks one provider call, usage and safely replays its result',async()=>{
  const old=process.env.CHATBOT_GEMINI_API_KEY;process.env.CHATBOT_GEMINI_API_KEY='private-primary-test-key';
  try {
    let calls=0;const f=fixture({answerImpl:undefined,providerFetchImpl:async()=>{calls++;
      return new Response(JSON.stringify({usageMetadata:{promptTokenCount:11,candidatesTokenCount:7,totalTokenCount:18},
        candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({supported:true,answer:'RealView tổng hợp review công khai.'})}]}}]}));}});
    const first=await run(f),second=await run(f);assert.equal(first.body.engine,'gemini');assert.equal(second.body.idempotency.replayed,true);
    assert.equal(calls,1);assert.equal(f.logs[0].providerAttempts,1);assert.equal(f.logs[0].tokenUsage.total,18);
    assert.doesNotMatch(JSON.stringify(f.logs),/private-primary-test-key/);await Promise.all(f.background);
  }finally{if(old===undefined)delete process.env.CHATBOT_GEMINI_API_KEY;else process.env.CHATBOT_GEMINI_API_KEY=old;}
});
