const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9222;
const MATCH = process.argv[2] || 'edu.weixin';
const SEL = process.argv[3] || '';
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
  await new Promise(r => setTimeout(r, 600));

  // 找到元素并取 CSS 坐标
  const pos = await ev(`(function(){
    var el = document.querySelector(${JSON.stringify(SEL)});
    if (!el) return null;
    var b = el.getBoundingClientRect();
    return JSON.stringify({x: Math.round(b.left + b.width/2), y: Math.round(b.top + b.height/2), w: Math.round(b.width), h: Math.round(b.height)});
  })()`);
  console.log('元素位置:', pos);
  if (!pos) { ws.close(); process.exit(1); }
  const p = JSON.parse(pos);

  // 直接用 CSS 像素坐标点击（CDP Input 用的就是 CSS 像素）
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
  }
  console.log('已点击 (' + p.x + ',' + p.y + ')');
  await new Promise(r => setTimeout(r, 5000));

  if (OUT) {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    if (s && s.data) { fs.writeFileSync(path.join(__dirname, OUT), Buffer.from(s.data, 'base64')); console.log('截图:', OUT); }
  }
  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
