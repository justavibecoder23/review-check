import { answerWebsiteQuestion } from '../src/site-chatbot.mjs';
import { createHash } from 'node:crypto';
import { generateId } from 'ai';
import { waitUntil } from '@vercel/functions';
import { isRedisConfigured, redisCommand } from '../src/redis-rest.mjs';
import { loadResultChatContext, persistChatGeneration, buildResultChatContext } from '../src/result-chat-context.mjs';
import { currentAccount } from './auth.mjs';
import { getAccountHistoryItem } from '../src/account-store.mjs';
import { CHAT_REQUEST_BUDGET_MS, CHAT_FINALIZE_RESERVE_MS, chatError, createChatBudget, errorState, responseState } from '../src/chatbot-reliability.mjs';
import { chatRequestScope, claimChatRequest, completeChatRequest, releaseUnstartedChatRequest } from '../src/chatbot-idempotency.mjs';

async function resolveChatContexts(request, body, deps, signal) {
  const context = body.context || (body.resultId ? {type:'current_result',resultId:body.resultId,accessToken:body.resultAccessToken} : null);
  if (!context) return {contexts:[],actorId:null};
  const options={signal,redisTimeoutMs:900,timeoutMs:900,redisFetchImpl:deps.redisFetchImpl,fetchImpl:deps.redisFetchImpl};
  if (context.type === 'current_result') {
    try { return {contexts:[await (deps.loadContextImpl || loadResultChatContext)(context.resultId,context.accessToken,options)],actorId:null}; }
    catch(error) { if(error?.code)throw error; throw chatError('RESULT_CONTEXT_UNAVAILABLE'); }
  }
  if (!['history_item','history_comparison'].includes(context.type)) throw chatError('INVALID_CHAT_CONTEXT',400);
  const user=await (deps.currentAccountImpl || currentAccount)(request,options);
  if (!user) throw chatError('AUTH_REQUIRED',401);
  const ids=context.type==='history_comparison' ? (Array.isArray(context.historyItemIds)?context.historyItemIds:[]) : [context.historyItemId];
  const normalizedIds=[...new Set(ids.map(id=>String(id || '').slice(0,160)).filter(Boolean))];
  if (!normalizedIds.length || normalizedIds.length>3) throw chatError('INVALID_HISTORY_SELECTION',400);
  const items=await Promise.all(normalizedIds.map(id=>(deps.getHistoryImpl || getAccountHistoryItem)(user.id,id,options)));
  if(items.some(item=>!item?.fullReport))throw chatError('HISTORY_ITEM_NOT_FOUND',404);
  return {actorId:user.id,contexts:items.map((item,index)=>buildResultChatContext(item.fullReport,{
    resultId:`history:${item.id}`,now:item.analyzedAt,refPrefix:normalizedIds.length>1?`P${index+1}-R`:'R'
  }))};
}

async function enforceChatRateLimit(request, deps, signal) {
  if (!isRedisConfigured() && !deps.redisCommandImpl) return;
  const identity=String(request.headers?.['x-forwarded-for'] || request.socket?.remoteAddress || 'local').split(',')[0].trim();
  const key=`realview:chatbot:rate:v1:${createHash('sha256').update(identity).digest('hex').slice(0,24)}`;
  const reply=await (deps.redisCommandImpl || redisCommand)(['EVAL',
    "local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return {count, redis.call('PTTL', KEYS[1])}",
    '1',key,'300'],{timeoutMs:700,signal});
  const [count,ttl]=Array.isArray(reply)?reply:[reply,300000];
  if(!Number.isFinite(Number(count)) || Number(count)<1)throw chatError('CHAT_POOL_UNAVAILABLE');
  if(Number(count)>30)throw chatError('CHAT_RATE_LIMITED',429,Math.max(1000,Number(ttl)||300000));
}
function validateBody(request) {
  let body;
  try { body=typeof request.body==='string'?JSON.parse(request.body || '{}'):(request.body || {}); }
  catch {throw chatError('INVALID_CHAT_BODY',400);}
  if (!Array.isArray(body.messages) || body.messages.length>8 || !body.messages.length
    || body.messages.some(message=>!message || !['assistant','user'].includes(message.role) || typeof message.content!=='string' || message.content.length>7000)
    || body.messages.at(-1).role!=='user' || !body.messages.at(-1).content.trim()
    || body.messages.at(-1).content.length>500 || Buffer.byteLength(JSON.stringify(body),'utf8')>64000)throw chatError('INVALID_CHAT_BODY',400);
  return body;
}

export function createChatHandler(deps = {}) {
  return async function handler(request,response) {
    const budget=createChatBudget({budgetMs:deps.budgetMs});
    response.setHeader('Cache-Control','private, no-store');
    response.setHeader('X-Request-Id',budget.requestId);
    let providerAttempts=0, contextType='website', source=null, tokens=null, scope=null, claimed=false, replayed=false;
    let generationId=null, contexts=[], idempotencyAvailable=true, statusCode=200, result;
    const attempts=[];
    const localBackground=[];
    let clientRequestId=null,clientRetryCause=null;
    const schedule=async task=>{
      const safe=task.catch(()=>false);
      try {
        if(deps.waitUntilImpl) {deps.waitUntilImpl(safe);return;}
        if(process.env.VERCEL){waitUntil(safe);return;}
      }catch{/* If no platform request context exists, the handler retains ownership. */}
      localBackground.push(safe); // Local handler owns the tasks until finally.
    };
    const send=(httpStatus,payload)=>{
      statusCode=httpStatus;result=payload;
      if(payload.retryAfterMs>0)response.setHeader('Retry-After',String(Math.ceil(payload.retryAfterMs/1000)));
      return response.status(httpStatus).json(payload);
    };
    try {
      if(request.method!=='POST'){response.setHeader('Allow','POST');throw chatError('METHOD_NOT_ALLOWED',405);}
      const body=validateBody(request);
      clientRequestId=/^[a-zA-Z0-9_-]{16,100}$/.test(body.clientRequestId || '')?body.clientRequestId:null;
      clientRetryCause=['frontend_timeout','network_error','context_wait','manual'].includes(body.retryCause)?body.retryCause:null;
      const requestedType=body.context?.type || (body.resultId?'current_result':'website');
      contextType=['website','current_result','history_item','history_comparison'].includes(requestedType)?requestedType:'invalid';
      const resolved=await budget.run('context',signal=>resolveChatContexts(request,body,deps,signal),2000);
      contexts=resolved.contexts;
      scope=chatRequestScope(body,resolved.actorId,request);
      if(scope){
        let claim;
        try { claim=await budget.run('idempotency_read',signal=>claimChatRequest(scope,{commandImpl:deps.redisCommandImpl,signal}),700); }
        catch { idempotencyAvailable=false; }
        if(claim?.state==='complete'){
          replayed=true;source=claim.response.engine;
          return send(200,{...claim.response,requestId:budget.requestId,idempotency:{replayed:true,protected:true,stored:true}});
        }
        if(claim?.state==='pending')throw chatError('CHAT_REQUEST_IN_PROGRESS',409,1000);
        if(claim?.state==='uncertain')throw chatError('CHAT_REQUEST_OUTCOME_UNKNOWN',409);
        if(claim?.state==='conflict')throw chatError('CHAT_REQUEST_ID_CONFLICT',409);
        claimed=claim?.state==='claimed';
        if(!claimed)idempotencyAvailable=false;
      }
      let disabledReason=idempotencyAvailable?null:'idempotency_unavailable';
      try {await budget.run('rate_limit',signal=>(deps.rateLimitImpl || enforceChatRateLimit)(request,deps,signal),800);}
      catch(error){if(error?.code==='CHAT_RATE_LIMITED')throw error;disabledReason ||= 'pool_unavailable';}
      generationId=generateId();
      const finalizeReserve=Math.min(CHAT_FINALIZE_RESERVE_MS,Math.max(1,Math.floor((deps.budgetMs || CHAT_REQUEST_BUDGET_MS)*.06)));
      const aiDeadline=Math.min(budget.deadlineAt-finalizeReserve,Date.now()+10000);
      const answer=await budget.run('answer',signal=>(deps.answerImpl || answerWebsiteQuestion)(body.messages,{
        resultContext:contexts[0] || null,resultContexts:contexts,chatContextType:contextType,language: body.language === 'en' ? 'en' : 'vi',
        providerDisabled:Boolean(disabledReason),disabledReason,deadlineAt:aiDeadline,signal,
        fetchImpl:deps.providerFetchImpl,redisFetchImpl:deps.redisFetchImpl,
        onPhase:(phase,ms)=>{budget.timings[phase]=(budget.timings[phase] || 0)+ms;},
        onProviderAttempt:event=>{if(event.phase==='start')providerAttempts++;else attempts.push(event);},
        onTokenUsage:usage=>{tokens ||= {input:null,output:null,total:null};
          for(const field of ['input','output','total'])if(usage[field]!=null)tokens[field]=(tokens[field] || 0)+usage[field];},
        onBackgroundWork:task=>schedule(task)
      }),Math.max(1,aiDeadline-Date.now()));
      source=answer.engine;
      const envelope={...responseState(answer,budget.requestId),generationId,idempotency:{replayed:false,protected:Boolean(claimed)}};
      if(claimed){
        try { envelope.idempotency.stored=await budget.run('idempotency_write',signal=>completeChatRequest(scope,envelope,{commandImpl:deps.redisCommandImpl,signal}),650); }
        catch {envelope.idempotency.stored=false;} // Never unlock after an ambiguous storage timeout.
      }
      const sent=send(200,envelope);
      await schedule((deps.persistGenerationImpl || persistChatGeneration)({id:generationId,status:'complete',
        resultId:contexts[0]?.resultId || null,answer:answer.answer,engine:answer.engine,model:answer.model || null,citations:answer.citations || [],
        createdAt:new Date(budget.startedAt).toISOString(),completedAt:new Date().toISOString()},{redisTimeoutMs:700}));
      return sent;
    }catch(error){
      if(claimed && providerAttempts===0)await schedule(releaseUnstartedChatRequest(scope,{commandImpl:deps.redisCommandImpl,timeoutMs:600}));
      return send(error?.statusCode || 503,errorState(error,budget.requestId));
    }finally{
      // No content, account/result ID, key, cookie or raw provider text.
      // Provider events include a one-way key fingerprint and fixed reason/source labels.
      (deps.logger || console).log(JSON.stringify({event:'chat_request_completed',requestId:budget.requestId,contextType,
        clientRequestId,clientRetryCause,
        status:result?.status || 'temporarily_unavailable',code:result?.code || null,httpStatus:statusCode,source,
        fallbackReason:result?.fallbackReason || null,providerAttempts,providerOutcomes:attempts,
        replayed,tokenUsage:tokens,timingsMs:budget.timings,totalMs:Date.now()-budget.startedAt}));
      await Promise.all(localBackground);
    }
  };
}
export default createChatHandler();
