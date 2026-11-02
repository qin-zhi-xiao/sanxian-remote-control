const http = require('http');

const PORT = parseInt(process.argv[2] || '9222', 10);
const TARGET_URL = process.argv[3] || '';

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
  let list = await getJson('/json/list');
  const blank = list.find(x => x.type === 'page' && x.url === 'about:blank');
  if (!blank) { console.log('没有空白页'); return; }

  const ws = new WebSocket(blank.webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

  if (TARGET_URL) {
    await send('Page.navigate', { url: TARGET_URL });
    console.log('已导航到:', TARGET_URL);
  }
  await new Promise(r => setTimeout(r, 8000));

  const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r && r.result ? r.result.value : null; };
  console.log('当前 URL:', await ev('location.href'));
  console.log('标题:', await ev('document.title'));
  console.log('正文前 200:', (await ev('(document.body.innerText||"").slice(0,200)')));
  ws.close();
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
