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
    if (r && r.exceptionDetails) return 'EXC ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '').slice(0, 250);
    return r && r.result ? r.result.value : null;
  };

  // 先把文件内容读成 base64 注入页面，再造 File 对象
  const buf = fs.readFileSync(FILE);
  const b64 = buf.toString('base64');
  const fname = path.basename(FILE);
  console.log('文件:', fname, buf.length, '字节');

  const r = await ev(`(function(){
    var b64 = ${JSON.stringify(b64)};
    var bin = atob(b64);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    var file = new File([arr], ${JSON.stringify(fname)}, {type: 'application/zip'});

    var dt = new DataTransfer();
    dt.items.add(file);

    var inputs = document.querySelectorAll('input[type=file]');
    if (!inputs.length) return 'no input';
    var el = inputs[inputs.length - 1];
    el.files = dt.files;
    el.dispatchEvent(new Event('change', {bubbles: true}));
    el.dispatchEvent(new Event('input', {bubbles: true}));
    return 'ok, files=' + el.files.length + ' size=' + (el.files[0] ? el.files[0].size : 0);
  })()`);
  console.log('注入结果:', r);
  await new Promise(r => setTimeout(r, 5000));

  console.log('页面状态:', await ev("(document.body.innerText||'').split('\\n').filter(function(l){return /zip|KB|MB|部署/.test(l)}).slice(0,6).join(' | ')"));

  if (OUT) {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    if (s && s.data) { fs.writeFileSync(path.join(__dirname, OUT), Buffer.from(s.data, 'base64')); console.log('截图:', OUT); }
  }
  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
