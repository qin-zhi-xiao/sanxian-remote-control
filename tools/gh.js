const http = require('http');

const PORT = 9222;
const MATCH = process.argv[2] || 'github.com';
const EXPR = process.argv[3] || '';

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
  if (!pg) { console.log('no page'); return; }

  const ws = new WebSocket(pg.webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) return 'EXC ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '').slice(0, 150);
    return r && r.result ? r.result.value : null;
  };

  console.log('URL:', await ev('location.href'));
  if (EXPR) {
    console.log('结果:', await ev(EXPR));
  } else {
    console.log('用户名:', await ev("(document.querySelector('meta[name=\"user-login\"]')||{}).content || 'N/A'"));
    console.log('正文前 200:', (await ev('(document.body.innerText||"").slice(0,200)')));
  }
  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
