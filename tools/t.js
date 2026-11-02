(() => {
  const c = document.querySelector('.file-tree-container');
  if (!c) return JSON.stringify({err:'no-tree'});
  const pick = n => {
    const rows = [...c.querySelectorAll('div')].filter(e => ((e.innerText||'').trim().split(String.fromCharCode(10))[0]||'').trim() === n);
    if (!rows.length) return null;
    rows.sort((a,b)=>(a.innerText||'').length-(b.innerText||'').length);
    return rows[0];
  };
  const u = pick('utils');
  const rp = pick('relay.js');
  const out = { hasUtils: !!u };
  if (u) {
    const a = u.querySelector('.arrow-span');
    const ar = (a || u).getBoundingClientRect();
    out.arrow = { x: Math.round(ar.x + ar.width/2), y: Math.round(ar.y + ar.height/2), open: a ? a.getAttribute('data-open') : 'no-arrow' };
  }
  if (rp) {
    const r = rp.getBoundingClientRect();
    out.relay = { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), w: Math.round(r.width), h: Math.round(r.height) };
  }
  return JSON.stringify(out);
})()