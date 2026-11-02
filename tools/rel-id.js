const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9222;
const OWNER = 'qin-zhi-xiao';
const REPO = 'sanxian-remote-control';
const TAG = 'v1.3.0';
const FILE = process.argv[2];

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
  const pg = list.find(x => x.type === 'page' && x.url.indexOf('github.com') >= 0);
  const ws = new WebSocket(pg.webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r && r.exceptionDetails) return 'EXC ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '').slice(0, 300);
    return r && r.result ? r.result.value : null;
  };

  // 1. 找 release id（页面上有 data 属性或者用 API）
  await send('Page.navigate', { url: `https://github.com/${OWNER}/${REPO}/releases/tag/${TAG}` });
  await new Promise(r => setTimeout(r, 8000));

  console.log('=== 页面上的 release 链接 ===');
  console.log(await ev(`JSON.stringify([...document.querySelectorAll('a')].map(a=>a.href).filter(h=>/releases\\/(edit|tag)/.test(h)).slice(0,5), null, 1)`));

  // 2. 用 API 拿 release id
  const relInfo = await ev(`(async()=>{
    try {
      const r = await fetch('/api/v1/repos/${OWNER}/${REPO}/releases/tags/${TAG}', {
        headers: { 'Accept': 'application/json' }, credentials: 'same-origin'
      });
      if(!r.ok) return 'HTTP ' + r.status;
      const j = await r.json();
      return JSON.stringify({id: j.id, upload_url: j.upload_url});
    } catch(e) { return 'ERR ' + e.message; }
  })()`);
  console.log('=== release info ===');
  console.log(relInfo);

  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
