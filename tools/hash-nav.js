const http = require('http');

const PORT = 9222;
const HASH = process.argv[2] || '/hosting';

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
  // 找已经在 dev 里的页面（有登录态）
  const dev = list.find(x => x.type === 'page' && x.url.indexOf('tcb.cloud.tencent.com/dev') >= 0);
  if (!dev) { console.log('没有已登录的 CloudBase 页面'); return; }
  console.log('复用页面:', dev.url.slice(0, 80));

  const ws = new WebSocket(dev.webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) return 'EXC';
    return r && r.result ? r.result.value : null;
  };

  await send('Page.bringToFront');
  // 只改 hash，不重新加载整页，保留登录态
  console.log('改 hash →', HASH);
  await ev(`location.hash = ${JSON.stringify(HASH)}`);
  await new Promise(r => setTimeout(r, 8000));

  console.log('当前 URL:', await ev('location.href'));
  console.log('正文前 400:', (await ev('(document.body.innerText||"").slice(0,400)')));

  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
