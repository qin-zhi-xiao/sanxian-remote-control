const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9222;
const FILE = process.argv[2];
const OUT = process.argv[3] || 'uploaded.png';

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

  // 找文件输入（拖拽区通常有隐藏的 input[type=file]）
  console.log('=== file inputs ===');
  console.log(await ev(`JSON.stringify([...document.querySelectorAll('input[type=file]')].map(e=>({name:e.name||'', id:e.id||'', multiple:e.multiple})), null, 1)`));

  // 用 CDP 设置文件
  const doc = await send('DOM.getDocument', { depth: -1 });
  const q = await send('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
  console.log('file input 节点数:', q.nodeIds ? q.nodeIds.length : 0);

  if (q.nodeIds && q.nodeIds.length) {
    const nodeId = q.nodeIds[q.nodeIds.length - 1];
    console.log('设置文件:', FILE);
    try {
      await send('DOM.setFileInputFiles', { files: [FILE], nodeId });
      console.log('文件已设置，等待上传…');
    } catch (e) {
      console.log('设置失败:', e.message);
    }
    await new Promise(r => setTimeout(r, 15000));
  }

  console.log('=== 页面状态 ===');
  console.log((await ev('(document.body.innerText||"").slice(-600)')));

  const s = await send('Page.captureScreenshot', { format: 'png' });
  if (s && s.data) { fs.writeFileSync(path.join(__dirname, OUT), Buffer.from(s.data, 'base64')); console.log('截图:', OUT); }
  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
