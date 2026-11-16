// 快传 · 普通云函数中继（供 wx.cloud.callFunction 调用）
const ENV = 'eval-lifecycle-d7gf433u22f6c2405';
// 服务密钥由云函数环境变量 KC_API_KEY 注入；切勿写回源码或提交到版本库
const KEY = process.env.KC_API_KEY || "";
if (!KEY) console.error("[kuaichuan-fn] 未配置 KC_API_KEY");
const BASE = 'https://' + ENV + '.api.tcloudbasegateway.com/v1/database/instances/(default)/databases/(default)';
const CMD = 'commands';
const DEV = 'devices';

// 推送通道配置
//
// ⚠️ 小程序订阅消息在这个环境用不了：
//    实测 push_probe 返回 errCode=-501001
//    "subscribeMessage.getTemplateList:fail invalid wx openapi access_token"
//    教育体验版拿不到微信 openapi 的 access_token，所以走第三方 webhook 中转。
//
// 支持两家（都是免费、都是推到微信）：
//   serverchan  https://sct.ftqq.com  → key 形如 SCT123456Txxxxx
//   pushplus    https://www.pushplus.plus → key 是 32 位 token
// 留空则该功能静默关闭。
const PUSH_CHANNEL = '';
const PUSH_KEY = '';

async function db(method, path, body) {
  const opts = { method, headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(BASE + path, opts);
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) { return {}; }
}

// agent 跑完后推一条通知
// 没有通道配置、没有额度、发送失败都静默跳过，不能影响主流程
async function notifyAgentDone(deviceCode, replyText) {
  if (!PUSH_CHANNEL || !PUSH_KEY || !deviceCode) return;

  // 设备 → 归属人
  const dq = encodeURIComponent(JSON.stringify({ deviceCode: deviceCode }));
  const df = await db('GET', '/collections/' + DEV + '/documents?query=' + dq + '&limit=1');
  const dev = (df.list || [])[0];
  if (!dev || !dev.owner) return;

  // 归属人 → 剩余额度
  const uq = encodeURIComponent(JSON.stringify({ openid: dev.owner }));
  const uf = await db('GET', '/collections/users/documents?query=' + uq + '&limit=1');
  const u = (uf.list || [])[0];
  if (!u || !(u.pushQuota > 0)) return;

  const brief = String(replyText || '').replace(/\s+/g, ' ').trim().slice(0, 120) || '已完成';

  if (PUSH_CHANNEL === 'serverchan') {
    // Server酱：表单提交，title 必填
    await fetch('https://sctapi.ftqq.com/' + PUSH_KEY + '.send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'title=' + encodeURIComponent('快传 · 智能体跑完了') +
            '&desp=' + encodeURIComponent(brief),
    });
  } else if (PUSH_CHANNEL === 'pushplus') {
    await fetch('https://www.pushplus.plus/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: PUSH_KEY,
        title: '快传 · 智能体跑完了',
        content: brief,
        template: 'txt',
      }),
    });
  } else {
    return;
  }

  // 一次性额度，发完扣一次
  await db('PATCH', '/collections/users/documents', {
    query: { _id: u._id },
    data: { $set: { pushQuota: Math.max((u.pushQuota || 1) - 1, 0) } },
  });
}

exports.main = async (event) => {
  try {
    const a = (event && event.action) || 'poll';

    // 小程序调用时，云开发会把调用者身份放进环境变量 / event.userInfo。
    // 优先用 cloud.getWXContext()，取不到再退回 event.openid（方便本地调试）。
    // wx-server-sdk 很重，冷启动要 1-2 秒。
    // 只有 auth（要 openid）才需要它，login / devices 这些走 token 就行，
    // 所以改成按需加载，避免被拖到云函数 3 秒超时。
    let _openidCache;
    const getOpenid = () => {
      if (_openidCache !== undefined) return _openidCache;
      let ctx = {};
      try {
        const cloud = require('wx-server-sdk');
        cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
        ctx = cloud.getWXContext() || {};
      } catch (e) {
        ctx = {};
      }
      _openidCache = ctx.OPENID
        || (event && event.userInfo && event.userInfo.openId)
        || (event && event.openid)
        || '';
      return _openidCache;
    };

    // ---- 账号（身份与平台解耦）----
    //
    // 设计要点：uid 是内部稳定身份，openid 只是「登录方式之一」。
    // 以后出 App / 网页端，用邮箱+密码登录拿到同一个 uid，设备自动就在。
    // 不用微信也能用，这是关键。
    // 会话签名密钥由环境变量注入；未配置时登录类操作直接失败，避免弱密钥
    const SESS_SECRET = process.env.KC_SESS_SECRET;
    if (!SESS_SECRET) throw new Error("KC_SESS_SECRET 未配置");
    const crypto = require('crypto');

    const b64u = s => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const unb64u = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
    const sign = s => crypto.createHmac('sha256', SESS_SECRET).update(s).digest('hex').slice(0, 32);

    function issueToken(uid) {
      const body = uid + '|' + (Date.now() + 30 * 24 * 3600 * 1000); // 30 天
      return b64u(body) + '.' + sign(body);
    }
    function verifyToken(tok) {
      if (!tok || String(tok).indexOf('.') < 0) return '';
      const parts = String(tok).split('.');
      let body;
      try { body = unb64u(parts[0]); } catch (e) { return ''; }
      if (sign(body) !== parts[1]) return '';
      const seg = body.split('|');
      if (Number(seg[1]) < Date.now()) return '';
      return seg[0] || '';
    }
    // 迭代次数受云函数 3 秒超时限制，不能太高；1 万次约 10ms，冷启动也稳
    const hashPwd = (pwd, salt) => crypto.pbkdf2Sync(pwd, salt, 10000, 32, 'sha256').toString('hex');
    const newUid = () => 'u' + crypto.randomBytes(8).toString('hex');
    const newSalt = () => crypto.randomBytes(12).toString('hex');

    // CloudBase 会把整数/长整数包成 {$numberInt: n} 这种对象，
// 取出来时统一还原成普通数字，不然小程序拿到的是对象没法用
function numOf(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'object') {
    if (v.$numberInt != null) return Number(v.$numberInt) || 0;
    if (v.$numberLong != null) return Number(v.$numberLong) || 0;
    if (v.$numberDouble != null) return Number(v.$numberDouble) || 0;
  }
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

async function findUser(query) {
      const q = encodeURIComponent(JSON.stringify(query));
      const r = await db('GET', '/collections/users/documents?query=' + q + '&limit=1');
      return (r.list || [])[0] || null;
    }
    const userPublic = u => ({
      uid: u.uid || '',
      email: u.email || '',
      nickname: u.nickname || '',
      hasPassword: !!u.pwdHash,
    });

    // 用 token 解析出当前用户
    async function currentUser() {
      const uid = verifyToken(event.token);
      if (!uid) return null;
      return await findUser({ uid: uid });
    }

    // 微信内静默登录
    if (a === 'auth') {
      const callerOpenid = getOpenid();
      if (!callerOpenid) return { ok: false, error: '需要在微信内调用' };
      let u = await findUser({ openid: callerOpenid });
      if (!u) {
        const doc = {
          uid: newUid(), openid: callerOpenid, email: '', nickname: '',
          createdAt: Date.now(), lastSeen: Date.now(),
        };
        const r = await db('POST', '/collections/users/documents', { data: [doc] });
        u = Object.assign({ _id: (r.insertedIds || [])[0] }, doc);
        return { ok: true, token: issueToken(u.uid), user: userPublic(u), created: true };
      }
      if (u.banned) return { ok: false, error: '账号已被停用' };
      // 老记录没有 uid 的，就地升级
      if (!u.uid) {
        u.uid = newUid();
        await db('PATCH', '/collections/users/documents', {
          query: { _id: u._id }, data: { $set: { uid: u.uid } },
        });
      }
      await db('PATCH', '/collections/users/documents', {
        query: { _id: u._id }, data: { $set: { lastSeen: Date.now() } },
      });
      return { ok: true, token: issueToken(u.uid), user: userPublic(u), created: false };
    }

    // 邮箱 + 密码登录（App / 网页端走这条）
    if (a === 'login') {
      const email = String(event.email || '').trim().toLowerCase();
      const pwd = String(event.password || '');
      if (!email || !pwd) return { ok: false, error: '邮箱和密码都要填' };
      const u = await findUser({ email: email });
      if (!u || !u.pwdHash) return { ok: false, error: '邮箱或密码不对' };
      if (u.banned) return { ok: false, error: '账号已被停用' };
      if (hashPwd(pwd, u.pwdSalt) !== u.pwdHash) return { ok: false, error: '邮箱或密码不对' };
      await db('PATCH', '/collections/users/documents', {
        query: { _id: u._id }, data: { $set: { lastSeen: Date.now() } },
      });
      return { ok: true, token: issueToken(u.uid), user: userPublic(u) };
    }

    // ---- 手机号 + 短信验证码 ----
    //
    // 需要主人在腾讯云开通「短信服务」，拿到下面四项填进来：
    //   SMS_SECRET_ID / SMS_SECRET_KEY  腾讯云 API 密钥（要有短信权限）
    //   SMS_APPID                       短信应用 SdkAppId
    //   SMS_SIGN / SMS_TMPL             审核通过的签名名 和 模板 ID
    // 模板正文建议：您的验证码是 {1}，5 分钟内有效。
    const SMS_SECRET_ID = '';
    const SMS_SECRET_KEY = '';
    const SMS_APPID = '';
    const SMS_SIGN = '';
    const SMS_TMPL = '';
    const SMS_COLL = 'sms_codes_4759588622381809665';
    const SMS_READY = !!(SMS_SECRET_ID && SMS_SECRET_KEY && SMS_APPID && SMS_SIGN && SMS_TMPL);

    // 手写 TC3-HMAC-SHA256 签名，不引 SDK（省冷启动时间）
    async function smsSend(phone, code) {
      const host = 'sms.tencentcloudapi.com';
      const ct = 'application/json; charset=utf-8';
      const payload = JSON.stringify({
        PhoneNumberSet: ['+86' + phone],
        SmsSdkAppId: SMS_APPID,
        SignName: SMS_SIGN,
        TemplateId: SMS_TMPL,
        TemplateParamSet: [code],
      });
      const ts = Math.floor(Date.now() / 1000);
      const day = new Date(ts * 1000).toISOString().slice(0, 10);
      const canonicalHeaders = 'content-type:' + ct + '\nhost:' + host + '\n';
      const signedHeaders = 'content-type;host';
      const hashed = crypto.createHash('sha256').update(payload).digest('hex');
      const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, hashed].join('\n');
      const scope = day + '/sms/tc3_request';
      const stringToSign = [
        'TC3-HMAC-SHA256', String(ts), scope,
        crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
      ].join('\n');
      const k1 = crypto.createHmac('sha256', 'TC3' + SMS_SECRET_KEY).update(day).digest();
      const k2 = crypto.createHmac('sha256', k1).update('sms').digest();
      const k3 = crypto.createHmac('sha256', k2).update('tc3_request').digest();
      const sig = crypto.createHmac('sha256', k3).update(stringToSign).digest('hex');
      const auth = 'TC3-HMAC-SHA256 Credential=' + SMS_SECRET_ID + '/' + scope +
        ', SignedHeaders=' + signedHeaders + ', Signature=' + sig;

      const r = await fetch('https://' + host, {
        method: 'POST',
        headers: {
          Authorization: auth,
          'Content-Type': ct,
          'X-TC-Action': 'SendSms',
          'X-TC-Version': '2021-01-11',
          'X-TC-Timestamp': String(ts),
          'X-TC-Region': 'ap-guangzhou',
        },
        body: payload,
      });
      const txt = await r.text();
      let j = {};
      try { j = JSON.parse(txt); } catch (e) { j = { raw: txt.slice(0, 200) }; }
      return j;
    }

    const okPhone = p => /^1[3-9]\d{9}$/.test(String(p || ''));

    // 发验证码
    if (a === 'send_code') {
      const phone = String(event.phone || '').trim();
      if (!okPhone(phone)) return { ok: false, error: '手机号格式不对' };
      if (!SMS_READY) return { ok: false, error: '短信服务还没配置（云函数里 SMS_* 四项为空）', notReady: true };

      // 同一号码 60 秒内只发一次
      const since = Date.now() - 60000;
      const q = encodeURIComponent(JSON.stringify({ phone: phone, createdAt: { $gt: since } }));
      const recent = await db('GET', '/collections/' + SMS_COLL + '/documents?query=' + q + '&limit=1');
      if ((recent.list || []).length) return { ok: false, error: '刚发过，60 秒后再试' };

      const code = String(Math.floor(100000 + Math.random() * 900000));
      const r = await smsSend(phone, code);
      const st = r && r.Response && r.Response.SendStatusSet && r.Response.SendStatusSet[0];
      if (!st || st.Code !== 'Ok') {
        const msg = (r && r.Response && (r.Response.Error && r.Response.Error.Message)) || (st && st.Message) || '发送失败';
        return { ok: false, error: '短信没发出去：' + msg };
      }
      await db('POST', '/collections/' + SMS_COLL + '/documents', {
        data: [{ phone: phone, code: code, createdAt: Date.now(), expiresAt: Date.now() + 5 * 60000, used: false }],
      });
      return { ok: true, ttl: 300 };
    }

    // 用手机号 + 验证码登录
    if (a === 'phone_login') {
      const phone = String(event.phone || '').trim();
      const code = String(event.code || '').trim();
      if (!okPhone(phone) || !code) return { ok: false, error: '手机号和验证码都要填' };

      const q = encodeURIComponent(JSON.stringify({ phone: phone, used: false }));
      const r = await db('GET', '/collections/' + SMS_COLL + '/documents?query=' + q + '&limit=1');
      const rec = (r.list || [])[0];
      if (!rec) return { ok: false, error: '没有待用的验证码，先获取' };
      const exp = rec.expiresAt && rec.expiresAt.$numberLong ? Number(rec.expiresAt.$numberLong) : Number(rec.expiresAt || 0);
      if (exp && Date.now() > exp) return { ok: false, error: '验证码过期了，重新获取' };
      if (String(rec.code) !== code) return { ok: false, error: '验证码不对' };

      await db('PATCH', '/collections/' + SMS_COLL + '/documents', {
        query: { _id: rec._id }, data: { $set: { used: true } },
      });

      let u = await findUser({ phone: phone });
      if (!u) {
        const doc = {
          uid: newUid(), phone: phone, email: '', nickname: '',
          createdAt: Date.now(), lastSeen: Date.now(),
        };
        const ins = await db('POST', '/collections/users/documents', { data: [doc] });
        u = Object.assign({ _id: (ins.insertedIds || [])[0] }, doc);
      }
      if (u.banned) return { ok: false, error: '账号已被停用' };
      if (!u.uid) {
        u.uid = newUid();
        await db('PATCH', '/collections/users/documents', { query: { _id: u._id }, data: { $set: { uid: u.uid } } });
      }
      return { ok: true, token: issueToken(u.uid), user: userPublic(u) };
    }

    // 短信通道是否就绪（前端用来显示提示）
    if (a === 'sms_status') {
      return { ok: true, ready: SMS_READY };
    }

    // 校验 token 是否还有效
    if (a === 'whoami') {
      const u = await currentUser();
      if (!u) return { ok: false, error: '登录已过期' };
      return { ok: true, user: userPublic(u) };
    }

    // 设密码 / 改密码（已登录即可，设完就能跨端登录）
    if (a === 'set_password') {
      const u = await currentUser();
      if (!u) return { ok: false, error: '先登录' };
      const pwd = String(event.password || '');
      if (pwd.length < 6) return { ok: false, error: '密码至少 6 位' };
      const salt = newSalt();
      await db('PATCH', '/collections/users/documents', {
        query: { _id: u._id },
        data: { $set: { pwdSalt: salt, pwdHash: hashPwd(pwd, salt), updatedAt: Date.now() } },
      });
      return { ok: true };
    }

    if (a === 'user_set_email') {
      const u = await currentUser();
      if (!u) return { ok: false, error: '先登录' };
      const email = String(event.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: '邮箱格式不对' };
      const other = await findUser({ email: email });
      if (other && other.uid !== u.uid) return { ok: false, error: '这个邮箱已被其他账号使用' };
      await db('PATCH', '/collections/users/documents', {
        query: { _id: u._id }, data: { $set: { email: email, updatedAt: Date.now() } },
      });
      return { ok: true, email: email };
    }

    if (a === 'user_set_nickname') {
      const u = await currentUser();
      if (!u) return { ok: false, error: '先登录' };
      const nick = String(event.nickname || '').trim().slice(0, 32);
      await db('PATCH', '/collections/users/documents', {
        query: { _id: u._id }, data: { $set: { nickname: nick, updatedAt: Date.now() } },
      });
      return { ok: true, nickname: nick };
    }

    if (a === 'ping') {
      const p = await db('GET', '/collections/' + CMD + '/documents?limit=1');
      return { ok: true, svc: 'kuaichuan-fn', sdk: 'fetch', env: ENV, dbOk: !p.code };
    }
    if (a === 'send') {
      const doc = { deviceCode: event.deviceCode || '', kind: event.kind || 'shell', payload: event.payload || '',
        status: 'pending', createdAt: Date.now(), stdout: '', stderr: '', exitCode: null };
      const r = await db('POST', '/collections/' + CMD + '/documents', { data: [doc] });
      return { ok: true, id: (r.insertedIds && r.insertedIds[0]) || '' };
    }
    if (a === 'get') {
      if (!event.id) return { ok: false, error: 'missing id' };
      const r = await db('GET', '/collections/' + CMD + '/documents/' + encodeURIComponent(event.id));
      return { ok: true, doc: r || {} };
    }
    if (a === 'poll') {
      const limit = Math.min(Number(event.limit) || 5, 20);
      const q = encodeURIComponent('{"status":"pending"}');
      const r = await db('GET', '/collections/' + CMD + '/documents?query=' + q + '&limit=' + limit);
      return { ok: true, list: r.list || [] };
    }
    if (a === 'update') {
      if (!event.id) return { ok: false, error: 'missing id' };
      const d = Object.assign({}, event.patch || {}); delete d._id;
      await db('PATCH', '/collections/' + CMD + '/documents', { query: { _id: event.id }, data: { $set: d } });
      return { ok: true, id: event.id };
    }
    if (a === 'heartbeat') {
      const code = event.deviceCode;
      if (!code) return { ok: false, error: 'missing deviceCode' };
      const payload = { deviceCode: code, name: event.name || '', lastSeen: Date.now(), agents: event.agents || [],
        lanIp: event.lanIp || '', lanPort: Number(event.lanPort) || 0 };
      const q = encodeURIComponent(JSON.stringify({ deviceCode: code }));
      const f = await db('GET', '/collections/' + DEV + '/documents?query=' + q + '&limit=1');
      const l = f.list || [];
      // 终端里绑定时带上 owner，把设备归到某个账号名下
      if (event.owner) payload.owner = event.owner;
      if (l.length) await db('PATCH', '/collections/' + DEV + '/documents', { query: { _id: l[0]._id }, data: { $set: payload } });
      else await db('POST', '/collections/' + DEV + '/documents', { data: [payload] });
      return { ok: true, deviceCode: code };
    }
    // ---- 设备管理 ----
    // 归属按 uid（不是 openid），所以 App / 网页端登录同一个账号看到的是同一批设备
    if (a === 'devices') {
      const me = await currentUser();
      const r = await db('GET', '/collections/' + DEV + '/documents?limit=50');
      const all = r.list || [];
      const uid = me ? me.uid : '';
      // 只返回自己名下的。未归属的设备不列出来 ——
      // 否则任何人打开小程序都能看到别人的电脑，等于泄露。
      // 要接入一台没归属的电脑，必须手输它的配对码（见 device_claim）。
      const list = all.filter(d => uid && d.owner === uid).map(d => {
        const seen = numOf(d.lastSeen);
        return {
          deviceCode: d.deviceCode || '',
          name: d.alias || d.name || d.deviceCode || '',
          machineName: d.name || '',
          agents: d.agents || [],
          owner: d.owner || '',
          mine: true,
          lanIp: d.lanIp || '',
          lanPort: numOf(d.lanPort),
          lastSeen: seen,
          online: Date.now() - seen < 90000,
        };
      });
      return { ok: true, list: list, loggedIn: !!me };
    }

    if (a === 'device_claim') {
      const me = await currentUser();
      if (!me) return { ok: false, error: '先登录' };
      const code = event.deviceCode || '';
      if (!code) return { ok: false, error: '缺 deviceCode' };
      const q = encodeURIComponent(JSON.stringify({ deviceCode: code }));
      const fr = await db('GET', '/collections/' + DEV + '/documents?query=' + q + '&limit=1');
      const hit = (fr.list || [])[0];
      if (!hit) return { ok: false, error: '这台电脑还没上线，先让 exe 跑起来' };
      if (hit.owner && hit.owner !== me.uid) return { ok: false, error: '这台电脑已被其他账号绑定' };
      await db('PATCH', '/collections/' + DEV + '/documents', {
        query: { _id: hit._id },
        data: { $set: { owner: me.uid, claimedAt: Date.now() } },
      });
      return { ok: true, deviceCode: code };
    }

    // ---- 电脑端自管（exe 用配对码证明「我就是这台电脑」）----
    if (a === 'device_self_status') {
      const code = event.deviceCode || '';
      const q = encodeURIComponent(JSON.stringify({ deviceCode: code }));
      const fr = await db('GET', '/collections/' + DEV + '/documents?query=' + q + '&limit=1');
      const hit = (fr.list || [])[0];
      if (!hit) return { ok: true, bound: false, owner: '' };
      let owner = '';
      if (hit.owner) {
        const uf = await findUser({ uid: hit.owner });
        if (uf) owner = uf.nickname || uf.email || '某个账号';
      }
      return { ok: true, bound: !!hit.owner, owner: owner, alias: hit.alias || '' };
    }

    if (a === 'device_self_release') {
      const code = event.deviceCode || '';
      if (!code) return { ok: false, error: '缺 deviceCode' };
      const q = encodeURIComponent(JSON.stringify({ deviceCode: code }));
      const fr = await db('GET', '/collections/' + DEV + '/documents?query=' + q + '&limit=1');
      const hit = (fr.list || [])[0];
      if (!hit) return { ok: false, error: '这台电脑还没注册到云端' };
      await db('PATCH', '/collections/' + DEV + '/documents', {
        query: { _id: hit._id },
        data: { $set: { owner: '', alias: '', releasedAt: Date.now() } },
      });
      return { ok: true };
    }
    // 彻底删除设备记录（比解绑更狠：从云端抹掉，exe 下次心跳会重新注册成未归属）
    if (a === 'device_delete') {
      const me = await currentUser();
      if (!me) return { ok: false, error: '先登录' };
      const code = event.deviceCode || '';
      if (!code) return { ok: false, error: '缺 deviceCode' };
      const q = encodeURIComponent(JSON.stringify({ deviceCode: code }));
      const fr = await db('GET', '/collections/' + DEV + '/documents?query=' + q + '&limit=1');
      const hit = (fr.list || [])[0];
      if (!hit) return { ok: false, error: '找不到这台电脑' };
      if (hit.owner !== me.uid) return { ok: false, error: '这不是你绑定的设备' };
      await db('DELETE', '/collections/' + DEV + '/documents?query=' + q);
      return { ok: true };
    }
    // 解绑：只清归属，不动设备本身（exe 下次心跳会重新出现为「未归属」）
    if (a === 'device_remove') {
      const me = await currentUser();
      if (!me) return { ok: false, error: '先登录' };
      const code = event.deviceCode || '';
      if (!code) return { ok: false, error: '缺 deviceCode' };
      const q = encodeURIComponent(JSON.stringify({ deviceCode: code }));
      const fr = await db('GET', '/collections/' + DEV + '/documents?query=' + q + '&limit=1');
      const hit = (fr.list || [])[0];
      if (!hit) return { ok: false, error: '找不到这台电脑' };
      if (hit.owner !== me.uid) return { ok: false, error: '这不是你绑定的设备' };
      await db('PATCH', '/collections/' + DEV + '/documents', {
        query: { _id: hit._id },
        data: { $set: { owner: '', alias: '', releasedAt: Date.now() } },
      });
      return { ok: true };
    }

    // 重命名：只改显示名，不影响 exe 上报的主机名
    if (a === 'device_rename') {
      const me = await currentUser();
      if (!me) return { ok: false, error: '先登录' };
      const code = event.deviceCode || '';
      const alias = String(event.name || '').trim().slice(0, 24);
      const q = encodeURIComponent(JSON.stringify({ deviceCode: code }));
      const fr = await db('GET', '/collections/' + DEV + '/documents?query=' + q + '&limit=1');
      const hit = (fr.list || [])[0];
      if (!hit) return { ok: false, error: '找不到这台电脑' };
      if (hit.owner !== me.uid) return { ok: false, error: '这不是你绑定的设备' };
      await db('PATCH', '/collections/' + DEV + '/documents', {
        query: { _id: hit._id },
        data: { $set: { alias: alias, renamedAt: Date.now() } },
      });
      return { ok: true, alias: alias };
    }
    // ---- 终端会话 ----
    if (a === 'term_in') {
      // 电脑端：取待输入的按键
      const r = await db('GET', '/collections/term_in_4759588622381809665/documents?query=' + encodeURIComponent('{"status":"pending"}') + '&limit=5');
      return { ok: true, list: r.list || [] };
    }
    if (a === 'term_ack') {
      if (!event.id) return { ok: false, error: 'missing id' };
      await db('PATCH', '/collections/term_in_4759588622381809665/documents', { query: { _id: event.id }, data: { $set: { status: 'done' } } });
      return { ok: true };
    }
    if (a === 'term_push') {
      const doc = { deviceCode: event.deviceCode || '', seq: Number(event.seq) || 0, text: event.text || '', createdAt: Date.now() };
      await db('POST', '/collections/term_out_4759588622381809665/documents', { data: [doc] });
      return { ok: true };
    }
    if (a === 'term_send') {
      // 手机端：把按键/一行命令发给电脑
      const doc = { deviceCode: event.deviceCode || '', data: event.data || '', status: 'pending', createdAt: Date.now() };
      const r = await db('POST', '/collections/term_in_4759588622381809665/documents', { data: [doc] });
      return { ok: true, id: (r.insertedIds && r.insertedIds[0]) || '' };
    }
    if (a === 'term_read') {
      const from = Number(event.from) || 0;
      const q = encodeURIComponent(JSON.stringify({ seq: { $gt: from } }));
      // 每帧都是「整屏快照」，只取最新一帧，不要把多帧拼起来
      const r = await db('GET', '/collections/term_out_4759588622381809665/documents?query=' + q + '&limit=20&order=' + encodeURIComponent('[{"field":"seq","direction":"desc"}]'));
      const list = r.list || [];
      if (!list.length) return { ok: true, text: '', seq: from, count: 0 };
      const d = list[0];
      let sv = d.seq;
      if (sv && typeof sv === 'object') sv = sv.$numberLong !== undefined ? sv.$numberLong : sv.$numberInt;
      const n = Number(sv);
      return { ok: true, text: d.text || '', seq: isNaN(n) ? from : n, count: 1 };
    }
    if (a === 'term_shell_set') {
      const code = event.deviceCode;
      const sh = event.shell || 'gitbash';
      await db('PATCH', '/collections/devices/documents', {
        query: { deviceCode: code },
        data: { $set: { termShell: sh, termShellAt: Date.now() } },
      });
      return { ok: true, shell: sh };
    }
    if (a === 'term_restart') {
    await db('PATCH', '/collections/devices/documents', {
      query: { deviceCode: event.deviceCode },
      data: { $set: { termRestartAt: Date.now() } },
    });
    return { ok: true };
  }
  if (a === 'term_shell_get') {
      const q = encodeURIComponent(JSON.stringify({ deviceCode: event.deviceCode }));
      const r = await db('GET', '/collections/devices/documents?query=' + q + '&limit=1');
      const d = (r.list || [])[0] || {};
      let ra = d.termRestartAt; if (ra && typeof ra === 'object') ra = ra.$numberLong !== undefined ? ra.$numberLong : ra.$numberInt;
      return { ok: true, shell: d.termShell || 'gitbash', at: d.termShellAt || 0, restartAt: Number(ra) || 0 };
    }
    if (a === 'sdk_test') {
      let info = { hasSdk: false, wrote: false, err: '' };
      try {
        const cloud = require('wx-server-sdk');
        info.hasSdk = true;
        cloud.init({ env: ENV });
        const db = cloud.database();
        try {
          const r = await db.collection('term_out').add({ data: { seq: 555555, text: 'SDK-TEST', deviceCode: '886613', createdAt: Date.now() } });
          info.wrote = true;
          info.added = r && r._id ? r._id : '';
        } catch (e2) { info.err = (e2 && e2.message) || String(e2); }
      } catch (e1) {
        info.err = 'require 失败: ' + ((e1 && e1.message) || String(e1));
      }
      return { ok: true, info: info };
    }    if (a === 'agent_in') {
    const q = encodeURIComponent(JSON.stringify({ status: 'pending' }));
    const r = await db('GET', '/collections/agent_in_4759588622381809665/documents?query=' + q + '&limit=3');
    return { ok: true, list: r.list || [] };
  }
  if (a === 'agent_send') {
    const doc = {
      deviceCode: event.deviceCode || '', agent: event.agent || 'claude', exe: event.exe || event.agent || 'claude',
      text: event.text || '', headless: event.headless || '0', status: 'pending', createdAt: Date.now(),
    };
    const r = await db('POST', '/collections/agent_in_4759588622381809665/documents', { data: [doc] });
    return { ok: true, id: (r.insertedIds && r.insertedIds[0]) || '' };
  }
  if (a === 'agent_reply') {
    if (!event.id) return { ok: false, error: 'missing id' };
    await db('PATCH', '/collections/agent_in_4759588622381809665/documents', {
      query: { _id: event.id },
      data: { $set: { status: 'done', reply: event.text || '', repliedAt: Date.now() } },
    });
    // 顺手推一条「跑完了」通知（有额度才发，发失败不影响主流程）
    try {
      await notifyAgentDone(event.deviceCode, event.text || '');
    } catch (e) {
      // 通知失败不能影响回复落库
    }
    return { ok: true };
  }
  if (a === 'agent_result') {
    const r = await db('GET', '/collections/agent_in_4759588622381809665/documents/' + encodeURIComponent(event.id));
    return { ok: true, doc: r || {} };
  }

  // ---- 推送额度 ----
  // 小程序端每次点「跑完叫我」会调 wx.requestSubscribeMessage，
  // 成功一次就记一次额度；agent 回话时消耗一次。
  if (a === 'push_grant') {
    const uid = callerOpenid;
    if (!uid) return { ok: false, error: '缺少 openid' };
    const q = encodeURIComponent(JSON.stringify({ openid: uid }));
    const f = await db('GET', '/collections/users/documents?query=' + q + '&limit=1');
    const u = (f.list || [])[0];
    if (!u) return { ok: false, error: '账号不存在' };
    const quota = Math.min((u.pushQuota || 0) + 1, 5);
    await db('PATCH', '/collections/users/documents', {
      query: { _id: u._id },
      data: { $set: { pushQuota: quota } },
    });
    return { ok: true, quota: quota };
  }

  if (a === 'push_status') {
    const uid = callerOpenid;
    if (!uid) return { ok: false, error: '缺少 openid' };
    const q = encodeURIComponent(JSON.stringify({ openid: uid }));
    const f = await db('GET', '/collections/users/documents?query=' + q + '&limit=1');
    const u = (f.list || [])[0];
    return { ok: true, quota: (u && u.pushQuota) || 0, templateReady: !!PUSH_CHANNEL, channel: PUSH_CHANNEL };
  }

  // 探测：这个环境到底能不能用订阅消息
  if (a === 'push_probe') {
    const out = [];
    let cloud;
    try {
      cloud = require('wx-server-sdk');
      cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
      out.push('wx-server-sdk ok');
    } catch (e) {
      return { ok: true, probe: ['wx-server-sdk 不可用: ' + (e && e.message)] };
    }
    try {
      const r = await cloud.openapi.subscribeMessage.getTemplateList({ offset: 0, count: 20 });
      out.push('getTemplateList ok: ' + JSON.stringify(r).slice(0, 500));
    } catch (e) {
      out.push('getTemplateList 失败: errCode=' + (e && e.errCode) + ' errMsg=' + (e && (e.errMsg || e.message)));
    }
    try {
      const wx = cloud.getWXContext();
      out.push('ctx: ' + JSON.stringify({ OPENID: wx.OPENID ? '有' : '无', APPID: wx.APPID || '', ENV: wx.ENV || '' }));
    } catch (e) {
      out.push('ctx 失败: ' + (e && e.message));
    }
    return { ok: true, probe: out };
  }

  return { ok: false, error: 'unknown action: ' + a };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
};