(() => {
  const out = [];
  // 找到资源管理器标题栏区域的所有可点元素
  const nodes = document.querySelectorAll('div,a,span,i,button');
  for (const e of nodes) {
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.y > 160 || r.y < 60) continue;         // 顶部工具区
    if (r.x < 300 || r.x > 800) continue;        // 文件树区域
    const cls = (e.className || '').toString();
    out.push({
      tag: e.tagName,
      cls: cls.slice(0, 60),
      title: e.getAttribute('title') || '',
      aria: e.getAttribute('aria-label') || '',
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
      w: Math.round(r.width),
    });
  }
  return JSON.stringify(out.slice(0, 40));
})()
