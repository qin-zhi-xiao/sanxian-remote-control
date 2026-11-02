#!/usr/bin/env node
/**
 * 把本地 src/ 写进小程序教育平台 web IDE（CDP 驱动）。
 *   node push.js --only app.json        # 只推某个文件（名字匹配 basename 或完整相对路径）
 *   node push.js                        # 全推
 * 前提：Edge 以 --remote-debugging-port=9222 启动，已登录，停在项目编辑器代码视图。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const HOST = '127.0.0.1', PORT = 9222;
const SRC = path.resolve(__dirname, '..', 'src');
const ARGS = process.argv.slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const get = p => new Promise((res, rej) => {
  http.get({ host: HOST, port: PORT, path: p }, r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch { res(b); } });
  }).on('error', rej);
});

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url); this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('ws error')); });
    this.ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 20000);
    });
  }
  async js(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'js error');
    return r.result.value;
  }
  async click(x, y, button = 'left') {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
  }
  async combo(key, ctrl = true) {
    const vk = key.toUpperCase().charCodeAt(0), mod = ctrl ? 2 : 0;
    const base = { modifiers: mod, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, key, code: 'Key' + key.toUpperCase() };
    await this.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, base));
    await this.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
  }
  insertText(text) { return this.send('Input.insertText', { text }); }
}

const H = `
window.__q = {
  rect(el){ const r = el.getBoundingClientRect(); return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2), w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.y), bottom: Math.round(r.y+r.height) }; },
  matchRow(name){
    const c = document.querySelector('.file-tree-container');
    if (!c) return null;
    const find = () => {
      const cands = [...c.querySelectorAll('div')]
        .filter(e => ((e.innerText || '').trim().split(String.fromCharCode(10))[0] || '').trim() === name);
      if (!cands.length) return null;
      cands.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
      return cands[0];
    };
    let el = find();
    if (el) return el;
    const orig = c.scrollTop;
    const spots = [0, c.scrollHeight * 0.35, c.scrollHeight * 0.7, c.scrollHeight];
    for (const top of spots) {
      c.scrollTop = top;
      el = find();
      if (el) return el;
    }
    c.scrollTop = orig;
    return null;
  },
  treeRow(name){
    const el = this.matchRow(name);
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    return this.rect(el);
  },
  folderState(name){
    const row = this.matchRow(name);
    if (!row) return null;
    row.scrollIntoView({ block: 'center' });
    const arrow = row.querySelector('.arrow-span');
    const ar = arrow ? arrow.getBoundingClientRect() : row.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    return {
      x: Math.round(ar.x + (ar.width || 16) / 2),
      y: Math.round(ar.y + (ar.height || rr.height) / 2),
      rowX: Math.round(rr.x + rr.width / 2),
      rowY: Math.round(rr.y + rr.height / 2),
      open: arrow ? arrow.getAttribute('data-open') === 'true' : false
    };
  },
  treeBottom(){
    const c = document.querySelector('.file-tree-container');
    const cr = c.getBoundingClientRect();
    const rows = [...c.querySelectorAll('div')].map(e => e.getBoundingClientRect()).filter(r => r.height > 0 && r.height < 40);
    const maxBottom = rows.length ? Math.max(...rows.map(r => r.bottom)) : cr.top + 40;
    let y = Math.min(maxBottom + 30, cr.bottom - 30);
    if (y <= maxBottom + 6 && c.scrollHeight > c.clientHeight) {
      c.scrollTop = c.scrollHeight;
      const rows2 = [...c.querySelectorAll('div')].map(e => e.getBoundingClientRect()).filter(r => r.height > 0 && r.height < 40);
      const mb2 = rows2.length ? Math.max(...rows2.map(r => r.bottom)) : cr.top + 40;
      y = Math.min(mb2 + 30, cr.bottom - 30);
    }
    return { x: Math.round(cr.x + 90), y: Math.round(y) };
  },
  menu(t){
    const els = [...document.querySelectorAll('div,li,span')].filter(e => (e.innerText||'').trim() === t);
    const el = els.find(e => { const r = e.getBoundingClientRect(); return r.width > 40 && r.width < 320 && r.height < 60 && r.height > 10; });
    return el ? this.rect(el) : null;
  },
  focusModal(){
    const i = document.querySelector('.common-dialog-container input');
    if (!i) return false;
    i.focus(); i.select(); return true;
  },
  okBtn(){
    const els = [...document.querySelectorAll('.common-dialog-container div,.common-dialog-container button,.common-dialog-container span')]
      .filter(e => (e.innerText || '').trim() === '确定');
    const el = els[els.length - 1];
    return el ? this.rect(el) : null;
  },
  hasDialog(){ return !!document.querySelector('.common-dialog-overlay'); },
  dialogBtn(){
    const box = document.querySelector('.common-dialog-container');
    if (!box) return null;
    const all = [...box.querySelectorAll('div,button,span')].filter(e => ['取消', '确定', '知道了', '好的'].includes((e.innerText || '').trim()));
    if (!all.length) return null;
    const cancel = all.find(e => (e.innerText || '').trim() === '取消');
    const el = cancel || all[all.length - 1];
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), label: (el.innerText || '').trim() };
  },
  editor(){
    const e = document.querySelector('.monaco-editor');
    return e ? this.rect(e) : null;
  },
  lines(){
    const e = document.querySelector('.monaco-editor');
    if (!e) return [];
    return [...e.querySelectorAll('.view-line')].map(l => l.innerText);
  }
};
'ok'
`;

let cdp;
async function q(expr) { return JSON.parse(await cdp.js(`JSON.stringify(__q.${expr})`)); }

async function ensureFolderOpen(name) {
  const jsClick = target => cdp.js(`(()=>{const c=document.querySelector('.file-tree-container'); if(!c) return 'no-tree';
    const rows=[...c.querySelectorAll('div')].filter(e=>((e.innerText||'').trim().split(String.fromCharCode(10))[0]||'').trim()===${JSON.stringify(name)});
    if(!rows.length) return 'no-row';
    rows.sort((a,b)=>(a.innerText||'').length-(b.innerText||'').length);
    const row=rows[0];
    const el = ${JSON.stringify(target)} === 'arrow' ? row.querySelector('.arrow-span') : row;
    if(!el) return 'no-arrow';
    el.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, view:window}));
    return 'clicked';
  })()`);

  for (let i = 0; i < 4; i++) {
    const st = await q(`folderState(${JSON.stringify(name)})`);
    if (!st) return false;
    if (st.open) return true;
    await jsClick(i % 2 === 0 ? 'arrow' : 'row');
    await sleep(1000);
  }
  const st = await q(`folderState(${JSON.stringify(name)})`);
  return !!(st && st.open);
}

async function createItem(parentName, name, isDir) {
  const base = path.basename(name);
  const parentRowName = parentName ? path.basename(parentName) : null;
  if (await cdp.js('__q.hasDialog()')) {
    const b = await q('dialogBtn()');
    if (b) { await cdp.click(b.x, b.y); await sleep(700); }
  }
  if (parentRowName) await ensureFolderOpen(parentRowName);
  const existing = await q(`treeRow(${JSON.stringify(base)})`);
  if (existing && isDir) { console.log('  = dir 已存在 ' + name); return; }
  if (existing && !isDir) { console.log('  ~ file 已存在，直接打开 ' + name); return; }

  // 开跑前先清掉可能残留的弹窗
  if (await cdp.js('__q.hasDialog()')) {
    const b = await q('dialogBtn()');
    if (b) { await cdp.click(b.x, b.y); await sleep(700); }
  }
  if (parentRowName) {
    const row = await q(`treeRow(${JSON.stringify(parentRowName)})`);
    if (!row) throw new Error('树里找不到节点 ' + parentRowName + '（' + parentName + '）');
    await sleep(600);
    await cdp.click(row.x, row.y, 'right');
  } else {
    const pt = await q('treeBottom()');
    await cdp.click(pt.x, pt.y, 'right');
  }
  await sleep(700);
  let item = await q(`menu(${JSON.stringify(isDir ? '新建文件夹' : '新建文件')})`);
  if (!item) {
    // 菜单没出来，重试一次右键
    if (parentRowName) {
      const row2 = await q(`treeRow(${JSON.stringify(parentRowName)})`);
      if (row2) await cdp.click(row2.x, row2.y, 'right');
    } else {
      const pt2 = await q('treeBottom()');
      await cdp.click(pt2.x, pt2.y, 'right');
    }
    await sleep(900);
    item = await q(`menu(${JSON.stringify(isDir ? '新建文件夹' : '新建文件')})`);
  }
  if (!item) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, 'debug-menu-fail.png'), Buffer.from(shot.data, 'base64'));
    throw new Error('右键菜单没出现: ' + (isDir ? '新建文件夹' : '新建文件') + '（截图 debug-menu-fail.png）');
  }
  await cdp.click(item.x, item.y);
  await sleep(1200);

  let focused = await cdp.js('__q.focusModal()');
  if (!focused) {
    await cdp.click(item.x, item.y);
    await sleep(1200);
    focused = await cdp.js('__q.focusModal()');
  }
  if (!focused) throw new Error('文件名弹窗没出现');
  await cdp.insertText(name);
  await sleep(300);
  const ok = await q('okBtn()');
  if (!ok) throw new Error('确定按钮没找到');
  await cdp.click(ok.x, ok.y);
  for (let i = 0; i < 10; i++) { await sleep(300); if (!(await cdp.js('__q.hasDialog()'))) break; }
  await sleep(700);
  console.log('  + ' + (isDir ? 'dir ' : 'file') + ' ' + (parentName ? parentName + '/' : '') + name);
}

async function expandPath(dirPath) {
  if (!dirPath) return;
  const segs = dirPath.split('/').filter(Boolean);
  for (const s of segs) await ensureFolderOpen(s);
}

async function openFile(basename, parentDir) {
  let ok = false;
  let last = '';
  for (let i = 0; i < 3; i++) {
    if (parentDir) await expandPath(parentDir);
    const row = await q(`treeRow(${JSON.stringify(basename)})`);
    if (row) {
      await sleep(250);
      await cdp.click(row.x, row.y);            // 第一次点：选中
      await sleep(180);
      await cdp.click(row.x, row.y);            // 第二次点：打开
    }
    await sleep(1200);
    last = await currentPath();
    if (last && last.endsWith(basename)) { ok = true; break; }
  }
  if (!ok) throw new Error('打不开文件 ' + basename + '（最后一次路径 ' + last + '）');
  await sleep(300);
}

async function currentPath() {
  const t = await cdp.js("(()=>{const e=[...document.querySelectorAll('div,span')].find(x=>/^页面路径：/.test((x.innerText||'').trim())); return e ? e.innerText.trim() : ''})()");
  if (!t) return '';
  const first = t.split(String.fromCharCode(10))[0].trim();
  return first.replace(/^页面路径：/, '').trim();
}

async function writeEditor(content) {
  const ed = await q('editor()');
  if (!ed) throw new Error('编辑器不可见');
  const res = await cdp.js(`navigator.clipboard.writeText(${JSON.stringify(content)}).then(function(){return 'ok'}).catch(function(e){return 'fail:'+e.message})`);
  if (res !== 'ok') throw new Error('写剪贴板失败: ' + res);
  // 直接把焦点给 Monaco 的隐藏 textarea，比点坐标可靠
  const focused = await cdp.js("(()=>{const ta=document.querySelector('.monaco-editor textarea.inputarea'); if(!ta) return false; ta.focus(); return document.activeElement===ta;})()");
  if (!focused) {
    await cdp.click(ed.x, ed.top + 80);
    await sleep(300);
  }
  await cdp.combo('a');
  await sleep(250);
  await cdp.combo('v');
  await sleep(800);
  await cdp.combo('s');
  await sleep(800);
}

async function main() {
  const list = await get('/json/list');
  const page = list.find(t => t.type === 'page' && (t.url || '').includes('edu.weixin.qq.com'));
  if (!page) throw new Error('找不到平台页面');
  cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.js(H);

  const onlyIdx = ARGS.indexOf('--only');
  const only = onlyIdx >= 0 ? ARGS[onlyIdx + 1].split(',') : null;
  const contentOnly = ARGS.includes('--content-only');
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
  const pick = f => !only || only.includes(f.name) || only.includes(path.basename(f.name));

  if (contentOnly) {
    for (const f of m.files.filter(f => f.type === 'file' && pick(f))) {
      const local = path.join(SRC, f.name);
      if (!fs.existsSync(local)) { console.log('  ! 本地缺文件 ' + f.name); continue; }
      const content = fs.readFileSync(local, 'utf8');
      console.log('重写 ' + f.name + ' (' + content.length + ' 字符)');
      await openFile(path.basename(f.name), f.name.indexOf('/') > 0 ? f.name.slice(0, f.name.lastIndexOf('/')) : '');
      const showed = await currentPath();
      if (!showed || !showed.endsWith(f.name)) throw new Error('打开的文件不对：期望 ' + f.name + '，实际 ' + showed);
      await writeEditor(content);
    }
    console.log('done (content-only)');
    process.exit(0);
  }

  for (const f of m.files.filter(f => f.type === 'dir' && pick(f))) {
    await createItem(f.parent || null, path.basename(f.name), true);
  }
  for (const f of m.files.filter(f => f.type === 'file' && pick(f))) {
    const local = path.join(SRC, f.name);
    if (!fs.existsSync(local)) { console.log('  ! 本地缺文件 ' + f.name); continue; }
    const content = fs.readFileSync(local, 'utf8');
    console.log('推送 ' + f.name + ' (' + content.length + ' 字符)');
    if (f.parent !== 'open') {
      await createItem(f.parent, path.basename(f.name), false);
    }
    // 关键：无论新建还是已存在，都显式打开这个文件，再核对底部路径，避免写错文件
    await openFile(path.basename(f.name), f.name.indexOf('/') > 0 ? f.name.slice(0, f.name.lastIndexOf('/')) : '');
    const showed = await currentPath();
    if (!showed || !showed.endsWith(f.name)) {
      throw new Error('打开的文件不对：期望 ' + f.name + '，实际 ' + showed);
    }
    await writeEditor(content);
  }
  console.log('done');
  process.exit(0);
}
main().catch(e => { console.error('ERR ' + e.message); process.exit(1); });

