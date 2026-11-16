const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9222;
const MATCH = process.argv[2] || 'scf/detail';
const TEXT = process.argv[3] || '';
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
    if (r && r.exceptionDetails) return 'EXC ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '').slice(0, 200);
    return r && r.result ? r.result.value : null;
  };

  await send('Page.bringToFront');
  await new Promise(r => setTimeout(r, 500));

  const pos = await ev(`(function(){
    var t = ${JSON.stringify(TEXT)};
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      if (e.children.length > 2) continue;
      var s = (e.textContent || '').trim();
      if (s !== t) continue;
      var b = e.getBoundingClientRect();
      if (b.width <= 0 || b.height <= 0) continue;
      return JSON.stringify({x: Math.round(b.left + b.width/2), y: Math.round(b.top + b.height/2), tag: e.tagName, cls: String(e.className||'').slice(0,40)});
    }
    return null;
  })()`);
  console.log('目标:', TEXT, '→', pos);
  if (!pos || pos.indexOf('EXC') === 0) { ws.close(); process.exit(1); }
  const p = JSON.parse(pos);

  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
  }
  console.log('已点击 (' + p.x + ',' + p.y + ') ' + p.tag + '.' + p.cls);
  await new Promise(r => setTimeout(r, 4000));

  if (OUT) {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    if (s && s.data) { fs.writeFileSync(path.join(__dirname, OUT), Buffer.from(s.data, 'base64')); console.log('截图:', OUT); }
  }
  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
