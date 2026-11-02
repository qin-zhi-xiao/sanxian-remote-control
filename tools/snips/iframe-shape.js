(() => {
  const sel = ['.monaco-workbench', '.explorer-folders-view', '.title-actions', '.activitybar', '.editor-group-container', '.part.sidebar', '.part.editor'];
  const found = {};
  for (const s of sel) found[s] = document.querySelectorAll(s).length;
  const top = [...document.querySelectorAll('div')]
    .filter(e => { const r = e.getBoundingClientRect(); return r.width > 100 && r.height > 100; })
    .slice(0, 12)
    .map(e => { const r = e.getBoundingClientRect(); return { cls: (e.className || '').toString().slice(0, 50), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });
  return JSON.stringify({ found, top, bodyText: document.body.innerText.slice(0, 120) });
})()
