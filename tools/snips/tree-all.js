(() => {
  const out = [];
  const scope = document.querySelector('.file-tree-container') || document.body;
  const sr = scope.getBoundingClientRect();
  out.push({ scope: true, x: Math.round(sr.x), y: Math.round(sr.y), w: Math.round(sr.width), h: Math.round(sr.height) });
  for (const e of scope.querySelectorAll('*')) {
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cls = (e.className || '').toString();
    const txt = (e.innerText || '').trim().slice(0, 24);
    const title = e.getAttribute('title') || '';
    if (!txt && !title && !/icon|action|btn/i.test(cls)) continue;
    out.push({ tag: e.tagName, cls: cls.slice(0, 45), txt, title, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width) });
  }
  return JSON.stringify(out.slice(0, 45));
})()
