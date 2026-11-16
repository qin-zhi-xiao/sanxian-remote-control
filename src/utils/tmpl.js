// 快传 · 前端常量
//
// 关于推送：小程序订阅消息在教育体验版环境用不了，
// 实测云端返回 errCode=-501001 "invalid wx openapi access_token"。
// 所以改走第三方 webhook（Server酱 / PushPlus），配置在云函数里。
// 前端只负责「预约一次提醒」，不涉及模板 ID。

module.exports = {
  // 仅用于界面提示，真正的通道配置在 cloud/kuaichuan-fn/index.js
  PUSH_ENABLED: false
};
