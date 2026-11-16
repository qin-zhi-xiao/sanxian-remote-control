const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9222;
const MATCH = process.argv[2] || 'scf/detail';
const FILE = process.argv[3];
const OUT = process.argv[4] || '';

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
    if (r && r.exceptionDetails) return 'EXC';
    return r && r.result ? r.result.value : null;
  };

  await send('DOM.enable');
  const doc = await send('DOM.getDocument', { depth: -1, pierce: true });
  const q = await send('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
  const n = q.nodeIds ? q.nodeIds.length : 0;
  console.log('file input 数量:', n);
  if (!n) {
    console.log('页面里没有 file input（可能是系统对话框）');
    ws.close(); process.exit(1);
  }

  const nodeId = q.nodeIds[n - 1];
  await send('DOM.setFileInputFiles', { files: [FILE], nodeId });
  console.log('已设置文件:', FILE);
  await new Promise(r => setTimeout(r, 6000));

  console.log('页面状态:', await ev("(document.body.innerText||'').split('\\n').filter(function(l){return /zip|部署|KB|MB/.test(l)}).slice(0,6).join(' | ')"));

  if (OUT) {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    if (s && s.data) { fs.writeFileSync(path.join(__dirname, OUT), Buffer.from(s.data, 'base64')); console.log('截图:', OUT); }
  }
  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
