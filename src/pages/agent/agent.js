var relay = require('../../utils/relay.js');

var STORE = 'kc_chats';

// 从回复里抽文件路径，做成小标签
// 只认常见的代码/文本扩展名，避免把普通英文单词当文件名
var FILE_RE = /(?:^|[\s`"'(\[])((?:[\w.@-]+[\/\\])*[\w.@-]+\.(?:js|ts|jsx|tsx|json|md|py|rs|go|java|kt|c|cpp|h|hpp|cs|rb|php|sh|ps1|bat|yml|yaml|toml|ini|cfg|conf|txt|html|css|scss|vue|sql|xml))(?=[\s`"'),;:\]\}]|$)/g;

function extractFiles(text) {
  if (!text) return [];
  var seen = {};
  var out = [];
  var m;
  FILE_RE.lastIndex = 0;
  while ((m = FILE_RE.exec(text)) !== null) {
    var f = m[1];
    // 太长的多半是误匹配
    if (f.length > 80) continue;
    if (seen[f]) continue;
    seen[f] = 1;
    out.push(f);
    if (out.length >= 6) break;
  }
  return out;
}
var SID_SEQ = 1;

function nowTime() {
  var d = new Date();
  var h = d.getHours(), m = d.getMinutes();
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}

function initialOf(name) {
  var s = String(name || '?').replace(/[^A-Za-z\u4e00-\u9fa5]/g, '');
  return (s.charAt(0) || '?').toUpperCase();
}

Page({
  data: {
    agents: [],
    online: false,
    deviceName: '',
    sessions: [],
    currentId: '',
    currentAgent: '',
    messages: [],
    draft: '',
    busy: false,
    drawerOpen: false,
    pickerOpen: false,
    modeLabel: '',
    pushQuota: 0,
    busySec: 0,
    busyText: '对方正在输入…',
    anchor: 'end'
  },

  onLoad: function (options) {
    this.setData({ sid: (options && options.sid) || 'a1' });
    var saved = wx.getStorageSync(STORE);
    if (saved && saved.length) {
      this.setData({
        sessions: saved,
        currentId: saved[0].id,
        currentAgent: saved[0].agent,
        messages: saved[0].messages || []
      });
    }
    this.loadAgents();
  },

  onHide: function () { this.stopBusyTimer(); },
  onUnload: function () { this.stopBusyTimer(); },

  onShow: function () {
    this.loadAgents();
    this.refreshMode();
    this.refreshPush();
  },

  goConfig: function () {
    this.setData({ drawerOpen: false });
    wx.navigateTo({ url: '/pages/agentcfg/agentcfg' });
  },

  // ---- 跑完叫我 ----
  // 小程序订阅消息在教育体验版不可用（云端实测 -501001），
  // 所以这里是「预约一次提醒」，由云函数通过 webhook 推出来。
  tapBell: function () {
    var self = this;
    wx.showModal({
      title: '跑完叫我',
      content: '预约一次提醒：agent 回话时通过推送通道通知你，微信里能收到。每次预约提醒一次。',
      confirmText: '预约',
      success: function (res) {
        if (!res.confirm) return;
        relay.pushGrant().then(function (r) {
          var q = (r && r.quota) || 0;
          self.setData({ pushQuota: q });
          if (r && r.templateReady === false) {
            wx.showModal({
              title: '通知通道没配',
              content: '云端还没填 PUSH_CHANNEL / PUSH_KEY（Server酱或 PushPlus 的 key），所以现在发不出来。额度已经记下了，配好就能用。',
              showCancel: false
            });
            return;
          }
          wx.showToast({ title: '已预约，剩 ' + q + ' 次', icon: 'success' });
        }).catch(function (e) {
          wx.showToast({ title: '预约失败', icon: 'none' });
        });
      }
    });
  },

  refreshPush: function () {
    var self = this;
    relay.pushStatus().then(function (r) {
      self.setData({ pushQuota: (r && r.quota) || 0 });
    }).catch(function () {});
  },
  refreshMode: function () {
    var self = this;
    var net = require('../../utils/net.js');
    net.pick().then(function (mode) {
      self.setData({ modeLabel: mode === 'lan' ? '局域网直连' : '云端中转' });
    });
  },

  loadAgents: function () {
    var self = this;
    var code = relay.getDeviceCode();
    relay.listDevices().then(function (list) {
      var hit = null;
      for (var i = 0; i < list.length; i++) if (list[i].deviceCode === code) hit = list[i];
      if (!hit && list.length) hit = list[0];
      var agents = ((hit && hit.agents) || []).map(function (a) {
        var exe = a.path || a.exe || '';
        var lower = String(exe).toLowerCase();
        // 支持「单次提问→纯文本」的智能体，chat 走这条路最稳
        var headless = (lower.indexOf('dsh') >= 0 || lower.indexOf('codex') >= 0 || lower.indexOf('hermes') >= 0) ? '1' : '0';
        return { name: a.name, exe: exe, version: a.version, initial: initialOf(a.name), headless: headless };
      });
      self.setData({
        agents: agents,
        online: !!hit,
        deviceName: hit ? (hit.name || hit.deviceCode) : ''
      });
      // 顺手自动发现局域网，通了就切直连，不用用户配
      var net = require('../../utils/net.js');
      net.autoDiscover(list).then(function () { self.refreshMode(); }).catch(function () {});
    }).catch(function () {});
  },

  // ---- 会话 ----
  persist: function () {
    var s = this.data.sessions;
    for (var i = 0; i < s.length; i++) {
      if (s[i].id === this.data.currentId) {
        s[i].messages = this.data.messages;
        var last = this.data.messages[this.data.messages.length - 1];
        s[i].preview = last ? last.text.slice(0, 20) : '';
      }
    }
    this.setData({ sessions: s });
    wx.setStorageSync(STORE, s);
  },

  newChatFor: function (agentName) {
    var id = 's' + (SID_SEQ++) + '_' + Date.now();
    var sess = { id: id, agent: agentName, preview: '', messages: [] };
    var list = [sess].concat(this.data.sessions);
    this.setData({
      sessions: list,
      currentId: id,
      currentAgent: agentName,
      messages: [],
      drawerOpen: false
    });
    wx.setStorageSync(STORE, list);
  },

  newChat: function () {
    this.setData({ drawerOpen: false });
    if (!this.data.currentAgent && this.data.agents.length) {
      this.newChatFor(this.data.agents[0].name);
    } else if (this.data.currentAgent) {
      this.newChatFor(this.data.currentAgent);
    } else {
      this.setData({ pickerOpen: true });
    }
  },

  switchChat: function (e) {
    var id = e.currentTarget.dataset.id;
    var s = null;
    for (var i = 0; i < this.data.sessions.length; i++) {
      if (this.data.sessions[i].id === id) s = this.data.sessions[i];
    }
    if (!s) return;
    this.setData({
      currentId: id,
      currentAgent: s.agent,
      messages: s.messages || [],
      drawerOpen: false
    });
    this.scrollEnd();
  },

  openDrawer: function () { this.setData({ drawerOpen: true }); },
  closeDrawer: function () { this.setData({ drawerOpen: false }); },

  // ---- 智能体 ----
  openPicker: function () { this.setData({ pickerOpen: true }); },
  closePicker: function () { this.setData({ pickerOpen: false }); },

  pickAgent: function (e) {
    var name = e.currentTarget.dataset.name;
    var exe = e.currentTarget.dataset.exe;
    var hl = e.currentTarget.dataset.headless || '0';
    this.setData({ pickerOpen: false });
    this.rememberAgent(name, exe, hl);
    // 换成该智能体最近一个会话，没有就新建
    for (var i = 0; i < this.data.sessions.length; i++) {
      if (this.data.sessions[i].agent === name) {
        this.setData({
          currentId: this.data.sessions[i].id,
          currentAgent: name,
          messages: this.data.sessions[i].messages || []
        });
        this.scrollEnd();
        return;
      }
    }
    this.newChatFor(name);
  },

  exeOf: function (name, exe) {
    this.exeMap = this.exeMap || {};
    this.exeMap[name] = exe;
  },

  rememberAgent: function (name, exe, headless) {
    this.exeMap = this.exeMap || {};
    this.exeHeadless = this.exeHeadless || {};
    this.exeMap[name] = exe;
    this.exeHeadless[name] = headless;
  },

  // ---- 发送 ----
  onInput: function (e) { this.setData({ draft: e.detail.value }); },

  send: function () {
    var self = this;
    var text = (this.data.draft || '').trim();
    if (!text) return;
    if (!this.data.currentAgent) {
      this.setData({ pickerOpen: true });
      return;
    }
    if (!this.data.currentId) this.newChatFor(this.data.currentAgent);

    var msg = { id: 'm' + Date.now(), role: 'me', text: text, time: nowTime() };
    var list = this.data.messages.concat([msg]).concat([
      { id: 'r' + Date.now(), role: 'ai', text: '', time: '' }
    ]);
    this.setData({ messages: list, draft: '', busy: true, anchor: 'end', busySec: 0, busyText: '对方正在输入…' });
    this.startBusyTimer();
    this.persist();

    // 自动分流：同一局域网走本地直连，否则走云端中转
    var exe = (this.exeMap && this.exeMap[this.data.currentAgent]) || this.data.currentAgent;
    relay.agentAsk(this.data.currentAgent, exe, text).then(function (r) {
      if (!r || !r.ok) {
        self.fillReply('（发送失败：' + ((r && r.error) || '未知错误') + '）');
        return;
      }
      self.setData({ modeLabel: r.mode === 'lan' ? '局域网直连' : '云端中转' });
      if (r.mode === 'lan') {
        // 本地一次就拿到答案，不用轮询
        self.fillReply(r.reply);
      } else {
        self.pollAgent(r.id);
      }
    }).catch(function (err) {
      self.fillReply('（发送失败：' + (err && err.message ? err.message : err) + '）');
    });
  },

  pollAgent: function (id) {
    var self = this;
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      relay.agentResult(id).then(function (r) {
        var doc = (r && r.doc) || {};
        if (doc.status === 'done') {
          clearInterval(timer);
          self.fillReply((doc.reply || '').trim() || '（没有输出）');
        } else if (tries > 360) {
          clearInterval(timer);
          self.fillReply('（超时，电脑端没有回应）');
        }
      }).catch(function () {});
    }, 500);
  },

  pollResult: function (recId, myId) {
    var self = this;
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      var r = relay.getRecord(recId);
      if (r && (r.status === 'done' || r.status === 'error' || r.status === 'timeout')) {
        clearInterval(timer);
        var out = (r.stdout || '').trim() || (r.stderr || '').trim() || '（没有输出）';
        self.fillReply(out);
      } else if (tries > 60) {
        clearInterval(timer);
        self.fillReply('（超时，电脑端没有回应）');
      }
    }, 1000);
  },

  // 跑起来的时候显示已耗时，让人知道它没死
  startBusyTimer: function () {
    var self = this;
    this.stopBusyTimer();
    var t0 = Date.now();
    this._busyTimer = setInterval(function () {
      var sec = Math.floor((Date.now() - t0) / 1000);
      self.setData({
        busySec: sec,
        busyText: sec < 3 ? '对方正在输入…' : (sec < 20 ? '正在干活…' : '还在跑，别急…')
      });
    }, 1000);
  },

  stopBusyTimer: function () {
    if (this._busyTimer) {
      clearInterval(this._busyTimer);
      this._busyTimer = null;
    }
  },

  fillReply: function (text) {
    this.stopBusyTimer();
    var files = extractFiles(text);
    var msgs = this.data.messages.slice();
    if (msgs.length && msgs[msgs.length - 1].role === 'ai') {
      msgs[msgs.length - 1].text = text;
      msgs[msgs.length - 1].time = nowTime();
      msgs[msgs.length - 1].files = files;
    } else {
      msgs.push({ id: 'a' + Date.now(), role: 'ai', text: text, time: nowTime(), files: files });
    }
    this.setData({ messages: msgs, busy: false, busySec: 0 });
    this.persist();
    this.scrollEnd();
  },

  scrollEnd: function () {
    var self = this;
    this.setData({ anchor: '' });
    setTimeout(function () {
      var msgs = self.data.messages;
      self.setData({ anchor: msgs.length ? 'end' : '' });
    }, 60);
  }
});
