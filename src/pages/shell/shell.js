var relay = require('../../utils/relay.js');

var LABELS = { gitbash: 'Git Bash', cmd: 'CMD', powershell: 'PowerShell' };

Page({
  data: {
    shell: 'gitbash',
    online: false,
    connectedName: '',
    hint: ''
  },

  onLoad: function () {
    var saved = wx.getStorageSync('kc_shell') || 'gitbash';
    var self = this;
    this.setData({ shell: saved });
    // 顺便刷一下设备在线状态
    relay.listDevices().then(function (list) {
      var code = relay.getDeviceCode();
      var hit = null;
      for (var i = 0; i < list.length; i++) if (list[i].deviceCode === code) hit = list[i];
      self.setData({
        online: !!hit,
        connectedName: hit ? (hit.name || hit.deviceCode) : ''
      });
    }).catch(function () {});
  },

  pick: function (e) {
    var sh = e.currentTarget.dataset.shell;
    var self = this;
    this.setData({ shell: sh, hint: '正在切换…' });
    wx.setStorageSync('kc_shell', sh);
    relay.termSetShell(sh).then(function () {
      self.setData({ hint: '已切到 ' + (LABELS[sh] || sh) });
      setTimeout(function () {
        wx.navigateTo({ url: '/pages/terminal/terminal' });
      }, 900);
    }).catch(function () {
      self.setData({ hint: '切换失败，检查电脑端是否在线' });
    });
  },

  back: function () { wx.navigateBack(); }
});
