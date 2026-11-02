const http = require('http');
const fs = require('fs');
const path = require('path');

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
  const pages = list.filter(x => x.type === 'page');
  console.log('=== 所有页面 ===');
  pages.forEach((p, i) => console.log(i, p.title, '\n   ', p.url.slice(0, 120)));

  const tcb = pages.find(p => p.url.indexOf('tcb.cloud') >= 0);
  if (!tcb) { console.log('没有云控制台页面'); return; }

  const ws = new WebSocket(tcb.webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r && r.result ? r.result.value : null; };

  await send('Page.bringToFront');
  console.log('=== 云控制台文本 ===');
  console.log((await ev('(document.body.innerText||"").slice(0,600)')));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot && shot.data) {
    fs.writeFileSync(path.join(__dirname, 'tcb.png'), Buffer.from(shot.data, 'base64'));
    console.log('截图: tcb.png');
  }
  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
