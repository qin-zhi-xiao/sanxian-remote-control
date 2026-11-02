const http = require('http');
const fs = require('fs');
const path = require('path');

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
  const page = list.find(x => x.type === 'page' && x.url.indexOf('edu.weixin.qq.com') >= 0);
  if (!page) { console.log('no editor page'); return; }

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
    if (r && r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description);
    return r && r.result ? r.result.value : null;
  };

  console.log('当前打开的文件:', await ev("(()=>{const e=[...document.querySelectorAll('div,span')].find(x=>/^页面路径：/.test((x.innerText||'').trim()));return e?e.innerText.trim():'(无)'})()"));

  // 尝试拿 Monaco 编辑器内容
  const content = await ev(`(()=>{
    if (window.monaco && monaco.editor) {
      const ms = monaco.editor.getModels();
      if (ms.length) return ms[0].getValue();
    }
    return null;
  })()`);
  console.log('=== 编辑器内容 ===');
  console.log(content === null ? '(拿不到 monaco)' : content.slice(0, 600));

  const err = await ev(`(()=>{const els=[...document.querySelectorAll('div')].filter(d=>/加载失败|错误|error/i.test(d.innerText||'') && (d.innerText||'').length<200);return els.map(e=>e.innerText.trim()).slice(0,3).join(' | ')})()`);
  console.log('=== 错误提示 ===');
  console.log(err || '(无)');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot && shot.data) {
    const out = path.join(__dirname, 'editor-now.png');
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('截图:', out);
  }
  ws.close();
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
