(() => {
  const ed = document.querySelector('.monaco-editor');
  const ta = document.querySelector('.monaco-editor textarea.inputarea');
  if (!ed) return 'no-editor';
  if (ta) { ta.focus(); }
  const r = ed.getBoundingClientRect();
  return JSON.stringify({ ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 60), focused: !!ta && document.activeElement === ta });
})()