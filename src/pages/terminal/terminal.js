var relay = require('../../utils/relay.js');

var ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\u0007]*\u0007|\x1b[()][A-Za-z0-9]/g;
var DEFAULT_COLOR = '#c6cad0';

function clean(s) {
  return String(s || '').replace(ANSI, '').replace(/\r/g, '');
}

/** "#K0:0-4:2472c8;0:8-9:e5e510" → { 0: [[0,4,'#2472c8'], [8,9,'#e5e510']] } */
function parseColors(spec) {
  var map = {};
  if (!spec) return map;
  var parts = spec.split(';');
  for (var i = 0; i < parts.length; i++) {
    var m = /^(\d+):(\d+)-(\d+):([0-9a-fA-F]{6})$/.exec(parts[i]);
    if (!m) continue;
    var row = parseInt(m[1], 10);
    if (!map[row]) map[row] = [];
    map[row].push([parseInt(m[2], 10), parseInt(m[3], 10), '#' + m[4]]);
  }
  return map;
}

/** 一行文字按颜色段切成 [{t, c}] */
function segment(line, runs) {
  if (!runs || !runs.length) return [{ t: line, c: DEFAULT_COLOR }];
  var sorted = runs.slice().sort(function (a, b) { return a[0] - b[0]; });
  var out = [];
  var pos = 0;
  for (var i = 0; i < sorted.length; i++) {
    var start = sorted[i][0], end = sorted[i][1], color = sorted[i][2];
    if (start > pos) out.push({ t: line.substring(pos, start), c: DEFAULT_COLOR });
    var s = Math.max(start, pos);
    if (end >= s) {
      out.push({ t: line.substring(s, end + 1), c: color });
      pos = end + 1;
    }
  }
  if (pos < line.length) out.push({ t: line.substring(pos), c: DEFAULT_COLOR });
  var merged = [];
  for (var j = 0; j < out.length; j++) {
    if (!out[j].t) continue;
    if (merged.length && merged[merged.length - 1].c === out[j].c) {
      merged[merged.length - 1].t += out[j].t;
    } else {
      merged.push({ t: out[j].t, c: out[j].c });
    }
  }
  return merged;
}

Page({
  data: {
    lines: [],
    screen: [],
    colors: {},
    seq: 0,
    anchor: 'end',
    focused: true,
    pending: ''
  },

  onLoad: function () {
    var self = this;
    relay.termRestart().then(function () {
      setTimeout(function () { self.startPoll(); }, 1500);
    }).catch(function () { self.startPoll(); });
  },
  onUnload: function () { if (this.timer) clearInterval(this.timer); },
  onHide: function () { if (this.timer) clearInterval(this.timer); },
  onShow: function () { if (!this.timer) this.startPoll(); },

  applyFrame: function (text, seq) {
    var txt = clean(text || '');
    var parts = txt.split('\n');

    if (parts.length && parts[0].indexOf('#C') === 0) parts = parts.slice(1);

    // 先去掉末尾空行，颜色块才露到最后一个位置
    while (parts.length && parts[parts.length - 1] === '') parts.pop();

    var colorMap = {};
    for (var i = parts.length - 1; i >= 0; i--) {
      if (parts[i].indexOf('#K') === 0) {
        colorMap = parseColors(parts[i].substring(2));
        parts.splice(i, 1);
        break;
      }
    }

    this.setData({ screen: parts, colors: colorMap, seq: seq || this.data.seq });
    this.rebuild();
  },

  rebuild: function () {
    var sc = this.data.screen || [];
    var cm = this.data.colors || {};
    var out = [];
    for (var i = 0; i < sc.length; i++) {
      out.push({ k: i + 1, segs: segment(sc[i], cm[i]) });
    }
    this.setData({ lines: out });
  },

  startPoll: function () {
    var self = this;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(function () {
      // 正在上一次请求里就跳过，避免请求堆积导致画面跳帧
      if (self.busy) return;
      self.busy = true;
      relay.termRead(self.data.seq).then(function (r) {
        self.busy = false;
        if (!r) return;
        // 有内容就渲染；即使 seq 相同也应用（逐帧消费时 seq 会正常推进）
        if (r.text && r.text.length) {
          self.applyFrame(r.text, r.seq);
        } else if (r.seq && r.seq !== self.data.seq) {
          self.setData({ seq: r.seq });
        }
      }).catch(function () {
        self.busy = false;
      });
    }, 250);
  },

  onInput: function (e) {
    var next = e.detail.value || '';
    var prev = this.data.pending || '';
    this.setData({ pending: next });
    if (next.length > prev.length) {
      relay.termSend(next.substring(prev.length)).catch(function () {});
    } else if (next.length < prev.length) {
      var n = prev.length - next.length, bs = '';
      for (var i = 0; i < n; i++) bs += '\u007f';
      relay.termSend(bs).catch(function () {});
    }
  },

  onEnter: function (e) {
    this.setData({ pending: '' });
    relay.termSend('\n').catch(function () {});
  }
});
