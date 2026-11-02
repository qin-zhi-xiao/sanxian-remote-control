(async () => {
  const http = require('http');
  const get = p => new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: 9222, path: p }, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch { res(b); } });
    }).on('error', rej);
  });
  const ver = await get('/json/version');
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (m, p = {}) => new Promise((resolve, reject) => {
    const i = ++id; pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method: m, params: p }));
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error('timeout')); } }, 10000);
  });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } };
  await new Promise(r => { ws.onopen = r; });
  const { targetInfos } = await send('Target.getTargets');
  const t = targetInfos.find(x => (x.url || '').includes('tcb.cloud.tencent.com'));
  if (!t) return console.log('no tcb target');
  await send('Target.activateTarget', { targetId: t.targetId });
  console.log('activated: ' + t.url.slice(0, 80));
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
