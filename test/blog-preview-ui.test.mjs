import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

async function fixture() {
  const html = await readFile(new URL('../public/admin-blog.html', import.meta.url),'utf8');
  const dom = new JSDOM(html,{ url:'https://preview.vercel.app/admin/blog',runScripts:'outside-only' });
  const source = (await readFile(new URL('../public/admin-blog.js',import.meta.url),'utf8'))
    .replace(/^import .*?;\n/,'')
    .replace(/if \(document.readyState === 'loading'\) document.addEventListener\('DOMContentLoaded', initialize, \{ once: true \}\);\nelse initialize\(\);/,'');
  dom.window.TextEncoder = TextEncoder;
  dom.window.scrollTo = () => {};
  dom.window.eval(source+'\nglobalThis.previewTest={state,applyRolePermissions,apiPost,loadRevisions,loadPosts,setAccess,showView,openEditor};');
  return dom;
}
test('preview hides publish/access/discard and disables writes under authoritative read-only', async () => {
  const dom = await fixture();
  try {
    const {state,applyRolePermissions} = dom.window.previewTest;
    Object.assign(state,{authorized:true,role:'admin',backend:'cloudflare-preview',readOnly:false,capabilities:{publishPosts:false,manageAccess:false}});
    applyRolePermissions();
    const get = selector=>dom.window.document.querySelector(selector);
    for (const selector of ['[data-publish-post]','[data-unpublish-post]','[data-access-management]','[data-discard-draft]']) assert.equal(get(selector).hidden,true);
    assert.equal(get('[data-save-post]').disabled,false);
    state.readOnly=true; applyRolePermissions();
    assert.equal(get('[data-save-post]').disabled,true); assert.equal(get('[data-choose-hero]').disabled,true);
    Object.assign(state,{backend:null,capabilities:null,readOnly:false}); applyRolePermissions();
    assert.equal(get('[data-publish-post]').hidden,false); assert.equal(get('[data-access-management]').hidden,false);
  } finally { dom.window.close(); }
});
test('denied or rechecking access cannot reveal admin views or open a blank editor through navigation',async()=>{
  const dom=await fixture();
  try{
    const t=dom.window.previewTest;
    assert.equal(dom.window.document.querySelector('.admin-sidebar').hidden,true);
    assert.equal(dom.window.document.querySelector('.admin-shell').classList.contains('is-access-locked'),true);
    Object.assign(t.state,{authorized:true,role:'admin'});
    t.showView('posts');
    t.setAccess('Tài khoản chưa được cấp quyền','Không có quyền.');
    for(const view of ['posts','editor','guide'])t.showView(view);
    t.openEditor();
    assert.equal(t.state.authorized,false);assert.equal(t.state.role,null);
    assert.equal(dom.window.document.querySelector('[data-access-state]').hidden,false);
    assert.equal(dom.window.document.querySelector('.admin-sidebar').hidden,true);
    for(const view of dom.window.document.querySelectorAll('[data-view]'))assert.equal(view.hidden,true);
    assert.equal(dom.window.document.querySelector('[data-save-post]').disabled,true);
  }finally{dom.window.close();}
});
test('opening a read-only preview editor retains clear lock status and does not advertise old snapshot imports',async()=>{
  const dom=await fixture();
  try{
    dom.window.fetch=async()=>({ok:true,json:async()=>({posts:[],role:'editor',backend:'cloudflare-preview',readOnly:true,
      capabilities:{managePosts:true,publishPosts:false,manageAccess:false}})});
    await dom.window.previewTest.loadPosts();dom.window.previewTest.openEditor();
    assert.match(dom.window.document.querySelector('[data-save-state]').textContent,/Preview đang khóa ghi/);
    assert.match(dom.window.document.querySelectorAll('.admin-snapshot-notice')[0].textContent,/chưa được nhập/);
    assert.equal(dom.window.document.querySelector('[data-save-post]').disabled,true);
  }finally{dom.window.close();}
});
test('UI retains same logical save key after network timeout and generates a new one for changed content', async () => {
  const dom = await fixture();
  try {
    const payloads=[];
    dom.window.fetch = async (_url,options) => {
      payloads.push(JSON.parse(options.body));
      if (payloads.length===1) throw new Error('network response lost');
      return {ok:true,json:async()=>({id:'fixture',revision:1})};
    };
    const body={action:'save',post:{title:'Original',blocks:[]}};
    await assert.rejects(dom.window.previewTest.apiPost(body));
    await dom.window.previewTest.apiPost(body);
    await dom.window.previewTest.apiPost({...body,post:{...body.post,title:'Changed'}});
    assert.equal(payloads[0].idempotencyKey,payloads[1].idempotencyKey);
    assert.notEqual(payloads[1].idempotencyKey,payloads[2].idempotencyKey);
  } finally { dom.window.close(); }
});
test('preview can inspect new revisions but does not advertise unimplemented restore', async () => {
  const dom = await fixture();
  try {
    Object.assign(dom.window.previewTest.state,{backend:'cloudflare-preview',currentPost:{id:'fixture',revision:2}});
    dom.window.fetch=async()=>({ok:true,json:async()=>({revisions:[{revision:1,createdAt:'2026-10-03T00:00:00Z'}]})});
    await dom.window.previewTest.loadRevisions();
    assert.equal(dom.window.document.querySelectorAll('[data-preview-revision]').length,1);
    assert.equal(dom.window.document.querySelectorAll('[data-restore-revision]').length,0);
  } finally { dom.window.close(); }
});
test('preview shows a maintenance warning for missing cron completion or cleanup backlog', async () => {
  for (const maintenance of [{stale:true},{stale:false,warning:true}]) {
    const dom=await fixture();
    try {
      dom.window.fetch=async()=>({ok:true,json:async()=>({posts:[],role:'editor',backend:'cloudflare-preview',readOnly:true,
        capabilities:{managePosts:true,publishPosts:false,manageAccess:false},maintenance})});
      await dom.window.previewTest.loadPosts();
      const message=dom.window.document.querySelector('[data-toast-region]').textContent;
      assert.match(message,maintenance.stale?/3 giờ/:/tồn đọng/);
    }finally{dom.window.close();}
  }
});
