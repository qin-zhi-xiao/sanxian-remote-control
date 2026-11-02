(() => {
  const out = [];
  for (const e of document.querySelectorAll('div,span,button,a,li')) {
    const t = (e.innerText || '').trim();
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (t === 'HTTP Node.js Hello World' || t === 'HTTP 云函数' || t === 'Hello World') {
      out.push({ text: t, tag: e.tagName, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width) });
    }
  }
  return JSON.stringify(out.slice(0, 10));
})()