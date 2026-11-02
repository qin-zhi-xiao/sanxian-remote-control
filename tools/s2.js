(() => {
  const c = document.querySelector('.file-tree-container');
  const rows = [...c.querySelectorAll('div')].filter(e => ((e.innerText||'').trim().split(String.fromCharCode(10))[0]||'').trim() === 'relay.js');
  if (!rows.length) return 'no-row';
  rows.sort((a,b)=>(a.innerText||'').length-(b.innerText||'').length);
  const r = rows[0].getBoundingClientRect();
  return JSON.stringify({x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)});
})()