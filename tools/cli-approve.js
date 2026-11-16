const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9222;
const MATCH = process.argv[2] || 'cli-auth';
const CODE = process.argv[3] || '';
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

  // 填用户码
  console.log('填码:', await ev(`(function(){
    var els = document.querySelectorAll('input');
    var el = null;
    for (var i = 0; i < els.length; i++) {
      var ph = els[i].placeholder || '';
      if (ph.indexOf('用户码') >= 0 || ph.indexOf('码') >= 0) { el = els[i]; break; }
    }
    if (!el && els.length) el = els[0];
    if (!el) return 'no input';
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(CODE)});
    el.dispatchEvent(new Event('input', {bubbles: true}));
    el.dispatchEvent(new Event('change', {bubbles: true}));
    return el.value + ' | ph=' + (el.placeholder || '');
  })()`));

  await new Promise(r => setTimeout(r, 1200));

  // 点确认授权
  console.log('点确认:', await ev(`(function(){
    var all = document.querySelectorAll('button,div[class*=btn],span');
    for (var i = 0; i < all.length; i++) {
      var t = (all[i].textContent || '').trim();
      if (t === '确认授权' || t === '确认' || t === '授权') {
        all[i].click();
        return 'clicked: ' + t;
      }
    }
    return 'not found';
  })()`));

  await new Promise(r => setTimeout(r, 6000));
  console.log('页面:', (await ev("(document.body.innerText||'').slice(0,300)")));

  if (OUT) {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    if (s && s.data) { fs.writeFileSync(path.join(__dirname, OUT), Buffer.from(s.data, 'base64')); console.log('截图:', OUT); }
  }
  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
