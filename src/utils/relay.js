// 快传 · 数据层 v0.4（云开发中转）
// 手机小程序 ←→ 云数据库 commands 集合 ←→ 电脑端 exe 轮询
// 连不上云开发时自动退回模拟模式，保证界面可演示

var KEYS = { mock: 'kc_mock', deviceCode: 'kc_device_code', history: 'kc_history' };
var COLL_CMD = 'commands';
var COLL_DEV = 'devices';
var STATUS_TEXT = { pending: '排队中', running: '执行中', done: '完成', error: '失败', timeout: '超时' };

function isMock() {
  var v = wx.getStorageSync(KEYS.mock);
  return v === '' || v === undefined ? false : !!v;
}
function setMock(v) { wx.setStorageSync(KEYS.mock, !!v); }

function getDeviceCode() { return wx.getStorageSync(KEYS.deviceCode) || ''; }
function setDeviceCode(c) { wx.setStorageSync(KEYS.deviceCode, c || ''); }

var FN = 'kuaichuan-fn';

// 统一走云函数（中继），不直接碰数据库
function call(action, payload) {
  if (!wx.cloud || !wx.cloud.callFunction) {
    return Promise.reject(new Error('当前环境没有 wx.cloud.callFunction'));
  }
  var data = { action: action };
  for (var k in (payload || {})) data[k] = payload[k];
  return wx.cloud.callFunction({ name: FN, data: data }).then(function (res) {
    var r = (res && res.result) || {};
    if (!r.ok) throw new Error(r.error || '云函数返回失败');
    return r;
  });
}

// ---- 设备列表（电脑端 exe 心跳写进来的）----
function listDevices() {
  return call('devices', {}).then(function (r) {
    return r.list || [];
  }).catch(function () {
    return [];
  });
}

// ---- 本地历史缓存 ----
function getHistory() {
  var h = wx.getStorageSync(KEYS.history);
  return Array.isArray(h) ? h : [];
}
function saveRecord(rec) {
  var h = getHistory();
  h.unshift(rec);
  wx.setStorageSync(KEYS.history, h.slice(0, 50));
  return rec;
}
function updateRecord(id, patch) {
  var h = getHistory();
  for (var i = 0; i < h.length; i++) {
    if (h[i].id === id) { for (var k in patch) h[i][k] = patch[k]; break; }
  }
  wx.setStorageSync(KEYS.history, h);
}
function getRecord(id) {
  var h = getHistory();
  for (var i = 0; i < h.length; i++) if (h[i].id === id) return h[i];
  return null;
}
function clearHistory() { wx.setStorageSync(KEYS.history, []); }

// ---- 模拟电脑 ----
function mockStdout(cmd) {
  var c = String(cmd || '').trim(), low = c.toLowerCase();
  if (low === 'whoami') return 'fulushou-pc\\qingpei';
  if (low === 'ls' || low === 'dir') return 'Desktop\nDocuments\nDownloads\nprojects';
  if (low.indexOf('echo ') === 0) return c.slice(5);
  return '[模拟] 已在 "' + c + '" 上执行（没连上真电脑）';
}

function runMock(rec) {
  var id = rec.id;
  setTimeout(function () {
    updateRecord(id, { status: 'running' });
    setTimeout(function () {
      updateRecord(id, { status: 'done', stdout: mockStdout(rec.payload), exitCode: 0, mock: true });
    }, 800);
  }, 300);
}

// ---- 发一条命令 ----
function run(cmd) {
  var id = 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
  var rec = {
    id: id,
    kind: 'shell',
    payload: cmd,
    status: 'pending',
    createdAt: Date.now(),
    stdout: '',
    stderr: ''
  };
  saveRecord(rec);

  var code = getDeviceCode();

  if (isMock() || !code) {
    updateRecord(id, { mock: true });
    runMock(rec);
    return Promise.resolve(rec);
  }

  updateRecord(id, { status: 'running' });
  return call('send', { deviceCode: code, kind: 'shell', payload: cmd }).then(function (r) {
    updateRecord(id, { docId: r.id });
    return poll(id, r.id, 0);
  }).catch(function (err) {
    updateRecord(id, { status: 'error', stderr: '调用云函数失败：' + ((err && err.message) || err) });
    return getRecord(id);
  });
}

function poll(localId, docId, n) {
  if (n > 25) {
    updateRecord(localId, { status: 'timeout', stderr: '等了 20 秒没有电脑回应，检查电脑端 exe 是否在跑' });
    return Promise.resolve(getRecord(localId));
  }
  if (!docId) return Promise.resolve(getRecord(localId));
  return call('get', { id: docId }).then(function (res) {
    var r = res.doc || {};
    updateRecord(localId, {
      status: r.status || 'pending',
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      exitCode: r.exitCode,
      ms: r.ms
    });
    if (r.status === 'done' || r.status === 'error' || r.status === 'timeout') return getRecord(localId);
    return new Promise(function (resolve) {
      setTimeout(function () { resolve(poll(localId, docId, n + 1)); }, 800);
    });
  }).catch(function () {
    return new Promise(function (resolve) {
      setTimeout(function () { resolve(poll(localId, docId, n + 1)); }, 800);
    });
  });
}

// 云开发自检：能建连接、能读集合就算正常，返回具体错误方便排查
function termSend(data) {
  return call('term_send', { deviceCode: getDeviceCode(), data: data });
}
function termRead(from) {
  return call('term_read', { from: from || 0 });
}
function termSetShell(shell) {
  return call('term_shell_set', { deviceCode: getDeviceCode(), shell: shell });
}
function termGetShell() {
  return call('term_shell_get', { deviceCode: getDeviceCode() });
}
function termRestart() {
  return call('term_restart', { deviceCode: getDeviceCode() });
}
// ---- 智能体对话：局域网直连优先，不可达时回退云端 ----
// 两条路径的返回值统一成 { ok, reply } / { ok, id } 的形式，界面不用关心走哪条
function agentAsk(agent, exe, text) {
  var net = require('./net.js');
  return net.pick().then(function (mode) {
    if (mode === 'lan') {
      // 本地一次请求就拿答案，没有轮询
      return net.lanRequest('/agent', 'POST', { exe: exe, agent: agent, text: text })
        .then(function (r) {
          if (!r || !r.ok) throw new Error((r && r.error) || '本地执行失败');
          return { ok: true, mode: 'lan', reply: (r.reply || '').trim() || '（没有输出）' };
        })
        .catch(function (e) {
          // 本地刚探测通过了却请求失败，强制重探后交给云端
          return net.pick(true).then(function () {
            throw new Error(e && e.message ? e.message : '本地失败');
          });
        });
    }
    // 云端：投递 + 轮询
    return call('agent_send', { deviceCode: getDeviceCode(), agent: agent, exe: exe, text: text })
      .then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || '投递失败');
        return { ok: true, mode: 'cloud', id: r.id };
      });
  });
}
function agentSend(agent, exe, text, headless) {
  return call('agent_send', { deviceCode: getDeviceCode(), agent: agent, exe: exe, text: text, headless: headless ? '1' : '0' });
}
function agentResult(id) {
  return call('agent_result', { id: id });
}
function cloudProbe() {
  return new Promise(function (resolve) {
    if (!wx.cloud) {
      resolve({ ok: false, msg: '当前环境没有 wx.cloud' });
      return;
    }
    var d = null;
    try { d = wx.cloud.database(); } catch (e) {
      resolve({ ok: false, msg: 'database() 失败: ' + (e && e.message ? e.message : e) });
      return;
    }
    if (!d) { resolve({ ok: false, msg: 'database() 返回空' }); return; }
    d.collection('commands').count().then(function (r) {
      resolve({ ok: true, msg: '云开发正常，commands 共 ' + (r && r.total) + ' 条' });
    }).catch(function (e) {
      resolve({ ok: false, msg: '读 commands 失败: ' + ((e && e.errMsg) || (e && e.message) || e) });
    });
  });
}

module.exports = {
  termSend: termSend,
  termRead: termRead,
  termSetShell: termSetShell,
  termGetShell: termGetShell,
  termRestart: termRestart,
  agentAsk: agentAsk,
  agentSend: agentSend,
  agentResult: agentResult,
  cloudProbe: cloudProbe,
  STATUS_TEXT: STATUS_TEXT,
  isMock: isMock,
  setMock: setMock,
  getDeviceCode: getDeviceCode,
  setDeviceCode: setDeviceCode,
  listDevices: listDevices,
  run: run,
  getHistory: getHistory,
  getRecord: getRecord,
  clearHistory: clearHistory
};