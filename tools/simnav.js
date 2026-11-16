const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9222;
const OUT = process.argv[2] || 'sim-nav.png';
const ROUTE = process.argv[3] || '';

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
  // 模拟器是 iframe target
  const rt = list.find(x => x.type === 'iframe' && x.url.indexOf('webide-runtime') >= 0);
  if (!rt) { console.log('没有模拟器 iframe'); process.exit(1); }
  console.log('模拟器:', rt.url.slice(0, 70));

  const ws = new WebSocket(rt.webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r && r.exceptionDetails) return 'EXC ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '').slice(0, 250);
    return r && r.result ? r.result.value : null;
  };

  console.log('=== 全局对象 ===');
  console.log(await ev("JSON.stringify({wx: typeof wx, pages: typeof getCurrentPages, cfg: typeof __wxConfig})"));

  if (ROUTE) {
    console.log('=== 尝试 navigateTo ===');
    console.log(await ev(`(function(){
      try {
        if (typeof wx !== 'undefined' && wx.navigateTo) {
          wx.navigateTo({url: ${JSON.stringify(ROUTE)}, fail: function(e){ console.log('nav fail', e); }});
          return 'navigateTo called';
        }
        return 'no wx.navigateTo';
      } catch (e) { return 'ERR ' + e.message; }
    })()`));
    await new Promise(r => setTimeout(r, 4000));
    console.log('=== 页面栈 ===');
    console.log(await ev("(function(){ try { var p = getCurrentPages(); return p.map(function(x){return x.route}).join(' > '); } catch(e){ return 'err'; } })()"));
  }

  const s = await send('Page.captureScreenshot', { format: 'png' });
  if (s && s.data) { fs.writeFileSync(path.join(__dirname, OUT), Buffer.from(s.data, 'base64')); console.log('截图:', OUT); }
  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
