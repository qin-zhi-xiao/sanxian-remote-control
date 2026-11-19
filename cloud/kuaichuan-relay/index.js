const http = require('http');
const ENV = 'eval-lifecycle-d7gf433u22f6c2405';
// 服务密钥由云函数环境变量 KC_API_KEY 注入；切勿写回源码或提交到版本库
const KEY = process.env.KC_API_KEY || "";
if (!KEY) console.error("[kuaichuan-relay] 未配置 KC_API_KEY");
const BASE = 'https://' + ENV + '.api.tcloudbasegateway.com/v1/database/instances/(default)/databases/(default)';
const PORT = process.env.PORT || 9000;
const CMD = 'commands';
const DEV = 'devices';

async function db(method, path, body) {
  const opts = { method, headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(BASE + path, opts);
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) { return {}; }
}

async function handle(req) {
  const a = req.action || 'poll';
  if (a === 'ping') {
    const p = await db('GET', '/collections/' + CMD + '/documents?limit=1');
    return { ok: true, svc: 'kuaichuan-relay', sdk: 'fetch', env: ENV, dbOk: !p.code };
  }
  if (a === 'send') {
    const doc = { deviceCode: req.deviceCode || '', kind: req.kind || 'shell', payload: req.payload || '',
      status: 'pending', createdAt: Date.now(), stdout: '', stderr: '', exitCode: null };
    const r = await db('POST', '/collections/' + CMD + '/documents', { data: [doc] });
    return { ok: true, id: (r.insertedIds && r.insertedIds[0]) || '' };
  }
  if (a === 'get') {
    if (!req.id) return { ok: false, error: 'missing id' };
    const r = await db('GET', '/collections/' + CMD + '/documents/' + encodeURIComponent(req.id));
    return { ok: true, doc: r || {} };
  }
  if (a === 'poll') {
    const limit = Math.min(Number(req.limit) || 5, 20);
    const q = encodeURIComponent('{"status":"pending"}');
    const r = await db('GET', '/collections/' + CMD + '/documents?query=' + q + '&limit=' + limit);
    return { ok: true, list: r.list || [] };
  }
  if (a === 'sync') {
    // 一次请求拉全：命令 / 终端输入 / 智能体消息 / shell 状态，并支持长轮询 hold（毫秒）。
    // 目的：把 exe 端每轮 3~4 次串行 HTTP RTT 合并成 1 次并发；有数据立即返回，无数据挂起到 hold 上限。
    const limit = Math.min(Number(req.limit) || 5, 20);
    const hold = Math.min(Math.max(Number(req.hold) || 0, 0), 25000);
    const code = req.deviceCode || '';
    const deadline = Date.now() + hold;
    const qPending = encodeURIComponent('{"status":"pending"}');
    const t0 = Date.now();
    let out = null;
    do {
      const reqs = [
        db('GET', '/collections/' + CMD + '/documents?query=' + qPending + '&limit=' + limit),
        db('GET', '/collections/term_in_4759588622381809665/documents?query=' + qPending + '&limit=5'),
        db('GET', '/collections/agent_in_4759588622381809665/documents?query=' + qPending + '&limit=3'),
      ];
      if (code) reqs.push(db('GET', '/collections/' + DEV + '/documents?query=' + encodeURIComponent(JSON.stringify({ deviceCode: code })) + '&limit=1'));
      const rs = await Promise.all(reqs);
      const cmds = rs[0].list || [], termIn = rs[1].list || [], agentIn = rs[2].list || [];
      out = { ok: true, commands: cmds, termIn: termIn, agentIn: agentIn, waited: 0 };
      if (code) {
        const d = ((rs[3] || {}).list || [])[0] || {};
        let ra = d.termRestartAt;
        if (ra && typeof ra === 'object') ra = ra.$numberLong !== undefined ? ra.$numberLong : ra.$numberInt;
        out.shell = d.termShell || 'gitbash';
        out.restartAt = Number(ra) || 0;
        out.bound = !!d.owner;
        out.confirmCode = d.confirmCode || '';
      }
      if (cmds.length || termIn.length || agentIn.length) break;
      if (!hold) break;
      await new Promise(r => setTimeout(r, 100));
    } while (Date.now() < deadline);
    out.waited = Date.now() - t0;
    return out;
  }
  if (a === 'update') {
    if (!req.id) return { ok: false, error: 'missing id' };
    const d = Object.assign({}, req.patch || {}); delete d._id;
    await db('PATCH', '/collections/' + CMD + '/documents', { query: { _id: req.id }, data: { $set: d } });
    return { ok: true, id: req.id };
  }
  if (a === 'heartbeat') {
    const code = req.deviceCode;
    if (!code) return { ok: false, error: 'missing deviceCode' };
    const payload = { deviceCode: code, name: req.name || '', lastSeen: Date.now(), agents: req.agents || [], confirmCode: req.confirmCode || '' };
    const q = encodeURIComponent(JSON.stringify({ deviceCode: code }));
    const f = await db('GET', '/collections/' + DEV + '/documents?query=' + q + '&limit=1');
    const l = f.list || [];
    if (l.length) await db('PATCH', '/collections/' + DEV + '/documents', { query: { _id: l[0]._id }, data: { $set: payload } });
    else await db('POST', '/collections/' + DEV + '/documents', { data: [payload] });
    return { ok: true, deviceCode: code };
  }
  if (a === 'devices') {
    const r = await db('GET', '/collections/' + DEV + '/documents?limit=10');
    return { ok: true, list: r.list || [] };
  }
  if (a === 'term_in') {
    const r = await db('GET', '/collections/term_in_4759588622381809665/documents?query=' + encodeURIComponent('{"status":"pending"}') + '&limit=5');
    return { ok: true, list: r.list || [] };
  }
  if (a === 'term_ack') {
    if (!req.id) return { ok: false, error: 'missing id' };
    await db('PATCH', '/collections/term_in_4759588622381809665/documents', { query: { _id: req.id }, data: { $set: { status: 'done' } } });
    return { ok: true };
  }
  if (a === 'term_push') {
    const doc = { deviceCode: req.deviceCode || '', seq: Number(req.seq) || 0, text: req.text || '', createdAt: Date.now() };
    await db('POST', '/collections/term_out_4759588622381809665/documents', { data: [doc] });
    return { ok: true };
  }
  if (a === 'term_send') {
    const doc = { deviceCode: req.deviceCode || '', data: req.data || '', status: 'pending', createdAt: Date.now() };
    const r = await db('POST', '/collections/term_in_4759588622381809665/documents', { data: [doc] });
    return { ok: true, id: (r.insertedIds && r.insertedIds[0]) || '' };
  }
  if (a === 'term_read') {
    const from = Number(req.from) || 0;
    const q = encodeURIComponent(JSON.stringify({ seq: { $gt: from } }));
    const r = await db('GET', '/collections/term_out_4759588622381809665/documents?query=' + q + '&limit=20&order=' + encodeURIComponent('[{"field":"seq","direction":"desc"}]'));
    const list = r.list || [];
    if (!list.length) return { ok: true, text: '', seq: from, count: 0 };
    let sv = list[0].seq;
    if (sv && typeof sv === 'object') sv = sv.$numberLong !== undefined ? sv.$numberLong : sv.$numberInt;
    const n = Number(sv);
    return { ok: true, text: list[0].text || '', seq: isNaN(n) ? from : n, count: 1 };
  }
  if (a === 'term_shell_set') {
    await db('PATCH', '/collections/devices/documents', {
      query: { deviceCode: req.deviceCode },
      data: { $set: { termShell: req.shell || 'gitbash', termShellAt: Date.now() } },
    });
    return { ok: true };
  }
  if (a === 'term_restart') {
    await db('PATCH', '/collections/devices/documents', {
      query: { deviceCode: req.deviceCode },
      data: { $set: { termRestartAt: Date.now() } },
    });
    return { ok: true };
  }
  if (a === 'term_shell_get') {
    const r = await db('GET', '/collections/devices/documents?query=' + encodeURIComponent(JSON.stringify({ deviceCode: req.deviceCode })) + '&limit=1');
    const d = (r.list || [])[0] || {};
    let ra = d.termRestartAt; if (ra && typeof ra === 'object') ra = ra.$numberLong !== undefined ? ra.$numberLong : ra.$numberInt;
      return { ok: true, shell: d.termShell || 'gitbash', at: d.termShellAt || 0, restartAt: Number(ra) || 0 };
  }
  if (a === 'agent_in') {
    const q = encodeURIComponent(JSON.stringify({ status: 'pending' }));
    const r = await db('GET', '/collections/agent_in_4759588622381809665/documents?query=' + q + '&limit=3');
    return { ok: true, list: r.list || [] };
  }
  if (a === 'agent_send') {
    const doc = {
      deviceCode: req.deviceCode || '', agent: req.agent || 'claude', exe: req.exe || req.agent || 'claude',
      text: req.text || '', headless: req.headless || '0', status: 'pending', createdAt: Date.now(),
    };
    const r = await db('POST', '/collections/agent_in_4759588622381809665/documents', { data: [doc] });
    return { ok: true, id: (r.insertedIds && r.insertedIds[0]) || '' };
  }
  if (a === 'agent_reply') {
    if (!req.id) return { ok: false, error: 'missing id' };
    await db('PATCH', '/collections/agent_in_4759588622381809665/documents', {
      query: { _id: req.id },
      data: { $set: { status: 'done', reply: req.text || '', repliedAt: Date.now() } },
    });
    return { ok: true };
  }
  if (a === 'agent_result') {
    const r = await db('GET', '/collections/agent_in_4759588622381809665/documents/' + encodeURIComponent(req.id));
    return { ok: true, doc: r || {} };
  }
  // ---- 电脑端自管（exe 用配对码证明「我就是这台电脑」）----
  if (a === 'device_self_status') {
    const code = req.deviceCode || '';
    if (!code) return { ok: false, error: '缺 deviceCode' };
    const q = encodeURIComponent(JSON.stringify({ deviceCode: code }));
    const fr = await db('GET', '/collections/' + DEV + '/documents?query=' + q + '&limit=1');
    const hit = (fr.list || [])[0];
    if (!hit) return { ok: true, bound: false, owner: '', alias: '' };
    let owner = '';
    if (hit.owner) {
      const uq = encodeURIComponent(JSON.stringify({ uid: hit.owner }));
      const uf = await db('GET', '/collections/users/documents?query=' + uq + '&limit=1');
      const u = (uf.list || [])[0];
      if (u) owner = u.nickname || u.email || '某个账号';
      else owner = '某个账号';
    }
    return { ok: true, bound: !!hit.owner, owner: owner, alias: hit.alias || '' };
  }
  if (a === 'device_self_release') {
    const code = req.deviceCode || '';
    if (!code) return { ok: false, error: '缺 deviceCode' };
    const q = encodeURIComponent(JSON.stringify({ deviceCode: code }));
    const fr = await db('GET', '/collections/' + DEV + '/documents?query=' + q + '&limit=1');
    const hit = (fr.list || [])[0];
    if (!hit) return { ok: false, error: '这台电脑还没注册到云端' };
    await db('PATCH', '/collections/' + DEV + '/documents', {
      query: { _id: hit._id },
      data: { $set: { owner: '', alias: '', releasedAt: Date.now() } },
    });
    return { ok: true };
  }
  return { ok: false, error: 'unknown action: ' + a };
}

// 网关鉴权：电脑端 gw_call() 每个请求都带 Authorization: Bearer <API Key>。
// 校验它与服务端 KC_API_KEY 一致，挡住匿名调用；服务端没配密钥时一律拒绝。
const crypto = require('crypto');
function tokenOk(given) {
  if (!KEY) return false;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  // 平台健康检查用：不碰数据库、不暴露环境信息
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors));
    return res.end(JSON.stringify({ ok: true, svc: 'kuaichuan-relay' }));
  }
  const auth = String(req.headers.authorization || '');
  if (!tokenOk(auth.replace(/^Bearer\s+/i, ''))) {
    res.writeHead(KEY ? 401 : 503, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors));
    return res.end(JSON.stringify({ ok: false, error: KEY ? 'unauthorized' : 'KC_API_KEY 未配置' }));
  }
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', async () => {
    let p = {};
    if (raw) { try { p = JSON.parse(raw); } catch (e) { p = {}; } }
    let out;
    try { out = await handle(p); } catch (e) { out = { ok: false, error: (e && e.message) || String(e) }; }
    res.writeHead(out.ok ? 200 : 400, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors));
    res.end(JSON.stringify(out));
  });
}).listen(PORT, () => console.log('[kuaichuan-relay] fetch mode on ' + PORT));