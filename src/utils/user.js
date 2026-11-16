// 快传 · 账号
//
// 身份设计：uid 是内部稳定身份，和平台无关。
//   微信端  → openid 静默登录，换到 uid
//   以后 App / 网页 → 邮箱+密码登录，拿到同一个 uid
// 这样设备、数据跟着 uid 走，不会被微信绑死。
//
// 登录后拿到 token（30 天有效），之后所有请求都带它。

var KEYS = { user: 'kc_user', token: 'kc_token', signedOut: 'kc_signed_out' };
var FN = 'kuaichuan-fn';

function cached() {
  var u = wx.getStorageSync(KEYS.user);
  return (u && u.uid) ? u : null;
}
function getToken() {
  try { return wx.getStorageSync(KEYS.token) || ''; } catch (e) { return ''; }
}
function saveAuth(token, u) {
  if (token) wx.setStorageSync(KEYS.token, token);
  if (u && u.uid) wx.setStorageSync(KEYS.user, u);
  return u || null;
}
function clear() {
  wx.removeStorageSync(KEYS.user);
  wx.removeStorageSync(KEYS.token);
}
function isSignedOut() {
  try { return wx.getStorageSync(KEYS.signedOut) === true; } catch (e) { return false; }
}

function call(action, payload) {
  var data = { action: action, token: getToken() };
  for (var k in (payload || {})) data[k] = payload[k];
  if (!wx.cloud || !wx.cloud.callFunction) {
    return Promise.reject(new Error('当前环境没有 wx.cloud.callFunction'));
  }
  return wx.cloud.callFunction({ name: FN, data: data }).then(function (res) {
    var r = (res && res.result) || {};
    if (!r.ok) throw new Error(r.error || '请求失败');
    return r;
  });
}

// 微信内静默登录（幂等）
function ensureLogin(force) {
  var u = cached();
  if (u && getToken() && !force) return Promise.resolve(u);
  if (!force && isSignedOut()) return Promise.resolve(null);
  return call('auth', {}).then(function (r) {
    return saveAuth(r.token, r.user);
  });
}

// 邮箱 + 密码登录（App / 网页端用，小程序里也能用）
function loginWithPassword(email, pwd) {
  return call('login', { email: email, password: pwd }).then(function (r) {
    wx.removeStorageSync(KEYS.signedOut);
    return saveAuth(r.token, r.user);
  });
}

// 短信验证码
function sendCode(phone) {
  return call('send_code', { phone: phone });
}
function phoneLogin(phone, code) {
  return call('phone_login', { phone: phone, code: code }).then(function (r) {
    wx.removeStorageSync(KEYS.signedOut);
    return saveAuth(r.token, r.user);
  });
}
// 设密码：设完就能用邮箱登录，换设备也能找回
function setPassword(pwd) {
  return call('set_password', { password: pwd }).then(function () {
    var u = cached() || {};
    u.hasPassword = true;
    wx.setStorageSync(KEYS.user, u);
    return u;
  });
}

function signIn() {
  wx.removeStorageSync(KEYS.signedOut);
  return ensureLogin(true);
}

function current() { return cached(); }
function isLoggedIn() { return !!cached() && !!getToken(); }

function displayName() {
  var u = cached();
  if (!u) return '未登录';
  if (u.nickname) return u.nickname;
  if (u.email) return u.email;
  return '匿名用户';
}
function initials() {
  var u = cached();
  if (!u) return '?';
  var s = u.nickname || u.email || '';
  return s ? s.charAt(0).toUpperCase() : '匿';
}

function setEmail(email) {
  return call('user_set_email', { email: email }).then(function (r) {
    var u = cached() || {};
    u.email = r.email;
    wx.setStorageSync(KEYS.user, u);
    return u;
  });
}
function setNickname(nick) {
  return call('user_set_nickname', { nickname: nick }).then(function (r) {
    var u = cached() || {};
    u.nickname = r.nickname;
    wx.setStorageSync(KEYS.user, u);
    return u;
  });
}

// 恢复出厂：只清本地，不删云端账号
var RESET_KEYS = [
  'kc_user', 'kc_token', 'kc_device_code', 'kc_history', 'kc_setup_done',
  'kc_shell', 'kc_lan_host', 'kc_lan_token', 'kc_last_mode', 'kc_mock', 'kc_chats'
];
function resetToLoggedOut(opts) {
  var o = opts || {};
  var removed = [];
  if (o.wipeAll) {
    try {
      var info = wx.getStorageInfoSync();
      var keys = (info && info.keys) || [];
      for (var i = 0; i < keys.length; i++) { wx.removeStorageSync(keys[i]); }
      removed = keys;
    } catch (e) {}
  } else {
    for (var j = 0; j < RESET_KEYS.length; j++) {
      var k = RESET_KEYS[j];
      try {
        var v = wx.getStorageSync(k);
        if (v !== '' && v !== undefined && v !== null) removed.push(k);
        wx.removeStorageSync(k);
      } catch (e) {}
    }
  }
  // openid 清不掉，会一进首页就自动登回来，所以留个「主动退出」标记挡住
  try {
    wx.setStorageSync(KEYS.signedOut, true);
    removed.push('退出标记');
  } catch (e) {}
  return removed;
}

module.exports = {
  ensureLogin: ensureLogin,
  loginWithPassword: loginWithPassword,
  setPassword: setPassword,
  sendCode: sendCode,
  phoneLogin: phoneLogin,
  signIn: signIn,
  current: current,
  isLoggedIn: isLoggedIn,
  isSignedOut: isSignedOut,
  getToken: getToken,
  displayName: displayName,
  initials: initials,
  setEmail: setEmail,
  setNickname: setNickname,
  clear: clear,
  resetToLoggedOut: resetToLoggedOut
};
