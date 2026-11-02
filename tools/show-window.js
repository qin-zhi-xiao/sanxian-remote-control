const http = require('http');

const PORT = parseInt(process.argv[2] || '9222', 10);
const URL_KEY = process.argv[3] || 'tcb.cloud';

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
  const pages = list.filter(x => x.type === 'page');
  const target = pages.find(p => p.url.indexOf(URL_KEY) >= 0) || pages[0];
  if (!target) { console.log('no page'); return; }
  console.log('目标:', target.title);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

  // 把窗口拉回主屏幕并还原
  const win = await send('Browser.getWindowForTarget', { targetId: target.id });
  if (win && win.windowId) {
    console.log('windowId:', win.windowId, 'bounds:', JSON.stringify(win.bounds));
    await send('Browser.setWindowBounds', {
      windowId: win.windowId,
      bounds: { left: 80, top: 60, width: 1280, height: 860, windowState: 'normal' }
    });
    console.log('已移到屏幕内');
  }

  await send('Page.bringToFront');
  console.log('已置前');
  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
