const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9222;

function getJson(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
      let b = '';
      r.on('data', c => (b += c));
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

(async () => {
  const list = await getJson('/json/list');
  const pg = list.find(x => x.type === 'page' && x.url.indexOf('releases/new') >= 0);
  const ws = new WebSocket(pg.webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r && r.exceptionDetails) return 'EXC ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '').slice(0, 200);
    return r && r.result ? r.result.value : null;
  };

  // 直接设置 hidden 的 tag 字段（GitHub release 表单认这个）
  console.log('设置 tag:', await ev(`(()=>{
    const el = document.getElementById('release_tag_name');
    if(!el) return 'no el';
    el.value = 'v1.3.0';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  })()`));
  await new Promise(r => setTimeout(r, 1000));

  // 找标题输入框（通常 name=release[name]）
  console.log('=== release[name] 存在? ===');
  console.log(await ev(`(()=>{
    const el = document.querySelector('[name="release[name]"]');
    return el ? (el.tagName + ' ' + el.type + ' ph=' + (el.placeholder||'')) : 'not found';
  })()`));

  // 列出所有 textarea / contenteditable（正文编辑器）
  console.log('=== 正文编辑器 ===');
  console.log(await ev(`JSON.stringify([...document.querySelectorAll('textarea,[contenteditable="true"],[contenteditable=""]')].map(e=>({tag:e.tagName, name:e.name||'', id:e.id||'', ph:e.placeholder||'', cls:(e.className||'').toString().slice(0,50)})), null, 1)`));

  const s = await send('Page.captureScreenshot', { format: 'png' });
  if (s && s.data) { fs.writeFileSync(path.join(__dirname, 'rel2.png'), Buffer.from(s.data, 'base64')); console.log('截图: rel2.png'); }
  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
