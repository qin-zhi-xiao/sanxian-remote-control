# 快传 · 云函数中继 部署说明

这是整条链上最后一块拼图：让**电脑端 exe** 能读写「小程序那张表」。

## 为什么需要它

实测结论（2026-10-30）：

| 谁 | 访问的 `commands` |
|---|---|
| 小程序 `wx.cloud.database()` | 平台分配给项目的表，能读写，但 API Key 看不到 |
| HTTP API（API Key） | 环境默认库里的同名列，里面有数据，但小程序看不到 |

两张同名表，两个命名空间。`instances/tnt-f0yuqma3g` 直接调还报「数据库连接器未找到」，
说明平台租户库没有对外的 API 入口。云函数跑在平台内部，天然能访问那张表——所以用它当中继。

## 部署步骤

1. CloudBase 控制台 → **云函数** → 新建云函数 → **通过模板创建** → 分类选 **HTTP 云函数** →
   Nodejs → `HTTP Node.js Hello World`
2. 创建后进入函数详情，打开**在线代码编辑器**，用 [`index.js`](./kuaichuan-relay/index.js) 全文替换
3. 部署
4. 打开 **HTTP 网关**（或函数的「HTTP 访问服务」），给这个函数配一条路径，例如 `/kuaichuan`
5. 拿到完整地址，形如 `https://<env>.api.tcloudbasegateway.com/v1/functions/kuaichuan`
6. 用 curl 自检：

```bash
curl -s -X POST "https://<网关地址>" \
  -H "Content-Type: application/json" \
  -d '{"action":"ping"}'
# 期望：{"ok":true,"svc":"kuaichuan-relay","sdk":"wx-server-sdk",...}
```

7. 电脑端 exe 改成走网关（下一步要加 `--gw <url>` 模式）：
   - `poll` → 拉取 pending 命令
   - `update` → 回写 stdout/exitCode/status
   - `heartbeat` → 每 12 秒更新 devices

## 接口一览

| action | 方向 | 说明 |
|---|---|---|
| `ping` | 任意 | 自检，返回用的哪个 SDK |
| `poll` | 电脑端 | 拉 `status=pending` 的命令（最多 20 条） |
| `update` | 电脑端 | `{id, patch:{status,stdout,stderr,exitCode}}` 回写结果 |
| `heartbeat` | 电脑端 | `{deviceCode,name,agents}` 更新或新建设备记录 |
| `send` | 小程序端 | 备用写入接口（正常情况小程序直接写库，不需要它） |
| `devices` | 小程序端 | 设备列表 |

## 状态

- ✅ 函数代码写好，本地在 `cloud/kuaichuan-relay/index.js`
- ⏳ 还没部署（控制台模板卡片需要手动点，自动化点不进去）
- ⏳ exe 的 `--gw` 模式还没写（现在的 `--cloud` 是直连库，只能访问到默认库那张表）

## 一个提醒

云函数里 `require('wx-server-sdk')` 优先，失败再回退 `@cloudbase/node-sdk`——
两种运行时我都覆盖了，部署后先打 `{"action":"ping"}` 看它报告用的是哪个 SDK。
