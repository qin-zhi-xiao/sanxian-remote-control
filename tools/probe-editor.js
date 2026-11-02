const http = require('http');

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
  const page = list.find(x => x.type === 'page');
  if (!page) { console.log('no page'); return; }
  console.log('URL:', page.url);

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

  console.log('readyState:', await ev('document.readyState'));
  console.log('tree 节点数:', await ev('document.querySelectorAll("[class*=tree]").length'));
  console.log('可见文本前 300 字:');
  console.log(await ev('(document.body.innerText||"").slice(0,300)'));
  ws.close();
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
