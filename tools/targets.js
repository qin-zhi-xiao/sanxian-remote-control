#!/usr/bin/env node
// 列出所有 CDP target（含 OOPIF），并可对指定 target 求值
// 用法: node targets.js list
//       node targets.js eval <urlPart> <expr-file>
const fs = require('fs');
const http = require('http');

const HOST = '127.0.0.1', PORT = 9222;
const get = p => new Promise((res, rej) => {
  http.get({ host: HOST, port: PORT, path: p }, r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch { res(b); } });
  }).on('error', rej);
});

(async () => {
  const ver = await get('/json/version');
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('timeout ' + method)); } }, 20000);
  });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  };
  await new Promise(r => { ws.onopen = r; });

  const { targetInfos } = await send('Target.getTargets');
  const [cmd, urlPart, file] = process.argv.slice(2);

  if (cmd === 'list') {
    for (const t of targetInfos) {
      console.log([t.type, t.targetId.slice(0, 8), (t.url || '').slice(0, 70)].join(' | '));
    }
    process.exit(0);
  }

  const hit = targetInfos.find(t => (t.url || '').includes(urlPart) && t.type === 'iframe')
    || targetInfos.find(t => (t.url || '').includes(urlPart));
  if (!hit) { console.log('no target for ' + urlPart); process.exit(1); }

  const { sessionId } = await send('Target.attachToTarget', { targetId: hit.targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  const expr = fs.readFileSync(file, 'utf8');
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }, sessionId);
  console.log(JSON.stringify(r.result ? r.result.value : r, null, 2));
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
