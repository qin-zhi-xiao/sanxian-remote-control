(function () {
  var out = {};
  out.hasQ = typeof window.__q;
  // 找左侧文件树里名叫 pages 的行
  var rows = document.querySelectorAll('[class*="row"], [class*="tree-item"], li, div');
  var hits = [];
  for (var i = 0; i < rows.length; i++) {
    var t = (rows[i].textContent || '').trim();
    if (t === 'pages' || t === 'utils' || t === 'account') {
      var r = rows[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        hits.push({ text: t, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
      }
    }
  }
  out.hits = hits.slice(0, 10);
  return JSON.stringify(out);
})()
