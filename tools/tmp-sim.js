(async () => {
  const out = { href: String(location.href).slice(0, 70), hasWx: typeof wx, origin: location.origin };
  try {
    const r = await fetch('http://127.0.0.1:8765/ping', { headers: { 'X-KC-Token': '123456' } });
    out.ping = await r.text();
  } catch (e) { out.ping = 'ERR:' + e.message; }
  try {
    out.lsKeys = Object.keys(localStorage).slice(0, 10);
  } catch (e) { out.lsKeys = 'ERR:' + e.message; }
  return JSON.stringify(out);
})()