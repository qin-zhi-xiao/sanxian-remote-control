const http = require('http');

const PORT = 9222;
const OWNER = 'qin-zhi-xiao';
const REPO = 'sanxian-remote-control';
const TAG = 'v1.3.0';

const BODY = `## 快传 v1.3.0

在手机上远程控制电脑终端与智能体。三人小组作品（福禄寿三仙）。

### ⬇️ 下载

**[kuaichuan.exe（365 KB，单文件免安装）](https://raw.githubusercontent.com/qin-zhi-xiao/sanxian-remote-control/main/releases/kuaichuan.exe)**

**[打包版 zip（含启动脚本）](https://raw.githubusercontent.com/qin-zhi-xiao/sanxian-remote-control/main/releases/kuaichuan-v1.3.0-win64.zip)**

### 首次使用

1. 电脑上运行 \`kuaichuan.exe --gw <网关地址> --code 886613\`
2. 微信打开小程序，填入配对码 \`886613\`
3. 点「测试连接」，通过后即可使用

### 功能

- **终端**：ConPTY 伪终端，Git Bash / CMD / PowerShell 可切换，支持 TUI 程序（如 Claude Code）
- **智能体**：接入 Claude Code、Codex、DSH、Hermes，DSH 支持 headless 直连对话
- **云中转**：不需要公网 IP、不需要端口映射，数据走你自己的云环境

### 已知限制

- 终端输出有 1~2 秒延迟（云开发轮询通道决定）
- 教育体验版云环境不支持静态托管，故用 GitHub 分发`;

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

  await send('Page.navigate', { url: `https://github.com/${OWNER}/${REPO}/releases/edit/${TAG}` });
  await new Promise(r => setTimeout(r, 9000));

  const token = await ev(`(document.querySelector('input[name="authenticity_token"]')||{}).value || ''`);
  console.log('token:', token ? token.length : 0);

  const res = await ev(`(async()=>{
    try {
      const fd = new FormData();
      fd.append('authenticity_token', ${JSON.stringify(token)});
      fd.append('release[tag_name]', ${JSON.stringify(TAG)});
      fd.append('release[name]', ${JSON.stringify(TAG)});
      fd.append('release[body]', ${JSON.stringify(BODY)});
      fd.append('release[draft]', 'false');
      fd.append('release[prerelease]', 'false');

      const r = await fetch('/${OWNER}/${REPO}/releases/${TAG}', {
        method: 'POST',
        headers: { 'Accept': 'text/html' },
        body: fd, credentials: 'same-origin', redirect: 'follow'
      });
      return 'HTTP ' + r.status + ' → ' + r.url;
    } catch(e) { return 'ERR ' + e.message; }
  })()`);
  console.log('=== 更新结果 ===');
  console.log(res);

  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
