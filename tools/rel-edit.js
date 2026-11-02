const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9222;
const OWNER = 'qin-zhi-xiao';
const REPO = 'sanxian-remote-control';
const TAG = 'v1.3.0';

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

  // 用页面的 edit 链接拿 release id
  console.log('=== 找 edit 链接 ===');
  const editUrl = await ev(`(()=>{
    const a=[...document.querySelectorAll('a')].map(x=>x.href).filter(h=>h.indexOf('/releases/edit/')>=0);
    return a.length ? a[0] : 'none';
  })()`);
  console.log('edit URL:', editUrl);

  if (editUrl === 'none') {
    // 尝试直接构造：从页面 HTML 里搜 release id
    console.log('=== 搜索页面数据 ===');
    console.log(await ev(`(()=>{
      const html = document.documentElement.innerHTML;
      const m = html.match(/releases\\/edit\\/(\\d+)/);
      return m ? 'found id: ' + m[1] : 'not found';
    })()`));
  }

  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
