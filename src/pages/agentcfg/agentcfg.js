var net = require('../../utils/net.js');

Page({
  data: {
    list: [],
    loading: true,
    err: '',
    // 编辑态
    editing: false,
    editId: '',
    editLabel: '',
    editContent: '',
    editMasked: false,
    saving: false
  },

  onLoad: function () {
    this.load();
  },

  load: function () {
    var self = this;
    if (!net.lanBase()) {
      this.setData({ loading: false, err: '需要先配置局域网直连（首页 → 局域网直连）' });
      return;
    }
    this.setData({ loading: true, err: '' });
    net.lanRequest('/configs', 'GET', {}).then(function (r) {
      self.setData({ list: (r && r.list) || [], loading: false });
    }).catch(function (e) {
      self.setData({ loading: false, err: '连不上电脑：' + (e && e.message ? e.message : e) });
    });
  },

  openItem: function (e) {
    var self = this;
    var id = e.currentTarget.dataset.id;
    var label = e.currentTarget.dataset.label;
    var agent = e.currentTarget.dataset.agent;
    wx.showLoading({ title: '读取中…' });
    net.lanRequest('/config_read', 'POST', { id: id }).then(function (r) {
      wx.hideLoading();
      if (!r || !r.ok) {
        wx.showToast({ title: (r && r.error) || '读取失败', icon: 'none' });
        return;
      }
      self.setData({
        editing: true,
        editId: id,
        editLabel: agent + ' · ' + label,
        editContent: r.content || '',
        editMasked: !!r.masked
      });
    }).catch(function (e) {
      wx.hideLoading();
      wx.showToast({ title: '读取失败', icon: 'none' });
    });
  },

  onEdit: function (e) {
    this.setData({ editContent: e.detail.value });
  },

  cancelEdit: function () {
    this.setData({ editing: false, editId: '', editContent: '' });
  },

  saveEdit: function () {
    var self = this;
    if (this.data.saving) return;
    wx.showModal({
      title: '保存到电脑？',
      content: '会先备份一份原文件。带「•••」的密钥值会自动保留，不会被覆盖。',
      confirmText: '保存',
      success: function (res) {
        if (!res.confirm) return;
        self.setData({ saving: true });
        net.lanRequest('/config_write', 'POST', {
          id: self.data.editId,
          content: self.data.editContent
        }).then(function (r) {
          self.setData({ saving: false });
          if (r && r.ok) {
            wx.showToast({ title: '已保存', icon: 'success' });
            self.setData({ editing: false });
            self.load();
          } else {
            wx.showToast({ title: (r && r.error) || '写入失败', icon: 'none' });
          }
        }).catch(function (e) {
          self.setData({ saving: false });
          wx.showToast({ title: '写入失败：' + (e && e.message ? e.message : e), icon: 'none' });
        });
      }
    });
  },

  copyContent: function () {
    wx.setClipboardData({ data: this.data.editContent });
  }
});
