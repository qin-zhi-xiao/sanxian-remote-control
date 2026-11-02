const http = require('http');
const ENV = 'eval-lifecycle-d7gf433u22f6c2405';
const KEY = 'eyJhbGciOiJSUzI1NiIsImtpZCI6IjlkMWRjMzFlLWI0ZDAtNDQ4Yi1hNzZmLWIwY2M2M2Q4MTQ5OCJ9.eyJhdWQiOiJldmFsLWxpZmVjeWNsZS1kN2dmNDMzdTIyZjZjMjQwNSIsImV4cCI6MjUzNDAyMzAwNzk5LCJpYXQiOjE3OTMzNjg0NTMsImF0X2hhc2giOiJRVFVscXg3eVRiT1NrTlV0OVdBR3N3IiwicHJvamVjdF9pZCI6ImV2YWwtbGlmZWN5Y2xlLWQ3Z2Y0MzN1MjJmNmMyNDA1IiwibWV0YSI6eyJwbGF0Zm9ybSI6IkFwaUtleSJ9LCJhZG1pbmlzdHJhdG9yX2lkIjoiMjExNTgxOTk3MDM5OTI0ODM4NiIsInVzZXJfdHlwZSI6IiIsImNsaWVudF90eXBlIjoiY2xpZW50X3NlcnZlciIsImlzX3N5c3RlbV9hZG1pbiI6dHJ1ZX0.emnlbKqAhQZl1HhMyNZLzDgWvA78kSJQ90ukA9Ocibo2dd6hSRfPODqNyvp-OWAxuzdaj5ajfcBAn6zTns7pgOF8cdxdCVj7EmWAfKDge5Ybz2VVBMRP6MISEHr5KPoSrkNe4B0W-BEFgKoQ0PkZK2sWcymj3_XPjj-2Hc5M8Zz7_1iuuxYx4xuyPixMoT2DVcLq_ZgGpJ2w9rzhu5WX1AjiAu7TTJgtKfwS5m4YClTvN8cSInlr0vdMdXLux7UssCHJ9WFfvhegg2l3OulnNio1vOnCmMYZmWNmI1mm9B88zhqy1l1kbwlhMuZVHIBbZO6hNVPbj-oArMJxO29YHA';
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
  if (a === 'update') {
    if (!req.id) return { ok: false, error: 'missing id' };
    const d = Object.assign({}, req.patch || {}); delete d._id;
    await db('PATCH', '/collections/' + CMD + '/documents', { query: { _id: req.id }, data: { $set: d } });
    return { ok: true, id: req.id };
  }
  if (a === 'heartbeat') {
    const code = req.deviceCode;
    if (!code) return { ok: false, error: 'missing deviceCode' };
    const payload = { deviceCode: code, name: req.name || '', lastSeen: Date.now(), agents: req.agents || [] };
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
  }  return { ok: false, error: 'unknown action: ' + a };
}

http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
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