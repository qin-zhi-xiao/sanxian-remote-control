const http = require('http');

const PORT = 9222;
const OWNER = 'qin-zhi-xiao';
const REPO = 'sanxian-remote-control';
const TAG = 'v1.4.0';

const BODY = `## 快传 v1.4.0

### ⬇️ 下载

**[kuaichuan-v1.4.0.exe](https://raw.githubusercontent.com/qin-zhi-xiao/sanxian-remote-control/main/releases/kuaichuan-v1.4.0.exe)** — 单文件，367 KB，免安装

**[kuaichuan-v1.4.0-win64.zip](https://raw.githubusercontent.com/qin-zhi-xiao/sanxian-remote-control/main/releases/kuaichuan-v1.4.0-win64.zip)** — 打包版

### 本版新增

**局域网 / 云端自动分流**

- 每次发消息前先探测电脑端 exe 是否可达
- 同 WiFi → 走本地直连，快且不消耗云端额度
- 出门在外 → 自动回退云函数中转
- 聊天页顶栏实时显示当前走哪条路

**启动提速（重要修复）**

Hermes 的 \`--version\` 要跑 74 秒，之前会拖住整个启动。现在：

- 单条探测上限 6 秒
- 整轮探测 7 秒截止，超时先返回已拿到的
- 启动从 20 秒以上降到 **3 秒左右**

**其他**

- exe 新增 \`POST /agent\` 接口，局域网内可直连调用
- 支持 DSH / Codex / Hermes 三种 headless 模式的参数自动适配
- 修复探测超时后未回收子进程的问题

### 首次使用

\`\`\`
kuaichuan.exe --gw "https://eval-lifecycle-d7gf433u22f6c2405.api.tcloudbasegateway.com/v1/functions/kuaichuan-relay" --code 886613
\`\`\`

局域网模式：

\`\`\`
kuaichuan.exe --lan --port 8765 --token <自定令牌>
\`\`\`

然后在小程序首页填地址和令牌，点「探测局域网」。

### 已知限制

- 云端轮询有 1~2 秒延迟（云开发通道决定）
- 局域网直连需要手机与电脑同一 WiFi`;

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
  await new Promise(r => setTimeout(r, 10000));

  const token = await ev(`(document.querySelector('input[name="authenticity_token"]')||{}).value || ''`);
  console.log('token:', token ? token.length : 0);

  const res = await ev(`(async()=>{
    try {
      const fd = new FormData();
      fd.append('authenticity_token', ${JSON.stringify(token)});
      fd.append('release[tag_name]', ${JSON.stringify(TAG)});
      fd.append('release[target_commitish]', 'main');
      fd.append('release[name]', ${JSON.stringify(TAG)});
      fd.append('release[body]', ${JSON.stringify(BODY)});
      fd.append('release[draft]', 'false');
      fd.append('release[prerelease]', 'false');

      const r = await fetch('/${OWNER}/${REPO}/releases', {
        method: 'POST',
        headers: { 'Accept': 'text/html,application/xhtml+xml' },
        body: fd, credentials: 'same-origin', redirect: 'follow'
      });
      return 'HTTP ' + r.status + ' → ' + r.url;
    } catch(e) { return 'ERR ' + e.message; }
  })()`);

  console.log('=== 创建结果 ===');
  console.log(res);
  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
