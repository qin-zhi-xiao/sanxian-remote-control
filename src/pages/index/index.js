var relay = require('../../utils/relay.js');

var SETUP_KEY = 'kc_setup_done';

Page({
  data: {
    stage: 'setup',
    devices: [],
    code: '',
    chosenCode: '',
    online: false,
    connectedName: '',
    agentCount: 0,
    mock: false,
    testing: false,
    hint: '',
    cloudMsg: '检测中…',
    shell: 'gitbash',
    shellLabel: 'Git Bash'
  },

  onLoad: function () {
    var code = relay.getDeviceCode();
    var done = wx.getStorageSync(SETUP_KEY) === true;
    var savedShell = wx.getStorageSync('kc_shell') || 'gitbash';
    var savedLabel = { gitbash: 'Git Bash', cmd: 'CMD', powershell: 'PowerShell' }[savedShell] || savedShell;
    this.setData({
      code: code,
      chosenCode: code,
      mock: relay.isMock(),
      shell: savedShell,
      shellLabel: savedLabel,
      stage: done && code ? 'home' : 'setup'
    });
    this.refresh();
    var self = this;
    relay.cloudProbe().then(function (r) {
      self.setData({ cloudMsg: (r.ok ? '' : '✗ ') + r.msg });
    });
  },

  onShow: function () {
    if (this.data.stage === 'home') this.refresh();
    // 从 shell 选择页返回时同步显示
    var saved = wx.getStorageSync('kc_shell') || 'gitbash';
    var label = { gitbash: 'Git Bash', cmd: 'CMD', powershell: 'PowerShell' }[saved] || saved;
    if (saved !== this.data.shell || label !== this.data.shellLabel) {
      this.setData({ shell: saved, shellLabel: label });
    }
  },

  isChosen: function (code) {
    return code === this.data.chosenCode;
  },

  refresh: function () {
    var self = this;
    relay.listDevices().then(function (list) {
      var chosen = self.data.chosenCode || relay.getDeviceCode();
      var hit = null;
      for (var i = 0; i < list.length; i++) if (list[i].deviceCode === chosen) hit = list[i];
      self.setData({
        devices: list,
        online: !!hit,
        connectedName: hit ? (hit.name || hit.deviceCode) : '',
        agentCount: (hit && hit.agents) ? hit.agents.length : 0,
        hint: list.length ? '' : '没发现电脑'
      });
    });
  },

  chooseDevice: function (e) {
    var code = e.currentTarget.dataset.code;
    var name = e.currentTarget.dataset.name || code;
    relay.setDeviceCode(code);
    relay.setMock(false);
    this.setData({ chosenCode: code, code: code, online: true, connectedName: name, mock: false });
  },

  onCode: function (e) {
    var v = (e.detail.value || '').trim();
    this.setData({ code: v, chosenCode: v });
    relay.setDeviceCode(v);
  },

  testConnection: function () {
    var self = this;
    var code = (this.data.chosenCode || this.data.code || '').trim();
    if (!code && !this.data.mock) {
      this.setData({ hint: '先填配对码（电脑端窗口里显示的 6 位数字）' });
      return;
    }
    this.setData({ testing: true, hint: '正在给电脑发一条测试命令…' });
    if (code) relay.setDeviceCode(code);

    // 模拟模式：直接成功
    if (self.data.mock) {
      wx.setStorageSync(SETUP_KEY, true);
      setTimeout(function () {
        self.setData({ testing: false, stage: 'home', online: false, connectedName: '模拟模式' });
      }, 600);
      return;
    }

    // 真实模式：发一条 echo，等电脑回话——这才是真的连通测试
    relay.run('echo kc-ping').then(function (rec) {
      self.finishTest(rec, code);
    });
  },

  finishTest: function (rec, code) {
    var self = this;
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      var r = relay.getRecord(rec.id) || rec;
      if (r.status === 'done') {
        clearInterval(timer);
        wx.setStorageSync(SETUP_KEY, true);
        self.setData({
          testing: false,
          stage: 'home',
          online: true,
          connectedName: self.data.connectedName || ('电脑 ' + code),
          hint: ''
        });
      } else if (r.status === 'error' || r.status === 'timeout' || tries > 25) {
        clearInterval(timer);
        self.setData({
          testing: false,
          hint: '电脑没回话。确认 kuaichuan.exe 在跑（云模式），或先点「先用模拟」'
        });
      }
    }, 800);
  },

  testConnectionOld: function () {
    var self = this;
    var code = (this.data.chosenCode || this.data.code || '').trim();
    if (!code) {
      this.setData({ hint: '先选一台电脑，或手动填配对码' });
      return;
    }
    this.setData({ testing: true, hint: '正在测试…' });
    relay.setDeviceCode(code);

    relay.listDevices().then(function (list) {
      var hit = null;
      for (var i = 0; i < list.length; i++) if (list[i].deviceCode === code) hit = list[i];
      var fresh = false;
      if (hit && hit.lastSeen) {
        var ts = typeof hit.lastSeen === 'number' ? hit.lastSeen : Number(hit.lastSeen);
        fresh = (Date.now() - ts) < 180000;
      }
      if (hit && fresh) {
        wx.setStorageSync(SETUP_KEY, true);
        self.setData({
          testing: false,
          stage: 'home',
          online: true,
          connectedName: hit.name || code,
          agentCount: (hit.agents || []).length
        });
      } else if (hit) {
        wx.setStorageSync(SETUP_KEY, true);
        self.setData({
          testing: false,
          stage: 'home',
          online: true,
          connectedName: hit.name || code,
          agentCount: (hit.agents || []).length
        });
      } else if (self.data.mock) {
        wx.setStorageSync(SETUP_KEY, true);
        self.setData({ testing: false, stage: 'home', online: false, connectedName: '模拟模式' });
      } else {
        self.setData({ testing: false, hint: '没找到这台电脑。确认 exe 在运行，或先点「先用模拟」' });
      }
    });
  },

  toggleMock: function () {
    var v = !this.data.mock;
    relay.setMock(v);
    this.setData({ mock: v, hint: v ? '已切到模拟模式' : '已关闭模拟' });
  },

  reconfigure: function () {
    wx.removeStorageSync(SETUP_KEY);
    this.setData({ stage: 'setup' });
    this.refresh();
  },

  goTerminal: function () { wx.navigateTo({ url: '/pages/terminal/terminal' }); },
  goAgent: function () { wx.navigateTo({ url: '/pages/agent/agent' }); },
  goShell: function () { wx.navigateTo({ url: '/pages/shell/shell' }); },



  pickShell: function (e) {
    var sh = e.currentTarget.dataset.shell;
    var label = { gitbash: 'Git Bash', cmd: 'CMD', powershell: 'PowerShell' }[sh] || sh;
    var self = this;
    this.setData({ shell: sh, shellLabel: label, hint: '正在切换，电脑端需要 1~2 秒重建会话…' });
    wx.setStorageSync('kc_shell', sh);
    relay.termSetShell(sh).then(function () {
      setTimeout(function () { self.setData({ hint: '' }); }, 2500);
    }).catch(function () {
      self.setData({ hint: '切换失败，检查电脑端是否在线' });
    });
  }
});