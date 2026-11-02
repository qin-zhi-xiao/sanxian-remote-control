const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9222;
const OWNER = 'qin-zhi-xiao';
const REPO = 'sanxian-remote-control';
const TAG = 'v1.3.0';
const FILE = process.argv[2];
const FNAME = path.basename(FILE);

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

  await send('Page.navigate', { url: `https://github.com/${OWNER}/${REPO}/releases/edit/${TAG}` });
  await new Promise(r => setTimeout(r, 8000));

  const token = await ev(`(document.querySelector('input[name="authenticity_token"]')||{}).value || ''`);
  console.log('token 长度:', token ? token.length : 0);

  // 读文件并转 base64
  const buf = fs.readFileSync(FILE);
  const b64 = buf.toString('base64');
  console.log('文件:', FNAME, '大小', buf.length, '字节, base64', b64.length, '字符');

  const result = await ev(`(async()=>{
    try {
      const b64 = ${JSON.stringify(b64)};
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'application/octet-stream' });

      const url = '/uploads/repos/${OWNER}/${REPO}/releases/${TAG}/assets?name=' + encodeURIComponent(${JSON.stringify(FNAME)});
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-CSRF-Token': ${JSON.stringify(token)},
          'Accept': 'application/json'
        },
        body: blob,
        credentials: 'same-origin'
      });
      const t = await r.text();
      return 'HTTP ' + r.status + ' | ' + t.slice(0, 400);
    } catch(e) { return 'ERR ' + e.message; }
  })()`);

  console.log('=== 上传结果 ===');
  console.log(result);

  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
