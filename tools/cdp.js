#!/usr/bin/env node
// 极简 CDP 驱动：node cdp.js <cmd> [args]
// 命令: targets | eval <js> | evalf <file.js> | nav <url> | shot <out.png> | reload
const fs = require('fs');
const http = require('http');

const HOST = '127.0.0.1', PORT = 9222;

function get(path) {
  return new Promise((res, rej) => {
    http.get({ host: HOST, port: PORT, path }, r => {
      let b = '';
      r.on('data', c => b += c);
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res(b); } });
    }).on('error', rej);
  });
}

async function pickTarget(wantUrlPart) {
  const list = await get('/json/list');
  const pages = list.filter(t => t.type === 'page');
  if (!pages.length) throw new Error('no page target');
  let t = wantUrlPart ? pages.find(p => (p.url || '').includes(wantUrlPart)) : null;
  if (!t) t = pages.find(p => (p.url || '').includes('edu.weixin.qq.com')) || pages[0];
  return t;
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = e => rej(new Error('ws error'));
    });
    this.events = [];
    this.ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method) {
        this.events.push(m);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 60000);
    });
  }
  async eval(expr, contextId) {
    const params = { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true };
    if (contextId) params.contextId = contextId;
    const r = await this.send('Runtime.evaluate', params);
    if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails) };
    return r.result.value;
  }
  // 在 URL 含 urlPart 的 frame 的主世界里求值
  async evalInFrame(urlPart, expr) {
    await this.send('Runtime.enable').catch(() => {});
    await new Promise(r => setTimeout(r, 400));
    const ctxs = this.events
      .filter(e => e.method === 'Runtime.executionContextCreated')
      .map(e => e.params.context)
      .filter(c => c.auxData && c.auxData.isDefault);
    const hit = ctxs.find(c => (c.origin || '').includes(urlPart));
    if (!hit) return { __error: 'no context for ' + urlPart, contexts: ctxs.map(c => c.origin) };
    return this.eval(expr, hit.id);
  }
  async clickAt(x, y) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
  }
  async typeText(text) {
    await this.send('Input.insertText', { text });
  }
  async shot(file) {
    await this.send('Page.enable');
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const target = await pickTarget(process.env.TARGET_URL);
  if (cmd === 'targets') {
    const list = await get('/json/list');
    for (const t of list) if (t.type === 'page') console.log(t.id, '|', t.title, '|', t.url);
    return;
  }
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable').catch(() => {});
  if (cmd === 'eval') {
    console.log(JSON.stringify(await cdp.eval(rest.join(' ')), null, 2));
  } else if (cmd === 'evalf') {
    const src = fs.readFileSync(rest[0], 'utf8');
    console.log(JSON.stringify(await cdp.eval(src), null, 2));
  } else if (cmd === 'evalx') {
    const [urlPart, ...exprRest] = rest;
    console.log(JSON.stringify(await cdp.evalInFrame(urlPart, exprRest.join(' ')), null, 2));
  } else if (cmd === 'evalxf') {
    const [urlPart, file] = rest;
    const src = fs.readFileSync(file, 'utf8');
    console.log(JSON.stringify(await cdp.evalInFrame(urlPart, src), null, 2));
  } else if (cmd === 'frames') {
    await new Promise(r => setTimeout(r, 500));
    for (const e of cdp.events.filter(x => x.method === 'Runtime.executionContextCreated')) {
      const c = e.params.context;
      console.log(c.id, '|', c.origin, '|', c.name || '', '| default=', !!(c.auxData && c.auxData.isDefault));
    }
  } else if (cmd === 'clipfile') {
    const text = fs.readFileSync(rest[0], 'utf8');
    const r = await cdp.eval(`navigator.clipboard.writeText(${JSON.stringify(text)}).then(function(){return 'ok'}).catch(function(e){return 'fail:'+e.message})`);
    console.log('clip ' + text.length + ' chars -> ' + r);
  } else if (cmd === 'type') {
    await cdp.send('Input.insertText', { text: rest.join(' ') });
    console.log('typed', rest.join(' ').length, 'chars');
  } else if (cmd === 'nav') {
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: rest[0] });
    await new Promise(r => setTimeout(r, 4000));
    console.log(JSON.stringify(await cdp.eval('location.href + " | " + document.title'), null, 2));
  } else if (cmd === 'reload') {
    await cdp.send('Page.enable');
    await cdp.send('Page.reload', {});
    await new Promise(r => setTimeout(r, 5000));
    console.log('reloaded');
  } else if (cmd === 'click') {
    const x = Number(rest[0]), y = Number(rest[1]);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
    console.log('clicked', x, y);
  } else if (cmd === 'tap') {
    const x = Number(rest[0]), y = Number(rest[1]);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await new Promise(r => setTimeout(r, 80));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    console.log('tapped', x, y);
  } else if (cmd === 'rclick') {
    const x = Number(rest[0]), y = Number(rest[1]);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', clickCount: 1 });
    console.log('right-clicked', x, y);
  } else if (cmd === 'paste') {
    const text = fs.readFileSync(rest[0], 'utf8');
    await cdp.send('Input.insertText', { text });
    console.log('inserted', text.length, 'chars from', rest[0]);
  } else if (cmd === 'chromekeys') {
    // 发送组合键，如 ctrl+a / ctrl+s / ctrl+v
    const spec = rest[0].toLowerCase();
    const parts = spec.split('+');
    const key = parts.pop();
    const modifiers = 2 * (parts.includes('ctrl') ? 1 : 0) + 4 * (parts.includes('shift') ? 1 : 0) + 8 * (parts.includes('alt') ? 1 : 0);
    const vk = { a: 65, s: 83, v: 86, c: 67, z: 90, f: 70 }[key] || key.toUpperCase().charCodeAt(0);
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', {
        type, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
        key: key.length === 1 ? key : key, code: 'Key' + key.toUpperCase(),
        text: type === 'keyDown' && !parts.length ? key : undefined,
      });
    }
    console.log('sent', spec);
  } else if (cmd === 'key') {
    const keyMap = { Enter: [13, 'Enter', '\r'], Escape: [27, 'Escape', ''], Tab: [9, 'Tab', ''] };
    const k = rest[0];
    const [code, key, text] = keyMap[k] || [Number(k), k, ''];
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', { type, windowsVirtualKeyCode: code, key, code: k, text: type === 'keyDown' ? text : undefined });
    }
    console.log('key', k);
  } else if (cmd === 'shot') {
    console.log(await cdp.shot(rest[0]));
  } else {
    console.log('usage: cdp.js targets|eval|evalf|nav|reload|shot');
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
