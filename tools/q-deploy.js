(function () {
  var out = [];
  var all = document.querySelectorAll('button,div[class*=btn],div[class*=Btn]');
  for (var i = 0; i < all.length; i++) {
    var e = all[i];
    var t = (e.textContent || '').trim();
    if (t.indexOf('部署') < 0) continue;
    var b = e.getBoundingClientRect();
    if (b.width <= 0) continue;
    out.push({
      t: t.slice(0, 12),
      c: String(e.className || '').slice(0, 36),
      x: Math.round(b.left + b.width / 2),
      y: Math.round(b.top + b.height / 2),
      w: Math.round(b.width),
      h: Math.round(b.height)
    });
  }
  return JSON.stringify(out);
})()
