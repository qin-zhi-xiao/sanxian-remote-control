var user = require('../../utils/user.js');
var relay = require('../../utils/relay.js');

var onlineCache = {};

Page({
  data: {
    initials: '?',
    displayName: '未登录',
    uidShort: '',
    email: '',
    nickname: '',
    devices: [],
    savingEmail: false,
    savingNick: false,
    hint: '',
    devOpen: false,
    resetInfo: '',
    version: '1.4.0',
    tapsLeft: 5,
    tapHint: false,
    signedOut: false
  },

  onLoad: function () {
    var self = this;
    if (user.isSignedOut()) {
      this.setData({ signedOut: true, displayName: '未登录', initials: '登', uidShort: '' });
      return;
    }
    user.ensureLogin().then(function (u) {
      self.fill(u);
    }).catch(function (e) {
      self.setData({ hint: '登录失败：' + (e && e.message ? e.message : e) });
    });
  },

  onShow: function () {
    var self = this;
    if (user.isLoggedIn()) this.fill(user.current());
    // 刚重置过就别再回填设备了，否则看起来像没清干净
    if (this._justReset) return;
    // 云端已经把设备整理好了（含 mine / agents / online），直接用
    relay.listDevices().then(function (list) {
      self.setData({ devices: list || [] });
    });
  },

  fill: function (u) {
    if (!u) return;
    this.setData({
      initials: user.initials(),
      displayName: user.displayName(),
      uidShort: u.uid ? ('UID ' + String(u.uid).slice(-8)) : '',
      email: u.email || '',
      hasPassword: !!u.hasPassword,
      nickname: u.nickname || ''
    });
  },

  onEmail: function (e) { this.setData({ email: e.detail.value }); },
  onNick: function (e) { this.setData({ nickname: e.detail.value }); },

  saveEmail: function () {
    var self = this;
    var v = (this.data.email || '').trim();
    if (!v) { this.setData({ hint: '先填一个邮箱' }); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
      this.setData({ hint: '邮箱格式不对，检查一下' });
      return;
    }
    this.setData({ savingEmail: true, hint: '' });
    user.setEmail(v).then(function (u) {
      self.setData({ savingEmail: false, hint: '邮箱已保存' });
      self.fill(u);
    }).catch(function (e) {
      self.setData({ savingEmail: false, hint: e && e.message ? e.message : '保存失败' });
    });
  },

  saveNick: function () {
    var self = this;
    var v = (this.data.nickname || '').trim();
    this.setData({ savingNick: true, hint: '' });
    user.setNickname(v).then(function (u) {
      self.setData({ savingNick: false, hint: '昵称已保存' });
      self.fill(u);
    }).catch(function (e) {
      self.setData({ savingNick: false, hint: e && e.message ? e.message : '保存失败' });
    });
  },

  doSignIn: function () {
    var self = this;
    this.setData({ signingIn: true, hint: '' });
    user.signIn().then(function (u) {
      self.setData({ signingIn: false, signedOut: false, hint: '已登录' });
      self.fill(u);
      self.reloadDevices && self.reloadDevices();
    }).catch(function (e) {
      self.setData({ signingIn: false, hint: '登录失败：' + (e && e.message ? e.message : e) });
    });
  },
  onPwd: function (e) { this.setData({ pwd: e.detail.value }); },

  savePassword: function () {
    var self = this;
    var v = (this.data.pwd || '').trim();
    if (v.length < 6) { this.setData({ hint: '密码至少 6 位' }); return; }
    this.setData({ savingPwd: true, hint: '' });
    user.setPassword(v).then(function () {
      self.setData({ savingPwd: false, pwd: '', hasPassword: true, hint: '密码已设置，以后可以用邮箱登录' });
    }).catch(function (e) {
      self.setData({ savingPwd: false, hint: (e && e.message) || '设置失败' });
    });
  },

  // ---- 设备 ----
  reloadDevices: function () {
    var self = this;
    relay.listDevices().then(function (list) {
      self.setData({ devices: list || [] });
    }).catch(function () {});
  },

  claimDevice: function (e) {
    var self = this;
    var code = e.currentTarget.dataset.code;
    wx.showModal({
      title: '绑定这台电脑？',
      content: '输入电脑端程序窗口显示的 6 位绑定确认码',
      editable: true,
      placeholderText: '6 位数字确认码',
      confirmText: '绑定',
      success: function (r) {
        if (!r.confirm) return;
        var cc = (r.content || '').trim();
        if (!/^\d{6}$/.test(cc)) {
          wx.showToast({ title: '确认码是 6 位数字', icon: 'none' });
          return;
        }
        wx.showLoading({ title: '绑定中…' });
        relay.deviceClaim(code, cc).then(function () {
          wx.hideLoading();
          wx.showToast({ title: '已绑定', icon: 'success' });
          self.reloadDevices();
        }).catch(function (err) {
          wx.hideLoading();
          wx.showToast({ title: (err && err.message) || '绑定失败', icon: 'none' });
        });
      }
    });
  },

  removeDevice: function (e) {
    var self = this;
    var code = e.currentTarget.dataset.code;
    wx.showModal({
      title: '解绑这台电脑？',
      content: '解绑后它不再归你这个账号，但电脑端不受影响，下次心跳会重新出现（未归属）。',
      confirmText: '解绑',
      confirmColor: '#e0846f',
      success: function (r) {
        if (!r.confirm) return;
        relay.deviceRemove(code).then(function () {
          wx.showToast({ title: '已解绑', icon: 'success' });
          self.reloadDevices();
        }).catch(function (err) {
          wx.showToast({ title: (err && err.message) || '解绑失败', icon: 'none' });
        });
      }
    });
  },

  deleteDevice: function (e) {
    var self = this;
    var code = e.currentTarget.dataset.code;
    wx.showModal({
      title: '彻底删除这台电脑？',
      content: '会从云端抹掉记录。电脑端不受影响，但下次心跳会重新出现（未归属），需要重新用配对码接入。',
      confirmText: '删除',
      confirmColor: '#e0846f',
      success: function (r) {
        if (!r.confirm) return;
        relay.deviceDelete(code).then(function () {
          wx.showToast({ title: '已删除', icon: 'success' });
          self.reloadDevices();
        }).catch(function (err) {
          wx.showToast({ title: (err && err.message) || '删除失败', icon: 'none' });
        });
      }
    });
  },
  renameDevice: function (e) {
    var self = this;
    var code = e.currentTarget.dataset.code;
    var cur = e.currentTarget.dataset.name || '';
    wx.showModal({
      title: '给这台电脑起个名',
      editable: true,
      placeholderText: cur || '例如：工位台式机',
      success: function (r) {
        if (!r.confirm) return;
        relay.deviceRename(code, (r.content || '').trim()).then(function () {
          wx.showToast({ title: '已改名', icon: 'success' });
          self.reloadDevices();
        }).catch(function (err) {
          wx.showToast({ title: (err && err.message) || '改名失败', icon: 'none' });
        });
      }
    });
  },
  // ---- 开发者 ----
  // 连点底部版本号 5 次展开/收起
  tapTitle: function () {
    var n = (this._taps || 0) + 1;
    if (n >= 5 || this.data.devOpen) {
      // 已经展开时，点一下就收起
      this._taps = 0;
      this.setData({ devOpen: !this.data.devOpen, tapHint: false, tapsLeft: 5 });
      return;
    }
    this._taps = n;
    this.setData({ tapHint: true, tapsLeft: 5 - n });
    // 两秒没继续点就把提示收起来
    var self = this;
    if (this._hintTimer) clearTimeout(this._hintTimer);
    this._hintTimer = setTimeout(function () {
      self._taps = 0;
      self.setData({ tapHint: false, tapsLeft: 5 });
    }, 2000);
  },

  resetLoggedOut: function () {
    wx.showModal({
      title: '恢复默认？',
      content: '会清掉本机的账号、配对码、命令历史和会话列表，回到首次打开的未登录状态。云端的账号记录不动。',
      confirmText: '清掉',
      confirmColor: '#e0846f',
      success: function (res) {
        if (res.confirm) this.doReset(false);
      }.bind(this)
    });
  },

  resetWipeAll: function () {
    wx.showModal({
      title: '全部清空？',
      content: '把这台设备上小程序存的所有数据都清掉（包括以后新加的缓存）。云端账号记录同样不受影响。',
      confirmText: '全部清空',
      confirmColor: '#e0846f',
      success: function (res) {
        if (res.confirm) this.doReset(true);
      }.bind(this)
    });
  },

  doReset: function (wipeAll) {
    var removed = user.resetToLoggedOut({ wipeAll: wipeAll });
    this._justReset = true;
    this._taps = 0;
    var names = removed.length ? removed.join(', ') : '（本来就没有缓存）';
    this.setData({
      signedOut: true,
      resetInfo: '已清除 ' + removed.length + ' 项：' + names +
        '\n重新登录会沿用同一个微信身份。',
      initials: '登',
      displayName: '未登录',
      uidShort: '',
      email: '',
      nickname: '',
      devices: [],
      hint: '已恢复默认'
    });
    wx.showToast({ title: '已恢复默认', icon: 'success' });
    setTimeout(function () {
      wx.reLaunch({ url: '/pages/login/login' });
    }, 700);
  }
});
