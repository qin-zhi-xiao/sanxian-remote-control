const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9222;
const CLICK_X = parseInt(process.argv[2] || '0', 10);
const CLICK_Y = parseInt(process.argv[3] || '0', 10);
const OUT = process.argv[4] || 'shot.png';

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
  const page = list.find(x => x.type === 'page' && x.url.indexOf('edu.weixin') >= 0);
  if (!page) { console.log('no editor'); return; }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

  await send('Page.bringToFront');

  // 截图尺寸与实际视口的换算
  const m = await send('Page.getLayoutMetrics');
  const vw = m.cssLayoutViewport.clientWidth;
  const vh = m.cssLayoutViewport.clientHeight;
  const shot0 = await send('Page.captureScreenshot', { format: 'png' });
  const img = Buffer.from(shot0.data, 'base64');
  // 从 PNG 头读尺寸
  const pngW = img.readUInt32BE(16), pngH = img.readUInt32BE(20);
  console.log('viewport', vw, vh, '| png', pngW, pngH);

  if (CLICK_X && CLICK_Y) {
    const x = CLICK_X * vw / pngW;
    const y = CLICK_Y * vh / pngH;
    console.log('点击视口坐标', Math.round(x), Math.round(y));
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
    await new Promise(r => setTimeout(r, 4000));
  }

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, OUT), Buffer.from(shot.data, 'base64'));
  console.log('截图:', OUT);
  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
