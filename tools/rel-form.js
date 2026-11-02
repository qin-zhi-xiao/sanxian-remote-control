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

  console.log('=== 所有可输入元素 ===');
  console.log(await ev(`JSON.stringify([...document.querySelectorAll('input,textarea,select')].map(e=>({
    tag:e.tagName, name:e.name||'', id:e.id||'', type:e.type||'',
    ph:e.placeholder||'', val:(e.value||'').slice(0,20)
  })), null, 1)`));

  console.log('=== 按钮 ===');
  console.log(await ev(`JSON.stringify([...document.querySelectorAll('button,a')].map(b=>(b.innerText||'').trim()).filter(t=>t&&t.length<30), null, 1)`));

  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
