const http = require('http');

const PORT = 9222;
const OWNER = 'qin-zhi-xiao';
const REPO = 'sanxian-remote-control';
const TAG = 'v1.3.0';

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

  await send('Page.navigate', { url: `https://github.com/${OWNER}/${REPO}/releases/new` });
  await new Promise(r => setTimeout(r, 9000));

  const token = await ev(`(document.querySelector('input[name="authenticity_token"]')||{}).value || ''`);

  console.log('=== 用 FormData 提交 ===');
  console.log(await ev(`(async()=>{
    try {
      const fd = new FormData();
      fd.append('authenticity_token', ${JSON.stringify(token)});
      fd.append('release[tag_name]', ${JSON.stringify(TAG)});
      fd.append('release[target_commitish]', 'main');
      fd.append('release[name]', ${JSON.stringify(TAG)});
      fd.append('release[body]', '## 快传 v1.3.0\\n\\n在手机上远程控制电脑终端与智能体。三人小组作品（福禄寿三仙）。\\n\\n**下载**：点下方 zip，解压运行 kuaichuan.exe。');
      fd.append('release[draft]', 'false');
      fd.append('release[prerelease]', 'false');

      const r = await fetch('/${OWNER}/${REPO}/releases', {
        method: 'POST',
        headers: { 'Accept': 'text/html,application/xhtml+xml' },
        body: fd,
        credentials: 'same-origin',
        redirect: 'follow'
      });
      return 'HTTP ' + r.status + ' → ' + r.url;
    } catch(e) { return 'ERR ' + e.message; }
  })()`));

  await new Promise(r => setTimeout(r, 3000));
  console.log('当前 URL:', await ev('location.href'));

  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
