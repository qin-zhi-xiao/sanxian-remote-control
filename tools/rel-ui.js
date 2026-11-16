const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9222;
const TAG = 'v1.4.0';
const BODY = fs.readFileSync(path.join(__dirname, 'rel-body.txt'), 'utf8');

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
  const pg = list.find(x => x.type === 'page' && x.url.indexOf('releases/new') >= 0);
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

  await send('Page.bringToFront');
  await new Promise(r => setTimeout(r, 2000));

  // 1) tag 输入（自定义标签）
  console.log('tag:', await ev(`(()=>{
    const el = document.getElementById('release_tag_name');
    if(!el) return 'no el';
    el.value = ${JSON.stringify(TAG)};
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return el.value;
  })()`));

  await new Promise(r => setTimeout(r, 1200));

  // 2) 标题
  console.log('标题:', await ev(`(()=>{
    const el = document.querySelector('[name="release[name]"]');
    if(!el) return 'no el';
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    s.call(el, ${JSON.stringify(TAG)});
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return el.value;
  })()`));

  await new Promise(r => setTimeout(r, 600));

  // 3) 正文
  console.log('正文:', await ev(`(()=>{
    const el = document.getElementById('release_body');
    if(!el) return 'no el';
    const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
    s.call(el, ${JSON.stringify(BODY)});
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return (el.value||'').length + ' 字符';
  })()`));

  await new Promise(r => setTimeout(r, 1500));

  // 4) 点发布
  console.log('发布:', await ev(`(()=>{
    const b = [...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='Publish release');
    if(!b) return 'not found';
    b.click();
    return 'clicked';
  })()`));

  await new Promise(r => setTimeout(r, 12000));
  console.log('URL:', await ev('location.href'));

  const s = await send('Page.captureScreenshot', { format: 'png' });
  if (s && s.data) { fs.writeFileSync(path.join(__dirname, 'rel-done.png'), Buffer.from(s.data, 'base64')); console.log('截图: rel-done.png'); }
  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
