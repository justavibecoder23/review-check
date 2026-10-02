import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const execute = promisify(execFile);
const deployment = process.argv[2];
const production = process.argv.includes('--production') && deployment === 'https://www.realview.com.vn';
if (!deployment || (!production && !/^https:\/\/realview-[a-z0-9]+-tnt-s-projects1\.vercel\.app$/.test(deployment))) {
  throw new Error('Expected an explicit RealView preview URL, or the production domain with --production.');
}
const session = `chat-${production ? 'production' : 'preview'}-${randomUUID()}`;
const results = [];
const turn = (question, extras = {}) => ({
  messages: [{ role: 'user', content: question }],
  clientRequestId: `chat-preview-${randomUUID()}`, clientSessionId: session, ...extras
});
async function call(body) {
  const { stdout } = await execute('vercel', ['curl', '/api/chat', '--deployment', deployment,
    '--', '--request', 'POST', '--header', 'Content-Type: application/json', '--data', JSON.stringify(body),
    '--silent', '--show-error', '--max-time', '20', '--include', '--write-out', '\n__META__%{json}'],
  { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  const marker = stdout.lastIndexOf('\n__META__');
  const meta = JSON.parse(stdout.slice(marker + '\n__META__'.length));
  const response = stdout.slice(0, marker);
  const boundary = response.lastIndexOf('\r\n\r\n');
  const data = JSON.parse(response.slice(boundary + 4));
  const headers = {};
  for (const line of response.slice(0, boundary).split('\r\n')) {
    const match = /^(cache-control|x-request-id|retry-after):\s*(.*)$/i.exec(line);
    if (match) headers[match[1].toLowerCase()] = match[2];
  }
  return { http: Number(meta.http_code), timeMs: Math.round(meta.time_total * 1000), headers, data };
}
function check(name, response, expected) {
  const passed = expected(response);
  results.push({ name, passed, ...response });
  return response;
}
const faqTurn = turn('RealView hoạt động thế nào?');
const faq = check('FAQ uses v2 and a stored private response', await call(faqTurn), r =>
  r.http === 200 && r.data.status === 'answered' && r.data.engine === 'knowledge-base'
  && r.data.answerDocument?.version === '2.0' && r.data.idempotency?.stored === true
  && /private.*no-store/.test(r.headers['cache-control'] || '') && Boolean(r.data.requestId));
check('Same request replays the same answer and generation', await call(faqTurn), r =>
  r.http === 200 && r.data.idempotency?.replayed === true && r.data.generationId === faq.data.generationId
  && r.data.answer === faq.data.answer && r.data.requestId !== faq.data.requestId);
check('Changed payload with the same ID is rejected', await call({ ...faqTurn, messages: [{ role: 'user', content: 'TrustScore là gì?' }] }),
  r => r.http === 409 && r.data.code === 'CHAT_REQUEST_ID_CONFLICT' && r.data.retryable === false);
const concurrentTurn = turn('Rating cao có đồng nghĩa TrustScore cao không?');
const concurrent = await Promise.all([call(concurrentTurn), call(concurrentTurn)]);
concurrent.forEach((r, i) => check(`Concurrent duplicate ${i + 1} is answered/replayed or pending, not an extra owner`, r,
  r => (r.http === 200 && r.data.engine === 'knowledge-base') || (r.http === 409 && r.data.code === 'CHAT_REQUEST_IN_PROGRESS')));
check('Concurrent duplicate resolves to the cached response', await call(concurrentTurn), r =>
  r.http === 200 && r.data.idempotency?.replayed === true);
check('Malformed request is rejected', await call({ messages: [] }), r => r.http === 400 && r.data.code === 'INVALID_CHAT_BODY');
check('History requires login instead of website fallback', await call(turn('Báo cáo này có gì cần lưu ý?', { context: { type: 'history_item', historyItemId: 'preview-not-a-real-report' } })),
  r => r.http === 401 && r.data.code === 'AUTH_REQUIRED' && !r.data.answer);
check('Invalid result capability is rejected instead of website fallback', await call(turn('Báo cáo này có gì cần lưu ý?', {
  context: { type: 'current_result', resultId: 'preview-not-a-real-report', accessToken: 'preview-invalid-capability' }
})), r => r.http >= 400 && /^RESULT_CONTEXT_/.test(r.data.code || '') && !r.data.answer);
const open = await call(turn('Hãy giải thích cách RealView giúp tôi cân nhắc khi có nhiều đánh giá trái chiều, theo một ví dụ không có số liệu giả.'));
results.push({ name: 'Open question: observe real Gemini or the explicit environment fallback', observed: true, ...open });
console.log(JSON.stringify({ deployment, testedAt: new Date().toISOString(),
  passed: results.filter(r => r.passed === true).length, failed: results.filter(r => r.passed === false).length,
  results }, null, 2));
if (results.some(r => r.passed === false)) process.exitCode = 1;
