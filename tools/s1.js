(() => {
  const c = document.querySelector('.file-tree-container');
  if (!c) return 'no-tree';
  const rows = [...c.querySelectorAll('div')].filter(e => ((e.innerText||'').trim().split(String.fromCharCode(10))[0]||'').trim() === 'utils');
  if (!rows.length) return 'no-utils';
  rows.sort((a,b)=>(a.innerText||'').length-(b.innerText||'').length);
  const arrow = rows[0].querySelector('.arrow-span');
  const wasOpen = arrow && arrow.getAttribute('data-open') === 'true';
  if (!wasOpen && arrow) arrow.dispatchEvent(new MouseEvent('click', {bubbles:true,cancelable:true,view:window}));
  return wasOpen ? 'already-open' : 'opened';
})()