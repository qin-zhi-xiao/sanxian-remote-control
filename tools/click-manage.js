const http = require('http');

const PORT = parseInt(process.argv[2] || '9222', 10);

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
  const page = list.find(x => x.type === 'page');
  const before = list.filter(x => x.type === 'page').length;
  console.log('点击前页面数:', before);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));
  let id = 0; const pending = new Map();
  const events = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    else if (m.method && (m.method.indexOf('Page.') === 0 || m.method.indexOf('Target.') === 0)) events.push(m.method);
  };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r && r.exceptionDetails) return 'EXC';
    return r && r.result ? r.result.value : null;
  };

  await send('Target.setDiscoverTargets', { discover: true });
  await send('Page.enable');

  console.log('点击结果:', await ev(`(()=>{const b=document.querySelector('.cloud-env-manage-button'); if(!b) return 'no button'; b.click(); return 'clicked';})()`));
  await new Promise(r => setTimeout(r, 8000));

  console.log('事件:', events.slice(-8).join(', '));
  ws.close();

  const after = await getJson('/json/list');
  const pages = after.filter(x => x.type === 'page');
  console.log('点击后页面数:', pages.length);
  pages.forEach((p, i) => console.log(i, p.title, '\n   ', p.url.slice(0, 150)));
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
