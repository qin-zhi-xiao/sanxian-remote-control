var relay = require('../../utils/relay.js');

// 命令台：一条命令 -> 一次执行 -> 输出追加。
// 走 relay.run（commands 集合），不再依赖 ConPTY 的整屏快照。
Page({
  data: {
    log: [],
    input: '',
    busy: false,
    anchor: '',
    shell: ''
  },

  onLoad: function () {
    var self = this;
    relay.termGetShell().then(function (r) {
      self.setData({ shell: (r && r.shell) || '' });
    }).catch(function () {});
    this.append({ kind: 'sys', text: '命令台已就绪，输入命令后按发送。' });
  },

  append: function (e) {
    e.k = e.k || ('k' + Date.now() + Math.floor(Math.random() * 10000));
    var log = this.data.log.concat([e]);
    if (log.length > 400) log = log.slice(log.length - 400);
    this.setData({ log: log, anchor: 'end' });
  },

  onInput: function (e) { this.setData({ input: e.detail.value }); },
  onEnter: function () { this.send(); },

  send: function () {
    var self = this;
    if (this.data.busy) return;
    var cmd = String(this.data.input || '').trim();
    if (!cmd) return;

    this.setData({ input: '', busy: true });
    this.append({ kind: 'cmd', text: cmd });

    relay.run(cmd).then(function (rec) {
      self.setData({ busy: false });
      var out = (rec && rec.stdout) || '';
      var err = (rec && rec.stderr) || '';
      var st = (rec && rec.status) || 'done';

      if (out) self.append({ kind: 'out', text: out.replace(/\s+$/, '') });
      if (err) self.append({ kind: 'err', text: err.replace(/\s+$/, '') });
      if (!out && !err) self.append({ kind: 'sys', text: '（无输出）' });

      if (st !== 'done') {
        self.append({ kind: 'err', text: '[' + (relay.STATUS_TEXT[st] || st) + ']' });
      } else if (typeof rec.exitCode === 'number' && rec.exitCode !== 0) {
        self.append({ kind: 'err', text: 'exit ' + rec.exitCode });
      }
    }).catch(function (e) {
      self.setData({ busy: false });
      self.append({ kind: 'err', text: '失败：' + ((e && e.message) || e) });
    });
  },

  onRetry: function () {
    var self = this;
    var last = '';
    for (var i = this.data.log.length - 1; i >= 0; i--) {
      if (this.data.log[i].kind === 'cmd') { last = this.data.log[i].text; break; }
    }
    if (!last) return;
    this.setData({ input: last }, function () { self.send(); });
  }
});
