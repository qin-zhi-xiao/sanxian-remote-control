(function () {
  var sel = 'button,[role=button],svg,[class*=icon],[class*=btn],[class*=tool]';
  var all = document.querySelectorAll(sel);
  var out = [];
  for (var i = 0; i < all.length; i++) {
    var e = all[i];
    var b = e.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) continue;
    var cx = Math.round(b.left + b.width / 2);
    var cy = Math.round(b.top + b.height / 2);
    if (cy > 150) continue;
    out.push({
      t: (e.textContent || '').trim().slice(0, 14),
      c: String(e.className || '').slice(0, 34),
      x: cx,
      y: cy
    });
  }
  return JSON.stringify(out.slice(0, 25));
})()
