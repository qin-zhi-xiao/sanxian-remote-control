const http = require('http');

const PORT = parseInt(process.argv[2] || '9222', 10);

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
  const page = list.find(x => x.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) return 'EXC ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || '').slice(0, 120);
    return r && r.result ? r.result.value : null;
  };

  // 找「管理」这个元素，看它的 tag / href / 事件
  console.log('=== 管理元素 ===');
  console.log(await ev(`(()=>{
    const els=[...document.querySelectorAll('a,span,button,div')].filter(e=>(e.textContent||'').trim()==='管理');
    return JSON.stringify(els.slice(0,4).map(e=>({tag:e.tagName, cls:e.className, href:e.getAttribute&&e.getAttribute('href'), outer:e.outerHTML.slice(0,220)})), null, 1);
  })()`));

  // 找所有指向 tcb 的链接
  console.log('=== 页面内 tcb 链接 ===');
  console.log(await ev(`(()=>{
    const as=[...document.querySelectorAll('a')].filter(a=>(a.href||'').indexOf('tcb.cloud')>=0);
    return JSON.stringify(as.slice(0,5).map(a=>({t:(a.textContent||'').trim().slice(0,20), h:a.href})), null, 1);
  })()`));

  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
