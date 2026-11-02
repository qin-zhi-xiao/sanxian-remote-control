const http = require('http');
const fs = require('fs');
const path = require('path');

function getJson(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: 9222, path: p }, r => {
      let b = '';
      r.on('data', c => (b += c));
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

(async () => {
  const list = await getJson('/json/list');
  const page = list.find(x => x.type === 'page' && x.url.indexOf('edu.weixin.qq.com') >= 0);
  if (!page) { console.log('no editor page'); return; }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise(r => {
    const i = ++id; pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

  // 模拟器区域：截图中约 x 65..415, y 105..835（2574x1462 的图里）
  // 换算到视口坐标
  const clickAt = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
  };

  // 终端卡片中心：图里约 (238, 465) → 视口比例 2574:1694 = 1.52
  // 实际视口宽度需取
  const vw = await send('Runtime.evaluate', { expression: 'window.innerWidth', returnByValue: true });
  const vh = await send('Runtime.evaluate', { expression: 'window.innerHeight', returnByValue: true });
  const w = vw.result.value, h = vh.result.value;
  console.log('viewport', w, h);

  // 按截图比例换算：截图 2574 宽 → 视口 w
  const sx = w / 2574, sy = h / 1462;
  const px = 238 * sx, py = 465 * sy;
  console.log('click at', Math.round(px), Math.round(py));
  await clickAt(px, py);
  await new Promise(r => setTimeout(r, 4000));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot && shot.data) {
    const out = path.join(__dirname, 'after-click.png');
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('截图:', out);
  }
  ws.close();
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
