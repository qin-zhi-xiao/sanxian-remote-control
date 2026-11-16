(function () {
  // 找到文件树容器并滚回顶部
  var hits = [];
  var all = document.querySelectorAll('div,ul');
  var scrolled = 0;
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (el.scrollHeight > el.clientHeight + 20 && el.clientHeight > 200) {
      var r = el.getBoundingClientRect();
      // 只要左侧那一栏
      if (r.left < 500) {
        el.scrollTop = 0;
        scrolled++;
        hits.push({ left: Math.round(r.left), top: Math.round(r.top), h: Math.round(r.height) });
      }
    }
  }
  // 再查一次位置
  var out = [];
  var rows = document.querySelectorAll('div,li,span');
  for (var j = 0; j < rows.length; j++) {
    var t = (rows[j].textContent || '').trim();
    if (t === 'pages') {
      var rr = rows[j].getBoundingClientRect();
      if (rr.width > 0 && rr.height > 0) {
        out.push({ text: 'pages', x: Math.round(rr.left + rr.width / 2), y: Math.round(rr.top + rr.height / 2) });
      }
    }
  }
  return JSON.stringify({ scrolled: scrolled, containers: hits.slice(0, 3), pages: out.slice(0, 3) });
})()
