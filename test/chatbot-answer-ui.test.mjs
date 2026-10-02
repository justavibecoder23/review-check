import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { attachAnswerDocument, paragraphAnswer, section } from '../src/chatbot-answer-format.mjs';

function fixture(path = '/') {
  const dom=new JSDOM('<header class="site-header"><div class="header-actions"><a class="header-contact">Liên hệ</a></div></header>',{url:`https://realview.test${path}`,runScripts:'outside-only',pretendToBeVisual:true});
  dom.window.matchMedia=()=>({matches:true,addEventListener(){},removeEventListener(){}});
  dom.window.HTMLElement.prototype.scrollTo=function(){this.dataset.scrolled='yes';};
  const source=readFileSync(new URL('../public/chatbot.js',import.meta.url),'utf8');
  dom.window.eval(source.replace(/\}\)\(\);\s*$/, 'window.chatTest={renderAnswerDocument,chatFailureMessage,addMessage,sendQuestion};})();'));
  return dom;
}
const data=()=>attachAnswerDocument({engine:'gemini'},{...paragraphAnswer('Bạn có thể kiểm tra review theo các bước sau.'),
  sections:[section('Cách thực hiện','steps',['Mở sản phẩm.','Dán liên kết.']),section('Điểm cần đối chiếu','bullets',[
    {text:'Dây ngắn.',evidenceRefs:['R002']}])],limitations:['Chỉ dựa trên review mẫu.'],actions:['criteria']},
  [{product:{title:'Sản phẩm A'},reviews:[{ref:'R002',text:'Dây ngắn, nhưng vẫn dùng tốt.',rating:2,included:true}]}]);

test('real chat renderer uses semantic steps, headings, safe fixed actions, and inline evidence',()=>{
  const dom=fixture();try {
    const result=data();dom.window.chatTest.addMessage('assistant',result.answer,result.engine,result.citations,result);
    const card=dom.window.document.querySelector('.chatbot-answer-card');
    assert.equal(card.querySelectorAll('ol li').length,2);assert.equal(card.querySelectorAll('h3').length,2);
    assert.match(card.querySelector('details').textContent,/R002.*Sản phẩm A.*2 sao.*Được giữ.*Dây ngắn/s);
    const d=card.querySelector('details');d.querySelector('summary').click();assert.equal(d.open,true);
    assert.equal(card.querySelector('nav a').getAttribute('href'),'/tieu-chi-loc');
  }finally{dom.window.close();}
});
test('model and review HTML, script, image and javascript URL cannot execute through renderer',()=>{
  const dom=fixture();try{
    const r=data();r.answerDocument.summary='<img src=x onerror=alert(1)><script>alert(1)</script>';
    r.answerDocument.sections[0].title='<svg onload=alert(1)>';
    r.evidence[0].text='<iframe src="https://evil.test"></iframe>';
    r.answerDocument.actions=['javascript:alert(1)','__proto__'];
    dom.window.chatTest.addMessage('assistant',r.answer,'gemini',r.citations,r);
    const card=dom.window.document.querySelector('.chatbot-answer-card');
    assert.equal(card.querySelectorAll('img,script,svg,iframe,a').length,0);
    assert.match(card.textContent,/<img src=x/);
  }finally{dom.window.close();}
});
test('bad documents fall back to safe plain text and old API responses still render',()=>{
  const dom=fixture();try{
    const r=data();r.answerDocument.sections[0].items=[{text:{html:'bad'}}];
    dom.window.chatTest.addMessage('assistant','Fallback <b>text</b>','gemini',[],r);
    assert.equal(dom.window.document.querySelector('.chatbot-answer-card'),null);
    const p=dom.window.document.querySelector('.chatbot-message:last-child p');assert.equal(p.textContent,'Fallback <b>text</b>');assert.equal(p.querySelector('b'),null);
  }finally{dom.window.close();}
});
test('fallback labels distinguish quota and timeout without claiming deterministic rules require AI',()=>{
  const dom=fixture();try{
    for(const [reason,label] of [['quota_exhausted','AI hết hạn mức'],['timeout','AI quá thời gian chờ'],[null,'Dữ liệu RealView']]) {
      const r=data();r.fallbackReason=reason;
      const message=dom.window.chatTest.addMessage('assistant',r.answer,'rules',r.citations,r);
      assert.equal(message.querySelector('time').textContent,`Dữ liệu RealView${reason?` · ${label}`:''}`);
    }
  }finally{dom.window.close();}
});
test('new assistant messages do not steal scroll position when reader is viewing earlier messages',()=>{
  const dom=fixture();try{
    const root=dom.window.document.querySelector('.chatbot-messages');
    Object.defineProperties(root,{scrollHeight:{value:2000},clientHeight:{value:400},scrollTop:{value:100}});
    dom.window.chatTest.addMessage('assistant','Đáp án mới.');assert.equal(root.dataset.scrolled,undefined);
    dom.window.chatTest.addMessage('user','Câu hỏi mới.');assert.equal(root.dataset.scrolled,'yes');
  }finally{dom.window.close();}
});
for(const code of ['RESULT_CONTEXT_PREPARING','RESULT_CONTEXT_NOT_FOUND','RESULT_CONTEXT_FORBIDDEN','RESULT_CONTEXT_UNAVAILABLE','AUTH_REQUIRED','HISTORY_ITEM_NOT_FOUND','CHAT_RATE_LIMITED']) {
  test(`error ${code} is distinct from generic AI connection failure`,()=>{
    const dom=fixture();try{const message=dom.window.chatTest.chatFailureMessage({code});assert.doesNotMatch(message,/Hiện chưa kết nối/);assert.ok(message.length>20);}finally{dom.window.close();}
  });
}
test('chat request forwards selected context instead of silently switching to website-only',async()=>{
  const dom=fixture('/ket-qua');try{
    dom.window.sessionStorage.setItem('realview:last-analysis',JSON.stringify({chatContext:{available:true,resultId:'report-1',accessToken:'test-token'}}));
    let body;dom.window.fetch=async(_url,init)=>{body=JSON.parse(init.body);return{ok:false,status:403,json:async()=>({code:'RESULT_CONTEXT_FORBIDDEN'})};};
    await dom.window.chatTest.sendQuestion('Sản phẩm này có vấn đề gì?');
    assert.equal(body.context.resultId,'report-1');
    assert.match(dom.window.document.querySelector('.chatbot-message:last-child').textContent,/Quyền hỏi đáp báo cáo/);
  }finally{dom.window.close();}
});
test('network retry retains request ID, session and original messages; recovered answer enters follow-up history',async()=>{
  const dom=fixture();try{
    const bodies=[];dom.window.fetch=async(_u,init)=>{
      bodies.push(JSON.parse(init.body));
      if(bodies.length===1)throw new dom.window.TypeError('Network lost');
      return{ok:true,status:200,json:async()=>({answer:'Đáp án đã khôi phục.',engine:'gemini',status:'answered',retryable:false,idempotency:{replayed:true}})};
    };
    await dom.window.chatTest.sendQuestion('Giải thích RealView theo cách khác nhé');
    assert.ok(dom.window.document.querySelector('.chatbot-retry'));
    assert.equal(dom.window.document.querySelector('#chatbot-input').value,'Giải thích RealView theo cách khác nhé');
    await dom.window.chatTest.sendQuestion('Giải thích RealView theo cách khác nhé');
    assert.equal(bodies[0].clientRequestId,bodies[1].clientRequestId);
    assert.equal(bodies[0].clientSessionId,bodies[1].clientSessionId);
    assert.deepEqual(bodies[0].messages,bodies[1].messages);assert.equal(bodies[1].retryCause,'network_error');
    assert.equal(dom.window.document.querySelectorAll('.chatbot-message--user').length,1);
    await dom.window.chatTest.sendQuestion('Vậy ý đó là gì?');
    assert.notEqual(bodies[2].clientRequestId,bodies[0].clientRequestId);
    assert.ok(bodies[2].messages.some(message=>message.role==='assistant' && /khôi phục/.test(message.content)));
  }finally{dom.window.close();}
});
test('malformed HTTP responses are not displayed as completed answers and retry keeps the same ID',async()=>{
  const dom=fixture();try{
    const bodies=[];dom.window.fetch=async(_u,init)=>{
      bodies.push(JSON.parse(init.body));
      if(bodies.length===1)return{ok:true,status:200,json:async()=>{throw new SyntaxError('invalid JSON');}};
      if(bodies.length===2)return{ok:true,status:200,json:async()=>({})};
      return{ok:true,status:200,json:async()=>({answer:'Đáp án đã khôi phục.',engine:'gemini',retryable:false,idempotency:{replayed:true}})};
    };
    await dom.window.chatTest.sendQuestion('Giải thích giúp tôi');
    assert.match(dom.window.document.querySelector('.chatbot-message:last-child').textContent,/Phản hồi trả về chưa hợp lệ/);
    assert.ok(dom.window.document.querySelector('.chatbot-retry'));
    await dom.window.chatTest.sendQuestion('Giải thích giúp tôi');
    assert.match(dom.window.document.querySelector('.chatbot-message:last-child').textContent,/Phản hồi trả về chưa hợp lệ/);
    await dom.window.chatTest.sendQuestion('Giải thích giúp tôi');
    assert.equal(new Set(bodies.map(body=>body.clientRequestId)).size,1);
    assert.equal(dom.window.document.querySelectorAll('.chatbot-message--user').length,1);
    assert.match(dom.window.document.querySelector('.chatbot-message:last-child').textContent,/Đáp án đã khôi phục/);
  }finally{dom.window.close();}
});
test('quota fallback does not offer retry; logout removes retry controls',async()=>{
  const dom=fixture();try{
    dom.window.fetch=async()=>({ok:true,status:200,json:async()=>({answer:'Dữ liệu có sẵn.',engine:'rules',status:'fallback',fallbackReason:'quota_exhausted',retryable:false})});
    await dom.window.chatTest.sendQuestion('Một câu hỏi');assert.equal(dom.window.document.querySelector('.chatbot-retry'),null);
    dom.window.fetch=async()=>{throw new dom.window.TypeError('lost');};
    await dom.window.chatTest.sendQuestion('Câu khác');assert.ok(dom.window.document.querySelector('.chatbot-retry'));
    dom.window.dispatchEvent(new dom.window.CustomEvent('realview:auth-changed',{detail:{user:null}}));
    assert.equal(dom.window.document.querySelector('.chatbot-retry'),null);
  }finally{dom.window.close();}
});
test('context preparation retries are bounded, with one shared browser signal and request ID',async()=>{
  const dom=fixture();try{
    const calls=[];dom.window.fetch=async(_u,init)=>{calls.push({body:JSON.parse(init.body),signal:init.signal});
      return{ok:false,status:409,json:async()=>({code:'RESULT_CONTEXT_PREPARING',retryable:true,retryAfterMs:400})};};
    await dom.window.chatTest.sendQuestion('Giải thích báo cáo');assert.equal(calls.length,3);
    assert.ok(calls.every(c=>c.body.clientRequestId===calls[0].body.clientRequestId && c.signal===calls[0].signal));
    assert.match(dom.window.document.querySelector('.chatbot-message:last-child').textContent,/vẫn đang được chuẩn bị/);
  }finally{dom.window.close();}
});
test('account change cancels an in-flight private answer and does not restore its question or retry',async()=>{
  const dom=fixture();try{
    let release,ready;const started=new Promise(resolve=>{ready=resolve;});
    dom.window.fetch=async()=>{ready();await new Promise(resolve=>{release=resolve;});
      return{ok:true,status:200,json:async()=>({answer:'Nội dung riêng của tài khoản cũ',engine:'gemini'})};};
    const pending=dom.window.chatTest.sendQuestion('Câu hỏi riêng trước khi đổi tài khoản');await started;
    dom.window.dispatchEvent(new dom.window.CustomEvent('realview:auth-changed',{detail:{user:{id:'another-account'}}}));
    release();await pending;
    assert.doesNotMatch(dom.window.document.querySelector('.chatbot-messages').textContent,/Nội dung riêng|Câu hỏi riêng/);
    assert.equal(dom.window.document.querySelector('.chatbot-retry'),null);assert.equal(dom.window.document.querySelector('#chatbot-input').value,'');
  }finally{dom.window.close();}
});
