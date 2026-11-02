(() => {
  const out = { monaco: {}, tree: [], toolbar: [] };
  out.monaco = {
    editor: document.querySelectorAll('.monaco-editor').length,
    textarea: [...document.querySelectorAll('textarea')].map(t => {
      const r = t.getBoundingClientRect();
      return { cls: (t.className || '').slice(0, 40), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
    }),
  };
  // 文件树区域：x 300~460，y 100~500 之间的可点元素
  for (const e of document.querySelectorAll('div,span,i,a,button')) {
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cls = (e.className || '').toString();
    if (r.y < 95 || r.y > 140) continue;
    if (r.x < 290 || r.x > 470) continue;
    out.tree.push({ tag: e.tagName, cls: cls.slice(0, 45), title: e.getAttribute('title') || '', x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  }
  out.tree = out.tree.slice(0, 15);
  return JSON.stringify(out);
})()
