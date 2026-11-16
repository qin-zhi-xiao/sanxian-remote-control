(function () {
  var c = document.querySelector('.file-tree-container');
  if (!c) return 'no container';
  // 滚到底部找 utils 下的 config.js
  var target = null;
  var spots = [c.scrollHeight, c.scrollHeight * 0.85, c.scrollHeight * 0.7];
  for (var i = 0; i < spots.length; i++) {
    c.scrollTop = spots[i];
    var rows = c.querySelectorAll('div');
    for (var j = 0; j < rows.length; j++) {
      var t = ((rows[j].innerText || '').trim().split('\n')[0] || '').trim();
      if (t === 'config.js') {
        var r = rows[j].getBoundingClientRect();
        // 只要在可视范围内的
        if (r.top > 150 && r.bottom < 780) {
          target = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          break;
        }
      }
    }
    if (target) break;
  }
  return JSON.stringify({ target: target, scrollTop: Math.round(c.scrollTop) });
})()
