var user = require('../../utils/user.js');

Page({
  data: {
    mode: 'choose',      // choose | phone | email
    phone: '',
    code: '',
    email: '',
    pwd: '',
    busy: false,
    countdown: 0,
    hint: ''
  },

  onLoad: function () {
    if (user.isLoggedIn()) {
      wx.reLaunch({ url: '/pages/index/index' });
    }
  },

  // 微信一键登录
  wechatLogin: function () {
    var self = this;
    if (this.data.busy) return;
    this.setData({ busy: true, hint: '' });
    user.signIn().then(function () {
      wx.reLaunch({ url: '/pages/index/index' });
    }).catch(function (e) {
      self.setData({ busy: false, hint: '登录失败：' + ((e && e.message) || e) });
    });
  },

  // 这两个入口先留着，但还没打通，点了明确告诉用户
  showPhone: function () {
    wx.showModal({
      title: '暂不支持',
      content: '手机号登录还在接入短信服务，暂时用不了。\n请先用「微信一键登录」进来。',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  showEmail: function () {
    wx.showModal({
      title: '暂不支持',
      content: '邮箱密码登录还没开放。\n请先用「微信一键登录」进来，之后在「账号」页可以设邮箱和密码。',
      showCancel: false,
      confirmText: '知道了'
    });
  },
  showChoose: function () { this.setData({ mode: 'choose', hint: '' }); },

  onPhone: function (e) { this.setData({ phone: e.detail.value }); },
  onCode: function (e) { this.setData({ code: e.detail.value }); },
  onEmail: function (e) { this.setData({ email: e.detail.value }); },
  onPwd: function (e) { this.setData({ pwd: e.detail.value }); },

  // 发验证码
  sendCode: function () {
    var self = this;
    var phone = (this.data.phone || '').trim();
    if (!/^1[3-9]\d{9}$/.test(phone)) { this.setData({ hint: '手机号格式不对' }); return; }
    if (this.data.countdown > 0) return;
    this.setData({ hint: '正在发送…' });
    user.sendCode(phone).then(function (r) {
      self.setData({ hint: '验证码已发送，5 分钟内有效' });
      self.startCountdown();
    }).catch(function (e) {
      var msg = (e && e.message) || '发送失败';
      if (msg.indexOf('还没配置') >= 0) {
        wx.showModal({
          title: '短信服务没开通',
          content: '云端 SMS_* 四项还是空的。需要主人在腾讯云开通短信服务，拿到应用 ID、签名、模板后填进云函数。',
          showCancel: false
        });
      }
      self.setData({ hint: msg });
    });
  },

  startCountdown: function () {
    var self = this;
    this.setData({ countdown: 60 });
    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(function () {
      var n = self.data.countdown - 1;
      self.setData({ countdown: n });
      if (n <= 0) { clearInterval(self._timer); self._timer = null; }
    }, 1000);
  },

  onUnload: function () { if (this._timer) clearInterval(this._timer); },

  // 手机号 + 验证码登录
  phoneLogin: function () {
    var self = this;
    if (this.data.busy) return;
    var phone = (this.data.phone || '').trim();
    var code = (this.data.code || '').trim();
    if (!phone || !code) { this.setData({ hint: '手机号和验证码都要填' }); return; }
    this.setData({ busy: true, hint: '' });
    user.phoneLogin(phone, code).then(function () {
      wx.reLaunch({ url: '/pages/index/index' });
    }).catch(function (e) {
      self.setData({ busy: false, hint: (e && e.message) || '登录失败' });
    });
  },

  emailLogin: function () {
    var self = this;
    if (this.data.busy) return;
    var email = (this.data.email || '').trim();
    var pwd = this.data.pwd || '';
    if (!email || !pwd) { this.setData({ hint: '邮箱和密码都要填' }); return; }
    this.setData({ busy: true, hint: '' });
    user.loginWithPassword(email, pwd).then(function () {
      wx.reLaunch({ url: '/pages/index/index' });
    }).catch(function (e) {
      self.setData({ busy: false, hint: (e && e.message) || '登录失败' });
    });
  }
});
