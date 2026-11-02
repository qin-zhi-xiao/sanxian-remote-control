#!/usr/bin/env node
// 只保留 edu.weixin.qq.com / tcb.cloud.tencent.com 的页面，其余全部关闭
// 用法: node close-tabs.js [--dry]
const http = require('http');
const HOST = '127.0.0.1', PORT = 9222;
const get = p => new Promise((res, rej) => {
  http.get({ host: HOST, port: PORT, path: p }, r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch { res(b); } });
  }).on('error', rej);
});

(async () => {
  const dry = process.argv.includes('--dry');
  const ver = await get('/json/version');
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('timeout')); } }, 15000);
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
  const keep = /edu\.weixin\.qq\.com|tcb\.cloud\.tencent\.com|devtools\./;
  let closed = 0;
  for (const t of targetInfos) {
    if (t.type !== 'page') continue;
    if (keep.test(t.url || '')) { console.log('KEEP  ', (t.url || '').slice(0, 70)); continue; }
    console.log(dry ? 'WOULD CLOSE ' : 'CLOSE ', (t.url || '(empty)').slice(0, 70));
    if (!dry) {
      try { await send('Target.closeTarget', { targetId: t.targetId }); closed++; } catch (e) { console.log('  fail:', e.message); }
    }
  }
  console.log('closed:', closed);
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
