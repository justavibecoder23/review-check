import { createHash, randomUUID } from 'node:crypto';
import { isRedisConfigured, redisCommand } from './redis-rest.mjs';
import { chatError } from './chatbot-reliability.mjs';

export const CHAT_REPLAY_TTL_SECONDS = 900;
export const CHAT_REQUEST_LEASE_MS = 45_000;
export const CLAIM_CHAT_REQUEST_SCRIPT = String.raw`
-- CHAT_REQUEST_CLAIM_V1
local raw = redis.call('GET', KEYS[1])
if raw then
  local record = cjson.decode(raw)
  if record.fingerprint ~= ARGV[1] then return cjson.encode({state='conflict'}) end
  if record.state == 'complete' then return cjson.encode({state='complete', responseJson=record.responseJson}) end
  if tonumber(record.leaseUntilMs or 0) <= tonumber(ARGV[3]) then
    record.state = 'uncertain'
    redis.call('SET', KEYS[1], cjson.encode(record), 'KEEPTTL')
    return cjson.encode({state='uncertain'})
  end
  return cjson.encode({state='pending'})
end
redis.call('SET', KEYS[1], cjson.encode({state='pending', fingerprint=ARGV[1], owner=ARGV[2],
  leaseUntilMs=tonumber(ARGV[3])+tonumber(ARGV[4])}), 'EX', ARGV[5])
return cjson.encode({state='claimed'})
`;
export const COMPLETE_CHAT_REQUEST_SCRIPT = String.raw`
-- CHAT_REQUEST_COMPLETE_V1
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local record = cjson.decode(raw)
if record.owner ~= ARGV[1] or record.fingerprint ~= ARGV[2] then return 0 end
if record.state == 'complete' then return 1 end
record.state = 'complete'
-- Keep serialized JSON verbatim: Lua cjson round-trips empty arrays as {}.
record.responseJson = ARGV[3]
redis.call('SET', KEYS[1], cjson.encode(record), 'EX', ARGV[4])
return 1
`;
const hash = value => createHash('sha256').update(value).digest('hex');
export const RELEASE_UNSTARTED_CHAT_REQUEST_SCRIPT = String.raw`
-- CHAT_REQUEST_RELEASE_UNSTARTED_V1
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local record = cjson.decode(raw)
if record.owner ~= ARGV[1] or record.fingerprint ~= ARGV[2] or record.state == 'complete' then return 0 end
return redis.call('DEL', KEYS[1])
`;
function contextDescriptor(body) {
  const context = body.context || (body.resultId ? {type:'current_result',resultId:body.resultId,accessToken:body.resultAccessToken} : null);
  if (!context) return {type:'website'};
  if (context.type === 'current_result') return {type:context.type,resultId:context.resultId,capability:hash(String(context.accessToken || ''))};
  return {type:context.type,historyItemId:context.historyItemId,historyItemIds:context.historyItemIds};
}
export function chatRequestScope(body, actorId, request) {
  if (!body.clientRequestId) return null; // Compatibility for clients before this upgrade.
  if (typeof body.clientRequestId!=='string' || typeof body.clientSessionId!=='string'
    || !/^[a-zA-Z0-9_-]{16,100}$/.test(body.clientRequestId) || !/^[a-zA-Z0-9_-]{16,100}$/.test(body.clientSessionId)) throw chatError('INVALID_CHAT_REQUEST_ID',400);
  const descriptor = contextDescriptor(body);
  // History authorization must be checked again BEFORE reading a cached response.
  // Current-result capability is hashed, never stored/logged in cleartext here.
  const sessionCookie=String(request.headers?.cookie || '').match(/(?:^|;\s*)realview_session=([^;]+)/)?.[1] || '';
  const identity = actorId ? `account:${actorId}` : `session:${body.clientSessionId}:${hash(sessionCookie)}`;
  const scope = hash(JSON.stringify({identity,session:body.clientSessionId,context:descriptor}));
  const fingerprint = hash(JSON.stringify({messages:body.messages,language:body.language==='en'?'en':'vi',context:descriptor}));
  return {key:`realview:chatbot:request:v1:${scope}:${body.clientRequestId}`,fingerprint,owner:randomUUID()};
}
export async function claimChatRequest(scope, options = {}) {
  if (!scope) return {state:'unmanaged'};
  if (!isRedisConfigured() && !options.commandImpl) throw chatError('CHAT_IDEMPOTENCY_UNAVAILABLE');
  const raw = await (options.commandImpl || redisCommand)(['EVAL',CLAIM_CHAT_REQUEST_SCRIPT,'1',scope.key,
    scope.fingerprint,scope.owner,String(options.nowMs || Date.now()),String(CHAT_REQUEST_LEASE_MS),String(CHAT_REPLAY_TTL_SECONDS)],{timeoutMs:options.timeoutMs || 600,signal:options.signal});
  const claim=typeof raw==='string'?JSON.parse(raw):raw;
  if(claim?.state==='complete')claim.response=JSON.parse(claim.responseJson);
  return claim;
}
export async function completeChatRequest(scope, response, options = {}) {
  if (!scope) return false;
  return Number(await (options.commandImpl || redisCommand)(['EVAL',COMPLETE_CHAT_REQUEST_SCRIPT,'1',scope.key,scope.owner,
    scope.fingerprint,JSON.stringify(response),String(CHAT_REPLAY_TTL_SECONDS)],{timeoutMs:options.timeoutMs || 600,signal:options.signal}))===1;
}
// Only before any provider call. A timeout is NOT proof Gemini did no work.
export async function releaseUnstartedChatRequest(scope, options = {}) {
  if (!scope) return false;
  return Number(await (options.commandImpl || redisCommand)(['EVAL',RELEASE_UNSTARTED_CHAT_REQUEST_SCRIPT,'1',scope.key,
    scope.owner,scope.fingerprint],{timeoutMs:options.timeoutMs || 600,signal:options.signal}))===1;
}
