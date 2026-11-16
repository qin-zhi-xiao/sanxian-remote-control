const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9222;
const BTN = process.argv[2] || 'Update release';
const MATCH = process.argv[3] || 'github.com';

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
  const pg = list.find(x => x.type === 'page' && x.url.indexOf(MATCH) >= 0);
  if (!pg) { console.log('没找到页面'); process.exit(1); }

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

  await send('Page.bringToFront');
  await new Promise(r => setTimeout(r, 1500));

  console.log('点击:', BTN, '→', await ev(`(()=>{
    const t = ${JSON.stringify(BTN)};
    const b = [...document.querySelectorAll('button,summary')].find(x=>(x.innerText||'').trim()===t);
    if(!b) return 'not found';
    b.click();
    return 'clicked';
  })()`));

  await new Promise(r => setTimeout(r, 12000));
  console.log('URL:', await ev('location.href'));

  const s = await send('Page.captureScreenshot', { format: 'png' });
  if (s && s.data) { fs.writeFileSync(path.join(__dirname, 'after-click.png'), Buffer.from(s.data, 'base64')); }
  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
