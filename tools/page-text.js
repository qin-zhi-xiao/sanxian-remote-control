const http = require('http');

const PORT = 9222;
const MATCH = process.argv[2] || '/hosting';
const SHOT = process.argv[3] || '';

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
  const dev = list.find(x => x.type === 'page' && x.url.indexOf(MATCH) >= 0);
  if (!dev) { console.log('没有匹配页面:', MATCH); return; }

  const ws = new WebSocket(dev.webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r && r.result ? r.result.value : null; };

  await send('Page.bringToFront');
  console.log('=== 正文 ===');
  console.log(await ev('(document.body.innerText||"").slice(0,1200)'));

  if (SHOT) {
    const fs = require('fs');
    const path = require('path');
    const s = await send('Page.captureScreenshot', { format: 'png' });
    if (s && s.data) { fs.writeFileSync(path.join(__dirname, SHOT), Buffer.from(s.data, 'base64')); console.log('截图:', SHOT); }
  }
  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
