(function () {
  var c = document.querySelector('.file-tree-container');
  if (!c) return 'no container';
  var spots = [0, c.scrollHeight * 0.2, c.scrollHeight * 0.4, c.scrollHeight * 0.6];
  for (var i = 0; i < spots.length; i++) {
    c.scrollTop = spots[i];
    var rows = c.querySelectorAll('div');
    for (var j = 0; j < rows.length; j++) {
      var t = ((rows[j].innerText || '').trim().split('\n')[0] || '').trim();
      if (t === 'index') {
        var b = rows[j].getBoundingClientRect();
        if (b.top > 150 && b.bottom < 780) {
          var arrow = rows[j].querySelector('.arrow-span');
          var ar = arrow ? arrow.getBoundingClientRect() : null;
          return JSON.stringify({
            row: { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) },
            arrow: ar ? { x: Math.round(ar.left + ar.width / 2), y: Math.round(ar.top + ar.height / 2) } : null
          });
        }
      }
    }
  }
  return 'not found';
})()
