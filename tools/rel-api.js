const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9222;
const OWNER = 'qin-zhi-xiao';
const REPO = 'sanxian-remote-control';
const TAG = 'v1.3.0';
const FILE = process.argv[2];

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
  const pg = list.find(x => x.type === 'page' && x.url.indexOf('github.com') >= 0);
  const ws = new WebSocket(pg.webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r && r.exceptionDetails) return 'EXC ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '').slice(0, 300);
    return r && r.result ? r.result.value : null;
  };

  // 1. 找页面里的 authenticity_token 和 release 表单的 id
  await send('Page.navigate', { url: `https://github.com/${OWNER}/${REPO}/releases/new` });
  await new Promise(r => setTimeout(r, 9000));

  console.log('=== token ===');
  const token = await ev(`(document.querySelector('input[name="authenticity_token"]')||{}).value || ''`);
  console.log('长度:', token ? token.length : 0);

  console.log('=== 可用的 release 相关 form ===');
  console.log(await ev(`JSON.stringify([...document.querySelectorAll('form')].map(f=>({action:f.action, method:f.method})).filter(x=>x.action.indexOf('release')>=0), null, 1)`));

  // 2. 用页面上下文 fetch 创建 release（不带附件）
  const body = JSON.stringify({
    tag_name: TAG,
    target_commitish: 'main',
    name: TAG,
    body: '## 快传 v1.3.0\n\n在手机上远程控制电脑终端与智能体。三人小组作品（福禄寿三仙）。\n\n下载下方的 zip，解压后运行 kuaichuan.exe。',
    draft: false,
    prerelease: false
  });

  console.log('=== 创建 release ===');
  console.log(await ev(`(async()=>{
    try {
      const r = await fetch('/${OWNER}/${REPO}/releases', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'X-CSRF-Token': ${JSON.stringify(token)},
        },
        body: ${JSON.stringify(body)},
        credentials: 'same-origin'
      });
      const t = await r.text();
      return r.status + ' | ' + t.slice(0, 300);
    } catch(e) { return 'ERR ' + e.message; }
  })()`));

  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
