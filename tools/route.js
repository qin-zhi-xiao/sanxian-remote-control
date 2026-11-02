const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9222;
const ROUTE = process.argv[2] || 'pages/agent/agent';
const OUT = process.argv[3] || 'route.png';

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
  const page = list.find(x => x.type === 'page' && x.url.indexOf('edu.weixin') >= 0);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) return 'EXC: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '').slice(0, 200);
    return r && r.result ? r.result.value : null;
  };

  // 列出所有 iframe 和它们的 src
  console.log('=== iframes ===');
  console.log(await ev(`JSON.stringify([...document.querySelectorAll('iframe')].map((f,i)=>({i, src:(f.src||'').slice(0,100), id:f.id, cls:f.className})), null, 1)`));

  // 尝试直接改模拟器路由
  const res = await ev(`(()=>{
    const out = { tried: [] };
    // 找模拟器 iframe
    const ifrs = [...document.querySelectorAll('iframe')];
    for (const f of ifrs) {
      try {
        const w = f.contentWindow;
        if (w && w.__wxConfig) { out.tried.push('wxConfig:' + f.id); }
        if (w && w.wx && w.wx.navigateTo) { out.tried.push('wx.navigateTo:' + f.id); }
      } catch(e) { out.tried.push('err:' + f.id); }
    }
    return JSON.stringify(out);
  })()`);
  console.log('=== 模拟器探测 ===');
  console.log(res);

  await new Promise(r => setTimeout(r, 2000));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, OUT), Buffer.from(shot.data, 'base64'));
  console.log('截图:', OUT);
  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
