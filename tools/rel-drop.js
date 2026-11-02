const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9222;
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
  const pg = list.find(x => x.type === 'page' && x.url.indexOf('releases/new') >= 0);
  const ws = new WebSocket(pg.webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r && r.exceptionDetails) return 'EXC ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '').slice(0, 200);
    return r && r.result ? r.result.value : null;
  };

  // 刷新页面，清掉之前的错误状态
  await send('Page.navigate', { url: 'https://github.com/qin-zhi-xiao/sanxian-remote-control/releases/new' });
  await new Promise(r => setTimeout(r, 9000));

  // 重新填表
  await ev(`(()=>{
    const tag = document.getElementById('release_tag_name');
    tag.value='v1.3.0';
    tag.dispatchEvent(new Event('input',{bubbles:true}));
    tag.dispatchEvent(new Event('change',{bubbles:true}));
    const t = document.querySelector('[name="release[name]"]');
    const s1 = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    s1.call(t,'v1.3.0'); t.dispatchEvent(new Event('input',{bubbles:true}));
    return 'ok';
  })()`);
  await new Promise(r => setTimeout(r, 1500));

  // 找上传区的坐标
  const box = await ev(`(()=>{
    const el=[...document.querySelectorAll('div,label')].find(e=>(e.innerText||'').trim().indexOf('Paste, drop, or click')>=0);
    if(!el) return null;
    const r=el.getBoundingClientRect();
    return JSON.stringify({x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2), w:Math.round(r.width), h:Math.round(r.height)});
  })()`);
  console.log('拖放区:', box);
  if (!box) { console.log('找不到上传区'); ws.close(); process.exit(1); }
  const b = JSON.parse(box);

  // 用 Input.dispatchDragEvent 模拟拖入
  const data = {
    items: [],
    files: [FILE],
    dragOperationsMask: 1
  };
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    try {
      await send('Input.dispatchDragEvent', { type, x: b.x, y: b.y, data });
      console.log(type, 'ok');
      await new Promise(r => setTimeout(r, 500));
    } catch (e) { console.log(type, 'fail:', e.message); }
  }

  await new Promise(r => setTimeout(r, 12000));
  console.log('=== 状态 ===');
  const txt = await ev('(document.body.innerText||"")');
  const hit = txt.split('\n').filter(l => /kuaichuan|wrong|attach|upload/i.test(l));
  console.log(hit.join('\n'));

  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
