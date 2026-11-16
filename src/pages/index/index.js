var relay = require('../../utils/relay.js');

var SETUP_KEY = 'kc_setup_done';

Page({
  data: {
    stage: 'setup',
    devices: [],
    code: '',
    userInitials: '?',
    signedOut: false,
    userLabel: '',
    userName: '',
    lanHost: '',
    lanToken: '',
    lanOk: false,
    lanTesting: false,
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
    // 退到未登录态时，先让用户选登录方式
    var user = require('../../utils/user.js');
    if (user.isSignedOut() || !user.isLoggedIn()) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    this.loginUser();
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
    this.loadLan();
    this.refresh();
    var self = this;
    relay.cloudProbe().then(function (r) {
      self.setData({ cloudMsg: (r.ok ? '' : '✗ ') + r.msg });
    });
  },

  onShow: function () {
    this.loginUser();
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


  // ---- 局域网直连配置 ----
  loadLan: function () {
    var net = require('../../utils/net.js');
    this.setData({
      lanHost: net.getLanHost(),
      lanToken: net.getLanToken()
    });
  },

  onLanHost: function (e) {
    var net = require('../../utils/net.js');
    net.setLanHost(e.detail.value);
    this.setData({ lanHost: e.detail.value, lanOk: false });
  },

  onLanToken: function (e) {
    var net = require('../../utils/net.js');
    net.setLanToken(e.detail.value);
    this.setData({ lanToken: e.detail.value });
  },

  toggleLanManual: function () {
    this.setData({ lanManual: !this.data.lanManual });
  },
  testLan: function () {
    var self = this;
    var net = require('../../utils/net.js');
    if (!net.getLanHost()) {
      this.setData({ hint: '先填电脑的局域网地址，例如 192.168.1.10:8765' });
      return;
    }
    this.setData({ lanTesting: true, hint: '正在探测 ' + net.lanBase() + ' …' });
    net.probeLan().then(function (ok) {
      self.setData({
        lanTesting: false,
        lanOk: ok,
        lanAuto: false,
        hint: ok ? '局域网直连可用：同 WiFi 下会自动走本地' : '探测失败，检查地址、令牌和防火墙'
      });
    });
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
      // 顺手试一下能不能直连局域网，通了就自动配上，不用用户填地址
      self.autoLan(list);
    });
  },

  // 自动发现同一 WiFi 下的电脑
  autoLan: function (list) {
    var self = this;
    var net = require('../../utils/net.js');
    if (this._autoLanBusy) return;
    this._autoLanBusy = true;
    net.autoDiscover(list).then(function (base) {
      self._autoLanBusy = false;
      if (base) {
        self.setData({ lanHost: net.getLanHost(), lanToken: net.getLanToken(), lanOk: true, lanAuto: true });
      } else {
        // 探测失败可能是不同网络，不清掉用户手填的配置
        self.setData({ lanAuto: false });
      }
    }).catch(function () { self._autoLanBusy = false; });
  },

  // ---- 账号 ----
  loginUser: function () {
    var self = this;
    var user = require('../../utils/user.js');
    // 主动退出过就别自动登回来，显示成「登」等用户点
    if (user.isSignedOut()) {
      this.setData({ userInitials: '登', signedOut: true, userLabel: '未登录', userName: '' });
      return;
    }
    user.ensureLogin().then(function () {
      self.setData({ userInitials: user.initials(), signedOut: false, userLabel: '', userName: user.displayName() });
    }).catch(function () {
      self.setData({ userInitials: '?' });
    });
  },

  // 用户主动点登录
  doSignIn: function () {
    var self = this;
    var user = require('../../utils/user.js');
    wx.showLoading({ title: '登录中…' });
    user.signIn().then(function (u) {
      wx.hideLoading();
      self.setData({ userInitials: user.initials(), signedOut: false, userLabel: '', userName: user.displayName() });
      wx.showToast({ title: '已登录', icon: 'success' });
    }).catch(function (e) {
      wx.hideLoading();
      wx.showToast({ title: '登录失败', icon: 'none' });
    });
  },


  // 开发者：长按头像恢复默认未登录态
  devReset: function () {
    var self = this;
    wx.showActionSheet({
      itemList: ['恢复默认（清本地缓存）', '全部清空（含新 key）', '取消'],
      itemColor: '#e0846f',
      success: function (res) {
        if (res.tapIndex === 2) return;
        var wipeAll = res.tapIndex === 1;
        wx.showModal({
          title: wipeAll ? '全部清空？' : '恢复默认？',
          content: wipeAll
            ? '把这台设备上小程序存的所有数据都清掉。云端账号记录不动。'
            : '清掉账号、配对码、历史、会话和局域网配置，回到首次打开的状态。云端账号记录不动。',
          confirmText: wipeAll ? '全部清空' : '清掉',
          confirmColor: '#e0846f',
          success: function (r2) {
            if (!r2.confirm) return;
            var user = require('../../utils/user.js');
            var removed = user.resetToLoggedOut({ wipeAll: wipeAll });
            wx.showToast({ title: '已清除 ' + removed.length + ' 项', icon: 'success' });
            // 回到首页的配置态
            setTimeout(function () {
              wx.reLaunch({ url: '/pages/login/login' });
            }, 900);
          }
        });
      }
    });
  },
  goAccount: function () {
    if (this.data.signedOut) { this.doSignIn(); return; }
    wx.navigateTo({ url: '/pages/account/account' });
  },
  // 点设备卡片 = 直接进，不用再填配对码、也不用再点测试连接
  chooseDevice: function (e) {
    var self = this;
    var code = e.currentTarget.dataset.code;
    var name = e.currentTarget.dataset.name || code;
    relay.setDeviceCode(code);
    relay.setMock(false);
    this.setData({ chosenCode: code, code: code, online: true, connectedName: name, mock: false });

    // 直接绑定到当前账号并进主页；联网校验交给后台，不挡路
    wx.showLoading({ title: '正在连接…' });
    var user = require('../../utils/user.js');
    user.ensureLogin().then(function () {
      return relay.claimDevice(code);
    }).catch(function () {
      // 绑定失败（比如设备已被别人绑）不阻塞进入，只是不进我的设备列表
    }).then(function () {
      wx.hideLoading();
      wx.setStorageSync(SETUP_KEY, true);
      self.setData({ testing: false, stage: 'home', hint: '' });
      self.refresh();
    });
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
        // 配对成功就把这台电脑绑到当前账号名下，之后只在自己这里可见
        var user = require('../../utils/user.js');
        user.ensureLogin().then(function () {
          return relay.claimDevice(code);
        }).catch(function () {}).then(function () {
          self.setData({
            testing: false,
            stage: 'home',
            online: true,
            connectedName: self.data.connectedName || ('电脑 ' + code),
            hint: ''
          });
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
    this.loadLan();
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