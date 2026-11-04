// 快传 · 通道选择器
// 每次请求先探测本地 exe 是否可达：
//   - 可达  → 走局域网直连（快，不花钱，不看云端余额）
//   - 不可达 → 回退云函数中转（异地可用）
// 探测结果缓存一小段时间，避免每条消息都多打一次请求。

var KEYS = { lanHost: 'kc_lan_host', lanToken: 'kc_lan_token', lastMode: 'kc_last_mode' };

var LAN_TTL = 3000; // 探测结果缓存 3 秒
var LAN_TIMEOUT = 1200; // 单次探测超时

var lanCache = { at: 0, ok: false };
var listeners = [];

function getLanHost() { return wx.getStorageSync(KEYS.lanHost) || ''; }
function setLanHost(h) {
  wx.setStorageSync(KEYS.lanHost, h || '');
  lanCache.at = 0; // 换地址后立刻重探
}
function getLanToken() { return wx.getStorageSync(KEYS.lanToken) || ''; }
function setLanToken(t) {
  wx.setStorageSync(KEYS.lanToken, t || '');
  lanCache.at = 0;
}

function lanBase() {
  var h = getLanHost();
  if (!h) return '';
  if (h.indexOf('http') === 0) return h.replace(/\/+$/, '');
  return 'http://' + h.replace(/\/+$/, '');
}

// ---- 当前模式 ----
function currentMode() {
  return lanCache.ok ? 'lan' : 'cloud';
}
function modeLabel() {
  return lanCache.ok ? '局域网直连' : '云端中转';
}
function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }
function emit() {
  for (var i = 0; i < listeners.length; i++) {
    try { listeners[i](currentMode()); } catch (e) {}
  }
}

// ---- 探测：本地 exe 的 /ping 是否需要 token 都能通 ----
function probeLan() {
  var base = lanBase();
  if (!base) return Promise.resolve(false);

  return new Promise(function (resolve) {
    var settled = false;
    function done(ok) {
      if (settled) return;
      settled = true;
      var changed = ok !== lanCache.ok;
      lanCache = { at: Date.now(), ok: ok };
      if (changed) emit();
      resolve(ok);
    }

    var timer = setTimeout(function () { done(false); }, LAN_TIMEOUT);
    try {
      wx.request({
        url: base + '/ping',
        method: 'GET',
        timeout: LAN_TIMEOUT,
        success: function (res) {
          clearTimeout(timer);
          done(!!(res && res.statusCode === 200 && res.data && res.data.ok));
        },
        fail: function () { clearTimeout(timer); done(false); }
      });
    } catch (e) {
      clearTimeout(timer);
      done(false);
    }
  });
}

// 带缓存的探测；force=true 时强制重探
function pick(force) {
  var base = lanBase();
  if (!base) return Promise.resolve('cloud');
  if (!force && Date.now() - lanCache.at < LAN_TTL) {
    return Promise.resolve(currentMode());
  }
  return probeLan().then(function (ok) { return ok ? 'lan' : 'cloud'; });
}

// ---- 本地请求 ----
function lanRequest(path, method, data) {
  var base = lanBase();
  return new Promise(function (resolve, reject) {
    wx.request({
      url: base + path,
      method: method || 'GET',
      data: data || {},
      timeout: 60000,
      header: {
        'Content-Type': 'application/json',
        'X-KC-Token': getLanToken()
      },
      success: function (res) {
        var d = res && res.data;
        if (res.statusCode === 200 && d) resolve(d);
        else reject(new Error((d && d.error) || ('本地请求失败 ' + res.statusCode)));
      },
      fail: function (e) { reject(new Error('本地连接断开')); }
    });
  });
}

module.exports = {
  getLanHost: getLanHost,
  setLanHost: setLanHost,
  getLanToken: getLanToken,
  setLanToken: setLanToken,
  lanBase: lanBase,
  probeLan: probeLan,
  pick: pick,
  currentMode: currentMode,
  modeLabel: modeLabel,
  onChange: onChange,
  lanRequest: lanRequest
};
