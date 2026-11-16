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

## 部署前必配（环境变量）

| 云函数 | 变量 | 说明 |
|---|---|---|
| `kuaichuan-relay` | `KC_API_KEY` | 云开发 API Key。**必填**：既是数据库访问凭据，也是网关鉴权凭据 |
| `kuaichuan-fn` | `KC_API_KEY` | 同上 |
| `kuaichuan-fn` | `KC_SESS_SECRET` | 登录会话签名密钥，用随机长串生成 |

> ⚠️ 密钥**不要写回源码**。旧 Key 曾随源码进入公开仓库历史，
> 已于 **2026-11-16 轮换并吊销**；线上两个函数当前均已配好上述变量（见文末整修记录）。
> 本地 `dist/` `pc/` `releases/` 三处 `.cloudbase-apikey` 已同步为新 Key。

## 网关鉴权

电脑端 `gw_call()` 的每个请求都带 `Authorization: Bearer <API Key>`，
relay 用定长比较校验它与服务端 `KC_API_KEY` 是否一致：

| 请求 | 结果 |
|---|---|
| 不带 / 带错 Bearer | `401 {"ok":false,"error":"unauthorized"}` |
| 服务端未配置 `KC_API_KEY` | `503`，拒绝所有请求（不裸奔） |
| `OPTIONS` 预检 | `204` |
| `GET /health` | `200 {"ok":true,"svc":"kuaichuan-relay"}`，免鉴权、不碰数据库，供平台探活 |
| 其余 POST | 全部需要 Bearer |

小程序侧走 `wx.cloud.callFunction(kuaichuan-fn)`，有微信侧身份与会话 token，不需要这道网关鉴权。

> 🔁 **轮换 Key 后**，记得同步更新 exe 同目录的 `.cloudbase-apikey`（或用 `--apikey` 传入），
> 否则 exe 仍带旧值，与新 `KC_API_KEY` 对不上会全部 401。

## 部署步骤

1. CloudBase 控制台 → **云函数** → HTTP 云函数（Node.js）
2. 用 [`kuaichuan-relay/index.js`](./kuaichuan-relay/index.js) 全文替换在线代码
3. 在函数配置里添加环境变量 `KC_API_KEY`
4. 部署；`kuaichuan-fn` 同样要配 `KC_API_KEY` 与 `KC_SESS_SECRET` 后重新部署
5. 打开 HTTP 网关，给函数配一条路径，拿到完整地址
6. 自检（注意带 `Authorization`）：

```bash
curl -s -X POST "https://<网关地址>" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <KC_API_KEY>" \
  -d '{"action":"ping"}'
# 期望：{"ok":true,"svc":"kuaichuan-relay","sdk":"fetch",...}
```

7. 电脑端启动：`kuaichuan.exe --gw <网关地址> --code <配对码>`

## 接口一览（POST，JSON body 的 `action` 字段）

| 分类 | action | 说明 |
|---|---|---|
| 自检 | `ping` / `devices` | 连通自检 / 设备列表 |
| 命令 | `poll` `send` `get` `update` | 拉 pending、投递、查单条、回写 stdout/exitCode |
| 心跳 | `heartbeat` | 每 12 秒更新 devices |
| 终端 | `term_in` `term_ack` `term_push` `term_send` `term_read` | 输入帧、确认、输出帧、投递按键、读最新画面 |
| 终端 | `term_shell_set` `term_shell_get` `term_restart` | 切换 / 查询 shell、请求重建会话 |
| 智能体 | `agent_in` `agent_send` `agent_reply` `agent_result` | 拉待办、投递提问、回写答复、查结果 |
| 设备自管 | `device_self_status` `device_self_release` | 凭配对码查绑定状态 / 解绑 |

除 `GET /health` 与 `OPTIONS` 外，所有接口都要 `Authorization: Bearer`。

## 状态（2026-11-16 校对）

- ✅ 两个云函数的新代码**已部署上线**（`Active`），环境变量已注入
- ✅ 线上实测：匿名 POST `401 unauthorized`；带新 Key `ping` `200` + `dbOk:true`；
  `GET /health` `200`；`kuaichuan-fn` 的 `ping` 返回 `dbOk:true`、
  `whoami` 假 token 返回「登录已过期」（证明 `KC_SESS_SECRET` 已生效）
- ✅ 旧 API Key 已吊销，环境里只剩一把新 Key；**旧客户端必须换 `.cloudbase-apikey` 并重启进程**
- ⚠️ 再次改代码后仍需重新部署；改环境变量要等部署完成才生效
- CORS 仍是 `*`（方便调试），已有 Bearer 鉴权兜底；若要更严格可收紧到白名单域名
- 轮询仍是 600ms 级（小程序侧 800ms），`wx-server-sdk` 的 `watch` 在该环境不可用

## 2026-11-16 安全整修记录

| 步骤 | 动作 |
|---|---|
| 1 | 两处内联 `const KEY` → `process.env.KC_API_KEY`；会话密钥占位符 → `process.env.KC_SESS_SECRET`（缺失即失败） |
| 2 | `.gitignore` 的 `!releases/*` 改为白名单，挡住密钥 / `gw.log` / `.kc-*` / 调试 exe |
| 3 | relay 增加 Bearer 定长比较校验 + 免鉴权 `GET /health`；OPTIONS 预检保留 |
| 4 | 云端：新建新 Key → 注入环境变量 → 同步本机三处 `.cloudbase-apikey` → 部署两个函数 → 全绿验证 → **最后**吊销旧 Key |

顺序是「先造新的、最后删旧的」，全程无链路空窗。旧 Key 字符串仍留在公开仓库历史中（已失效），
历史清理需 `force push`，**未经明确授权不做**。

## 一个提醒

云函数运行时没有 `wx-server-sdk` 的推送能力，所以走 `fetch` + HTTP 数据 API + 轮询，
别指望改几行就变实时。`ping` 返回的 `sdk` 字段现在是 `fetch`。
