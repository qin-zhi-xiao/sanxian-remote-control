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
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r && r.result ? r.result.value : null;
  };

  // 找模拟器里的 iframe / 页面容器，直接把路径切到 agent
  const info = await ev(`(()=>{
    const ifr = [...document.querySelectorAll('iframe')].map(f=>({src:f.src,id:f.id}));
    return JSON.stringify({iframes: ifr.length, first: ifr.slice(0,3)});
  })()`);
  console.log('iframes:', info);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot && shot.data) {
    fs.writeFileSync(path.join(__dirname, 'agent-page.png'), Buffer.from(shot.data, 'base64'));
    console.log('截图: agent-page.png');
  }
  ws.close();
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
