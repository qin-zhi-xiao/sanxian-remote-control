const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9222;
const ROUTE = process.argv[2] || '';
const OUT = process.argv[3] || 'runtime.png';

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
  const rt = list.find(x => x.type === 'iframe' && x.url.indexOf('webide-runtime') >= 0);
  if (!rt) { console.log('没有模拟器 iframe'); return; }
  console.log('模拟器 URL:', rt.url.slice(0, 90));

  const ws = new WebSocket(rt.webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) return 'EXC ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '').slice(0, 160);
    return r && r.result ? r.result.value : null;
  };

  console.log('页面文本:', (await ev('(document.body.innerText||"").slice(0,150)')));

  if (ROUTE) {
    // 小程序的页面栈在 __wxConfig 或 wx 对象里
    console.log('=== 尝试跳转 ===');
    console.log(await ev(`(()=>{
      const out=[];
      try{ if(window.wx && wx.navigateTo){ wx.navigateTo({url:'/${ROUTE}'}); out.push('wx.navigateTo ok'); } }catch(e){ out.push('wx err:'+e.message); }
      try{ const r=getCurrentPages(); if(r&&r.length){ r[0].setData && r[0].setData({}); out.push('pages:'+r.length); } }catch(e){ out.push('pages err:'+e.message); }
      return JSON.stringify(out);
    })()`));
    await new Promise(r => setTimeout(r, 4000));
  }

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot && shot.data) {
    fs.writeFileSync(path.join(__dirname, OUT), Buffer.from(shot.data, 'base64'));
    console.log('截图:', OUT);
  }
  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
