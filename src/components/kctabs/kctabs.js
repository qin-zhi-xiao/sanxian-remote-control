// kctabs · 顶部窗口标签栏（v1.6 窗口化）
// 会话列表存本地 storage（kc_sessions），点击用 redirectTo 在三页间切换，
// ＋ 新开窗口、× 关闭窗口。底层会话复用 exe 单会话，UI 层先行支持多标签。
var KEY = 'kc_sessions';

function defaults() {
  return [
    { type: 'terminal', id: 't1', title: '终端' },
    { type: 'agent', id: 'a1', title: 'Agent' }
  ];
}

function load() {
  var s = wx.getStorageSync(KEY);
  if (!Array.isArray(s) || !s.length) {
    s = defaults();
    wx.setStorageSync(KEY, s);
  }
  return s;
}

Component({
  properties: {
    // 'status' | 'terminal:<id>' | 'agent:<id>'
    active: { type: String, value: 'status' }
  },
  data: {
    sessions: []
  },
  lifetimes: {
    attached: function () {
      this.setData({ sessions: load() });
    }
  },
  methods: {
    urlOf: function (s) {
      var u = '/pages/' + s.type + '/' + s.type;
      return u + '?sid=' + s.id;
    },
    tapTab: function (e) {
      var t = e.currentTarget.dataset.t;
      if (t === 'status') {
        if (this.data.active !== 'status') wx.redirectTo({ url: '/pages/index/index' });
        return;
      }
      var key = t.type + ':' + t.id;
      if (this.data.active === key) return;
      wx.redirectTo({ url: this.urlOf(t) });
    },
    addTab: function () {
      var self = this;
      wx.showActionSheet({
        itemList: ['新终端窗口', '新 Agent 窗口'],
        success: function (r) {
          var s = load();
          var type = r.tapIndex === 0 ? 'terminal' : 'agent';
          var n = s.filter(function (x) { return x.type === type; }).length + 1;
          var item = {
            type: type,
            id: type[0] + n + '_' + Date.now().toString(36),
            title: (type === 'terminal' ? '终端' : 'Agent') + ' ' + n
          };
          s.push(item);
          wx.setStorageSync(KEY, s);
          self.setData({ sessions: s });
          wx.redirectTo({ url: self.urlOf(item) });
        }
      });
    },
    closeTab: function (e) {
      var id = e.currentTarget.dataset.id;
      var s = load().filter(function (x) { return x.id !== id; });
      if (!s.length) s = defaults();
      wx.setStorageSync(KEY, s);
      this.setData({ sessions: s });
      var cur = this.data.active;
      if (cur.indexOf(':') >= 0 && cur.split(':')[1] === id) {
        // 关掉的是当前窗口：跳到第一个剩余窗口
        wx.redirectTo({ url: this.urlOf(s[0]) });
      }
    }
  }
});
