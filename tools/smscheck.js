const http = require('http');
const PORT = 9222;
const MATCH = process.argv[2] || 'smsv2';

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
  if (!pg) { console.log('no page'); process.exit(1); }
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

  // 找出所有 checkbox 和含"我已阅读"的可点元素
  console.log('=== checkbox 候选 ===');
  console.log(await ev(`(function(){
    var out = [];
    var els = document.querySelectorAll('input[type=checkbox], .tea-checkbox, [class*=checkbox]');
    for (var i = 0; i < els.length && out.length < 6; i++) {
      var e = els[i]; var b = e.getBoundingClientRect();
      if (b.width === 0) continue;
      out.push({tag:e.tagName, cls:String(e.className||'').slice(0,50), x:Math.round(b.left+b.width/2), y:Math.round(b.top+b.height/2), checked:e.checked});
    }
    return JSON.stringify(out);
  })()`));

  // 点第一个 checkbox
  console.log('点勾选:', await ev(`(function(){
    var els = document.querySelectorAll('input[type=checkbox], .tea-checkbox');
    for (var i = 0; i < els.length; i++) {
      var b = els[i].getBoundingClientRect();
      if (b.width > 0 && b.top > 400) { els[i].click(); return 'clicked at y=' + Math.round(b.top); }
    }
    return 'none';
  })()`));

  await new Promise(r => setTimeout(r, 2000));

  console.log('=== 开始接入按钮状态 ===');
  console.log(await ev(`(function(){
    var bs = document.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) {
      var t = (bs[i].innerText||'').trim();
      if (t.indexOf('开始接入') >= 0) return t + ' disabled=' + bs[i].disabled + ' cls=' + String(bs[i].className).slice(0,40);
    }
    return 'not found';
  })()`));

  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
