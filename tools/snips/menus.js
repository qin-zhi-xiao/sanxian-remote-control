(() => {
  const out = [];
  for (const e of document.querySelectorAll('div,li,span,a,button')) {
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.width > 400) continue;
    const cls = (e.className || '').toString();
    const txt = (e.innerText || '').trim();
    if (!txt || txt.length > 20) continue;
    if (!/menu|dropdown|option|context|popover|list-item|tree-menu/i.test(cls)) continue;
    out.push({ cls: cls.slice(0, 50), txt, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  }
  return JSON.stringify(out.slice(0, 25));
})()
