const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9222;
const MATCH = process.argv[2] || 'edu.weixin';
const X = parseInt(process.argv[3] || '0', 10);
const Y = parseInt(process.argv[4] || '0', 10);
const OUT = process.argv[5] || '';

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
  if (!pg) { console.log('没找到页面:', MATCH); process.exit(1); }

  const ws = new WebSocket(pg.webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

  await send('Page.bringToFront');
  await new Promise(r => setTimeout(r, 800));

  // 视口缩放换算
  const m = await send('Page.getLayoutMetrics');
  const vw = m.cssLayoutViewport.clientWidth;
  const shot0 = await send('Page.captureScreenshot', { format: 'png' });
  const img = Buffer.from(shot0.data, 'base64');
  const pngW = img.readUInt32BE(16);
  const scale = vw / pngW;

  const vx = X * scale;
  const vy = Y * scale;
  console.log('点击 (图片坐标 ' + X + ',' + Y + ') → 视口 (' + Math.round(vx) + ',' + Math.round(vy) + ')');

  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: vx, y: vy, button: 'left', clickCount: 1 });
  }
  await new Promise(r => setTimeout(r, 5000));

  if (OUT) {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    if (s && s.data) { fs.writeFileSync(path.join(__dirname, OUT), Buffer.from(s.data, 'base64')); console.log('截图:', OUT); }
  }
  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
