// 快传 · 小程序入口
const ENV_ID = 'eval-lifecycle-d7gf433u22f6c2405';

App({
  globalData: {
    envId: ENV_ID,
    cloudReady: false
  },

  onLaunch: function () {
    var self = this;
    if (wx.cloud) {
      try {
        wx.cloud.init({ env: ENV_ID, traceUser: true });
        self.globalData.cloudReady = true;
        console.log('[快传] 云开发已初始化', ENV_ID);
      } catch (e) {
        console.error('[快传] 云开发初始化失败', e);
      }
    } else {
      console.warn('[快传] 当前环境没有 wx.cloud');
    }
  }
});