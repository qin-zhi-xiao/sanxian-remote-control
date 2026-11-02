const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9222;
const CLICK_TEXT = process.argv[2] || '';
const OUT = process.argv[3] || 'clicked.png';

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
  const dev = list.find(x => x.type === 'page' && x.url.indexOf('tcb.cloud') >= 0);
  if (!dev) { console.log('没有 CloudBase 页面'); return; }

  const ws = new WebSocket(dev.webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r && r.result ? r.result.value : null; };

  await send('Page.bringToFront');
  const clicked = await ev(`(()=>{
    const els=[...document.querySelectorAll('div,span,li,a,button')];
    const t=${JSON.stringify(CLICK_TEXT)};
    const hit=els.find(e=>(e.textContent||'').trim()===t && e.children.length===0);
    if(!hit) return 'not found';
    hit.click();
    return 'clicked';
  })()`);
  console.log('点击', CLICK_TEXT, '=>', clicked);
  await new Promise(r => setTimeout(r, 5000));

  console.log('=== 正文 ===');
  console.log(await ev('(document.body.innerText||"").slice(0,1500)'));

  const s = await send('Page.captureScreenshot', { format: 'png' });
  if (s && s.data) { fs.writeFileSync(path.join(__dirname, OUT), Buffer.from(s.data, 'base64')); console.log('截图:', OUT); }
  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
