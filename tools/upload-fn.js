#!/usr/bin/env node
// 用 CDP 给云函数「上传代码」的文件输入框塞 zip，然后点部署
const http = require('http');
const path = require('path');

const ZIP = process.argv[2];
if (!ZIP) { console.error('用法: node upload-fn.js <zip绝对路径>'); process.exit(1); }

const get = p => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: 9222, path: p }, r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch { res(b); } });
  }).on('error', rej);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const list = await get('/json/list');
  const page = list.find(t => t.type === 'page' && (t.url || '').includes('tcb.cloud.tencent.com'));
  if (!page) throw new Error('找不到控制台标签页');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (m, p = {}) => new Promise((resolve, reject) => {
    const i = ++id; pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method: m, params: p }));
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error('timeout ' + m)); } }, 20000);
  });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  };
  await new Promise(r => { ws.onopen = r; });
  const js = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'js error');
    return r.result.value;
  };

  await send('DOM.enable');
  await send('Runtime.enable');

  // 1) 点「上传代码」切换出上传区
  await js(`(() => {
    const el = [...document.querySelectorAll('div,span,button,a')].find(e => (e.innerText||'').trim() === '上传代码' && e.getBoundingClientRect().width > 0);
    if (el) { el.click(); return 'clicked-upload'; }
    return 'no-upload-entry';
  })()`);
  await sleep(1500);

  // 2) 找 file input
  const { root } = await send('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  console.log('file input nodeId =', nodeId);
  if (!nodeId) { console.log('没找到 file input'); process.exit(2); }

  await send('DOM.setFileInputFiles', { files: [path.resolve(ZIP)], nodeId });
  console.log('已塞入文件:', path.resolve(ZIP));
  await sleep(4000);

  // 3) 点部署
  const d = await js(`(() => {
    const b = [...document.querySelectorAll('button,div,span')].filter(e => (e.innerText||'').trim() === '部署' && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().width < 160);
    if (!b.length) return 'no-deploy-btn';
    b[b.length-1].click();
    return 'deploy-clicked';
  })()`);
  console.log(d);
  await sleep(2500);

  // 4) 确认部署
  const c = await js(`(() => {
    const b = [...document.querySelectorAll('button,div,span')].filter(e => (e.innerText||'').trim() === '确认部署' && e.getBoundingClientRect().width > 0);
    if (!b.length) return 'no-confirm';
    b[b.length-1].click();
    return 'confirmed';
  })()`);
  console.log(c);
  await sleep(8000);

  const state = await js(`(() => { const t = document.body.innerText; return t.slice(-160); })()`);
  console.log('页面尾部:', state.replace(/\n/g, ' | '));
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
