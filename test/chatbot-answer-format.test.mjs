import test from 'node:test';
import assert from 'node:assert/strict';
import { attachAnswerDocument, normalizeAnswerDocument, paragraphAnswer, section, formatAnswerText } from '../src/chatbot-answer-format.mjs';
import { answerWebsiteQuestion, knowledgeBase, CHATBOT_RESPONSE_BUDGET_MS } from '../src/site-chatbot.mjs';
import { buildResultChatContext } from '../src/result-chat-context.mjs';
import { validateReportNumbers } from '../src/chatbot-report-format.mjs';

const questions = text => [{ role: 'user', content: text }];
const base = () => ({ ...paragraphAnswer('Trả lời trực tiếp.'), sections: [section('Cách làm', 'steps', ['Bước đầu.', 'Bước sau.'])] });
const context = () => buildResultChatContext({ product: { title: 'Sản phẩm kiểm thử' }, stats: { scanned: 10, included: 8, excluded: 2 },
  trust: { score: 73, pros: [{ label: 'Dễ dùng', evidenceIds: ['a'] }], cons: [{ label: 'Dây ngắn', evidenceIds: ['b'] }] },
  reviews: [{ labelId: 'a', text: 'Dễ dùng.', rating: 5, included: true }, { labelId: 'b', text: 'Dây ngắn.', rating: 2, included: true },
    { text: 'Tốt', rating: 5, included: false, exclusionReason: 'Ít thông tin' }] });

// 60 independent deterministic FAQ cases; no network/model/Redis call is allowed.
for (const entry of knowledgeBase.slice(0, 60)) test(`v2 acceptance FAQ ${entry.id}: đúng nguồn, đủ cấu trúc, không gọi AI`, async () => {
  const fail = () => { throw new Error('Unexpected network call'); };
  const reply = await answerWebsiteQuestion(questions(entry.questionVariants[0]), { fetchImpl: fail, redisFetchImpl: fail });
  assert.equal(reply.sourceId, entry.id);
  assert.equal(reply.answerDocument.version, '2.0');
  assert.equal(reply.answer, formatAnswerText(reply.answerDocument));
  assert.deepEqual(reply.evidence, []);
  const old = await answerWebsiteQuestion(questions(entry.questionVariants[0]), { structuredAnswers: false, fetchImpl: fail, redisFetchImpl: fail });
  assert.equal(old.answer, entry.answer); assert.equal(old.answerDocument, undefined);
});

test('invalid shape, actions, oversized fields and total are rejected, never silently sliced', () => {
  for (const mutate of [x => x.summary='x'.repeat(901), x => x.sections[0].kind='html', x => x.actions=['javascript:alert(1)'],
    x => x.limitations=['x'.repeat(701)], x => x.sections[0].items=[{text:'x'.repeat(1401)}], x => x.sections=Array(6).fill(x.sections[0])]) {
    const value=base();mutate(value);assert.throws(()=>normalizeAnswerDocument(value));
  }
});
test('evidence is scoped to the authorized report and never supplied by model', () => {
  const c=context(),value=base(); value.sections[0].items[0].evidenceRefs=['R001','R999','R001'];
  const reply=attachAnswerDocument({engine:'gemini'},value,[c]);
  assert.deepEqual(reply.citations,['R001']);
  assert.equal(reply.evidence[0].text,c.reviews.find(r=>r.ref==='R001').text);
  assert.equal(reply.evidence[0].included,true);
  assert.deepEqual(attachAnswerDocument({},value,[]).evidence,[]);
});
test('missing/empty numerical fields stay null, genuine zero is preserved', () => {
  const c=buildResultChatContext({trust:{score:null},stats:{scanned:null,included:'',excluded:0}});
  assert.equal(c.trust.score,null);assert.equal(c.stats.scanned,null);assert.equal(c.stats.included,null);assert.equal(c.stats.excluded,0);
  assert.equal(buildResultChatContext({trust:{score:'   '}}).trust.score,null);
});
test('numeric guards reject changed TrustScore/count, including fabricated zero for missing score', () => {
  const c=context();
  assert.throws(()=>validateReportNumbers(normalizeAnswerDocument(paragraphAnswer('TrustScore là 99/100.')),[c]));
  assert.throws(()=>validateReportNumbers(normalizeAnswerDocument(paragraphAnswer('Đã quét 200 review.')),[c]));
  assert.throws(()=>validateReportNumbers(normalizeAnswerDocument(paragraphAnswer('TrustScore: 99. Review đáng tham khảo: 20.')),[c]));
  assert.throws(()=>validateReportNumbers(normalizeAnswerDocument(paragraphAnswer('Review đã quét: 200.')),[c]));
  assert.throws(()=>validateReportNumbers(normalizeAnswerDocument(paragraphAnswer('TrustScore là 0/100.')),[{trust:{score:null}}]));
  validateReportNumbers(normalizeAnswerDocument(paragraphAnswer('TrustScore là 73/100. Đã quét 10 review.')),[c]);
});

for (const scenario of ['complete-long', 'MAX_TOKENS', 'wrong-numbers']) test(`provider acceptance ${scenario}: no partial or fabricated report answer`, async () => {
  const old=process.env.CHATBOT_GEMINI_API_KEY;process.env.CHATBOT_GEMINI_API_KEY='test-format-key';
  const finalSentence='Phần lưu ý cuối được giữ nguyên.';
  const document={...paragraphAnswer(scenario==='wrong-numbers'?'TrustScore: 99.':'Thông tin đã có trong báo cáo.'),
    sections:[section('Giải thích','paragraph',[
      'Phản hồi cần được đọc trong ngữ cảnh trải nghiệm của người mua. '.repeat(12),
      'Không dùng lời nhận xét của người mua để khẳng định thông số sản phẩm đã được xác minh. '.repeat(8)+finalSentence
    ])],limitations:['Chỉ dựa trên báo cáo được cung cấp.']};
  try {
    let calls=0;
    const r=await answerWebsiteQuestion(questions('Giải thích đầy đủ TrustScore của sản phẩm này và giới hạn của kết quả.'),{
      resultContext:context(),fetchImpl:async()=>{
        calls++;
        return new Response(JSON.stringify({candidates:[{finishReason:scenario==='MAX_TOKENS'?'MAX_TOKENS':'STOP',
          content:{parts:[{text:JSON.stringify({supported:true,document})}]}}]}));
      }
    });
    assert.equal(calls,1);
    if(scenario==='complete-long') {
      assert.equal(r.engine,'gemini');assert.ok(r.answer.length>1200);assert.match(r.answer,/Phần lưu ý cuối được giữ nguyên/);
      assert.equal(r.answer,formatAnswerText(r.answerDocument));
    }else {
      assert.equal(r.engine,'rules');assert.ok(r.fallbackReason);assert.doesNotMatch(r.answer,/TrustScore: 99|Phần lưu ý cuối/);
      assert.match(r.answer,/73\/100/);
    }
  }finally{if(old===undefined)delete process.env.CHATBOT_GEMINI_API_KEY;else process.env.CHATBOT_GEMINI_API_KEY=old;}
});

test('offline purchase advice keeps facts and explicitly states unknown limitations', async()=>{
  const c=context(); c.trust.cons=[];
  const r=await answerWebsiteQuestion(questions('Sản phẩm này có nên mua không?'),{resultContext:c,
    fetchImpl:async()=>{throw new Error('offline');},redisFetchImpl:async()=>{throw new Error('offline');}});
  assert.equal(r.engine,'rules');
  assert.match(r.answer,/Dễ dùng/);assert.match(r.answer,/không có nghĩa sản phẩm không có hạn chế/);
  assert.equal(r.evidence[0].ref,'R001');
});
test('comparison fallback does not present the first report as a full comparison', async()=>{
  const first=context(),second=context(); second.product.title='Sản phẩm thứ hai';second.trust.score=62;
  const r=await answerWebsiteQuestion(questions('So sánh TrustScore của các sản phẩm này.'),{resultContext:first,resultContexts:[first,second],
    fetchImpl:async()=>{throw new Error('offline');},redisFetchImpl:async()=>{throw new Error('offline');}});
  assert.equal(r.answerDocument.sections.length,2);assert.match(r.answer,/73\/100/);assert.match(r.answer,/62\/100/);
  assert.match(r.answer,/chưa thể diễn giải câu hỏi so sánh/);assert.deepEqual(r.evidence,[]);
});
test('provider produces structured multi-part answer in one call with per-item verified evidence', async () => {
  const old=process.env.CHATBOT_GEMINI_API_KEY;process.env.CHATBOT_GEMINI_API_KEY='test-format-key';
  let calls=0,body;
  const c=context();
  try {
    const result=await answerWebsiteQuestion(questions('Sản phẩm này có ưu điểm và hạn chế gì?'),{resultContext:c, fetchImpl:async(_url,init)=>{
      calls++;body=JSON.parse(init.body); const document={...paragraphAnswer('Báo cáo ghi nhận điểm thuận lợi và hạn chế.'),
        sections:[section('Ưu điểm','bullets',[{text:'Dễ dùng.',evidenceRefs:['R001','R999']}]),section('Hạn chế','bullets',[{text:'Dây ngắn.',evidenceRefs:['R002']}])],
        limitations:['Đây là review mẫu, không đại diện toàn bộ đánh giá trên sàn.']};
      return new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({supported:true,document})}]}}]}));
    }});
    assert.equal(calls,1);assert.equal(result.engine,'gemini');assert.equal(result.answerDocument.sections.length,2);
    assert.deepEqual(result.citations,['R001','R002']);assert.equal(result.evidence.length,2);
    assert.equal(body.generationConfig.responseSchema.properties.document.type,'object');assert.equal(CHATBOT_RESPONSE_BUDGET_MS,10000);
    assert.doesNotMatch(body.systemInstruction.parts[0].text,/trả lời trực tiếp trong 2–5 câu/);
  } finally { if(old===undefined)delete process.env.CHATBOT_GEMINI_API_KEY;else process.env.CHATBOT_GEMINI_API_KEY=old; }
});
test('long assistant history survives beyond 500 chars, no new network formatting pass', async () => {
  const old=process.env.CHATBOT_GEMINI_API_KEY;process.env.CHATBOT_GEMINI_API_KEY='test-format-key';
  try {
    const history='Nội dung đã giải thích. '.repeat(35)+'Ý cuối cần giữ.';
    await answerWebsiteQuestion([{role:'assistant',content:history},...questions('Vậy ý cuối nghĩa là gì?')],{fetchImpl:async(_u,init)=>{
      const b=JSON.parse(init.body);assert.match(b.contents[0].parts[0].text,/Ý cuối cần giữ/);
      return new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({supported:true,document:paragraphAnswer('Ý cuối cần được đối chiếu với thông tin RealView.')})}]}}]}));
    }});
  } finally {if(old===undefined)delete process.env.CHATBOT_GEMINI_API_KEY;else process.env.CHATBOT_GEMINI_API_KEY=old;}
});
test('rollback flag restores plain answer contract without leaking evidence', async () => {
  const old=process.env.CHATBOT_STRUCTURED_ANSWERS;process.env.CHATBOT_STRUCTURED_ANSWERS='off';
  try {const r=await answerWebsiteQuestion(questions('Cách dùng RealView?'));assert.equal(r.answerDocument,undefined);assert.equal(r.evidence,undefined);}
  finally {if(old===undefined)delete process.env.CHATBOT_STRUCTURED_ANSWERS;else process.env.CHATBOT_STRUCTURED_ANSWERS=old;}
});
