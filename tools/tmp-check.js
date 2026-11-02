(()=>{
  const c=document.querySelector('.file-tree-container');
  const cr=c.getBoundingClientRect();
  const rows=[...c.querySelectorAll('div')].filter(e=>((e.innerText||'').trim().split(String.fromCharCode(10))[0]||'').trim()==='relay.js');
  const all=[...c.querySelectorAll('div')].map(e=>({t:((e.innerText||'').trim().split(String.fromCharCode(10))[0]||''), y:Math.round(e.getBoundingClientRect().y)})).filter(o=>o.t);
  return JSON.stringify({container:{y:Math.round(cr.y),h:Math.round(cr.height),scrollTop:c.scrollTop,scrollH:c.scrollHeight}, relayCount:rows.length, relayRect: rows.length? (()=>{const r=rows[0].getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})():null, rows: all.slice(0,20)});
})()