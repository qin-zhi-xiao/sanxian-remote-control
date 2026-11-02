const http = require('http');

const PORT = parseInt(process.argv[2] || '9222', 10);
const URL_TO_OPEN = process.argv[3];

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
  const page = list.find(x => x.type === 'page' && x.url.indexOf('edu.weixin') >= 0) || list.find(x => x.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));
  let id = 0; const pending = new Map();
  const created = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    else if (m.method === 'Target.targetCreated') created.push(m.params.targetInfo);
  };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }); return r && r.result ? r.result.value : null; };

  await send('Target.setDiscoverTargets', { discover: true });
  console.log('打开:', URL_TO_OPEN);
  await ev(`window.open(${JSON.stringify(URL_TO_OPEN)}, '_blank')`);
  await new Promise(r => setTimeout(r, 9000));

  const after = await getJson('/json/list');
  const pages = after.filter(x => x.type === 'page');
  console.log('=== 页面 ===');
  pages.forEach((p, i) => console.log(i, '|', p.title, '\n   ', p.url.slice(0, 130)));

  const tcb = pages.find(p => p.url.indexOf('tcb.cloud') >= 0);
  if (tcb) {
    console.log('=== 云控制台状态 ===');
    const ws2 = new WebSocket(tcb.webSocketDebuggerUrl);
    await new Promise(r => (ws2.onopen = r));
    let i2 = 0; const p2 = new Map();
    ws2.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m.result); p2.delete(m.id); } };
    const send2 = (method, params = {}) => new Promise(r => { const j = ++i2; p2.set(j, r); ws2.send(JSON.stringify({ id: j, method, params })); });
    const ev2 = async expr => { const r = await send2('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r && r.result ? r.result.value : null; };
    console.log('URL:', await ev2('location.href'));
    console.log('正文前 300:', (await ev2('(document.body.innerText||"").slice(0,300)')));
    ws2.close();
  }
  ws.close();
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
