const http = require('http');

const PORT = 9222;

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
  const pg = list.find(x => x.type === 'page' && x.url.indexOf('github.com/new') >= 0);
  const ws = new WebSocket(pg.webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) return 'EXC ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '').slice(0, 200);
    return r && r.result ? r.result.value : null;
  };

  // React 受控组件：必须触发 input 事件
  const setValue = (name, val) => ev(`(()=>{
    const el = document.getElementById(${JSON.stringify(name)}) || document.querySelector('[name="${name}"]');
    if(!el) return 'no el';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(val)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);

  console.log('仓库名:', await setValue('repository-name-input', 'sanxian-remote-control'));
  await new Promise(r => setTimeout(r, 800));
  console.log('描述:', await setValue('Description', 'Sanxian Remote Control — 三人组的手机远程控制电脑终端工具'));
  await new Promise(r => setTimeout(r, 1200));

  console.log('当前仓库名值:', await ev("(document.getElementById('repository-name-input')||{}).value"));

  // 找到创建按钮
  console.log('=== 按钮 ===');
  console.log(await ev(`JSON.stringify([...document.querySelectorAll('button')].map(b=>(b.innerText||'').trim()).filter(t=>t), null, 1)`));

  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
