(() => {
  const out = [];
  document.querySelectorAll('.header-btn').forEach((e, i) => {
    const r = e.getBoundingClientRect();
    out.push({
      i,
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
      cls: (e.className || '').toString().slice(0, 60),
      label: (e.innerText || '').trim().slice(0, 20),
      html: e.innerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>').slice(0, 120),
    });
  });
  return JSON.stringify(out);
})()
