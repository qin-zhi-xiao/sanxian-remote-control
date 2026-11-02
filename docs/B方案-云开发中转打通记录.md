# 快传 · B 方案（云开发中转）打通记录

> 记录时间：2026-10-30
> 结论：**云开发中转这条路已经验证可行**，从「拿密钥」到「真读写数据库」全部实测通过。

---

## 一、关键发现：教育版项目详情里直接给了云开发入口

在编辑器右上角 `≡` →「项目详情」面板里能看到两样东西（之前没人注意到）：

| 项 | 值 |
|---|---|
| 云环境 ID | `eval-lifecycle-d7gf433u22f6c2405` |
| 发布至 APPID | `wx92492e2106ffd32a`（小程序教育平台） |

点「云环境 ID」旁边的**管理**，会打开腾讯云 CloudBase 控制台：
`https://tcb.cloud.tencent.com/dev?envId=eval-lifecycle-d7gf433u22f6c2405`

⚠️ 顺带纠正一件事：AI 小老师说「这个平台不支持云函数、不支持云托管」是**错的**。
CloudBase 控制台左侧菜单里有：**云函数 / HTTP 网关 / 云存储 / AI / 日志监控 / 套餐用量**。
数据库也不是「不能用」，是「还没建集合」。

## 二、电脑端凭据：服务端 API Key

控制台 → 环境管理 → **API Key 配置** → 服务端 API Key → 创建：

- 名称：`kuaichuan-pc`
- 有效期：永不过期
- 已保存到：`快传/pc/.cloudbase-apikey`（823 字符的 JWT，**这是密钥，别提交到公开仓库**）

这个 Key 用于请求云开发 HTTP API，正是电脑端（exe）需要的。

## 三、HTTP API 契约（实测通过）

```
Base: https://eval-lifecycle-d7gf433u22f6c2405.api.tcloudbasegateway.com
      /v1/database/instances/(default)/databases/(default)

Header: Authorization: Bearer <API Key>
```

| 操作 | 方法与路径 | 实测结果 |
|---|---|---|
| 建集合 | `POST /collections`，body `{"collectionName":"commands"}` | **201** |
| 插入 | `POST /collections/commands/documents`，body `{"data":[{...}]}` | **201**，返回 `insertedIds` |
| 查询 | `GET /collections/commands/documents?query={"status":"pending"}&limit=5` | **200**，返回 `{offset,limit,list}` |
| 更新 | `PATCH /collections/commands/documents`，body `{"query":{...},"data":{"$set":{...}}}` | 按文档规范（待实测） |

已建好两个集合：**`commands`**、**`devices`**。

实测样例（真跑出来的）：

```
POST body: {"data":[{"deviceCode":"MOCK","kind":"shell","payload":"whoami","status":"pending","createdAt":1793368000000}]}
→ {"insertedIds":["a6da97516ae4a1e4000c6fc31c3348e1"]}  HTTP 201

GET ?query={"status":"pending"}
→ {"offset":0,"limit":5,"list":[{"_id":"a6da97516ae4a1e4000c6fc31c3348e1","deviceCode":"MOCK",
   "kind":"shell","payload":"whoami","status":"pending","createdAt":{"$numberLong":"1793368000000"}}]}  HTTP 200
```

文档来源：[CloudBase HTTP API · 文档型数据库](https://docs.cloudbase.net/en/http-api/nosql/nosql-restful-api)、
[OpenAPI 规范](https://docs.cloudbase.net/openapi/en/nosql.v1.openapi.yaml)

## 四、踩过的坑

1. **PowerShell 里用 `curl -d '{"a":"b"}'` 会被吃掉引号**，服务端收到 `{a:b}` 直接 `INVALID_PARAM`。
   正确姿势：把 body 写进文件，用 `--data-binary "@body.json"`。
2. 云环境 ID 里的 `(default)` 括号要原样保留，别 URL 编码。
3. 控制台「文档型数据库」页会报 `lowcode 用户不存在`，**不影响** HTTP API 使用（建集合、读写都正常）。

## 四点五、小程序整改（已完成代码，卡在一条权限）

小程序已改成云开发中转：

- `app.js`：`wx.cloud.init({ env: 'eval-lifecycle-d7gf433u22f6c2405' })`
- `utils/relay.js` v0.4：`run()` 写 `commands` 集合 → 轮询 `doc(id).get()` 拿结果；`listDevices()` 读 `devices` 集合
- 首页：设备卡列表（点一下选中）+ 手动配对码兜底 + 模拟开关
- 终��/Agent 页沿用 `relay.run()`，Agent 列表来自 `devices.agents`

**当前现象**：模拟器里首页显示「没发现电脑」，虽然 `devices` 集合里已经有一条真实记录
（`deviceCode=886613`、`name=稚骁的电脑`、3 个 agents，curl 查询 200 确认存在）。

**原因（待验证但基本确定）**：云数据库集合的默认权限是「仅创建者可读写」。
那条设备记录是**管理端 API Key**（无 `_openid`）写进去的，小程序端读不到别人的文档。
`commands` 目前没问题（小程序自己创建的文档自己能读）。

**修法**：控制台 → 文档型数据库 → 集合 `devices` → 权限设置 → 改成「所有用户可读（仅管理员可写）」；
`commands` 保持「仅创建者可读写」即可（管理端 API Key 天然绕过权限）。

## 五、下一步（还没做）

1. **电脑端 exe 加 `--cloud` 模式**：轮询 `commands` 里 `status=pending` → 执行 → 回写 `stdout/stderr/exitCode/status`；顺带心跳写 `devices`。
   - Rust 标准库没有 TLS，方案是用系统自带的 `curl.exe` 发 HTTPS 请求（exe 保持零依赖、体积不变）。
2. **小程序端改用 `wx.cloud.database()`**：`app.js` 里 `wx.cloud.init({ env: 'eval-lifecycle-d7gf433u22f6c2405' })`，
   `relay.js` 的发送/轮询改成读写 `commands` 集合（替代现在的 HTTP 直连，那条被混合内容策略挡死了）。
3. 配对流程：`devices` 集合 + 6 位配对码；命令白名单与超时落地上。

---

## 六、exe 云模式：已实现并实测通过（2026-10-30）

`kuaichuan.exe --cloud --code 886613` 启动后：

1. 读同目录 `.cloudbase-apikey`
2. 每 1.5 秒 GET `commands?query={"status":"pending"}`
3. 认领 → PATCH 成 `running` → 本地执行 → PATCH 回 `done` + `stdout` + `exitCode` + `ms`
4. 每约 12 秒写一次 `devices` 心跳（含扫到的 Agent 列表）

### 实测证据（真跑出来的输出）

**exe 控制台：**
```
  $ whoami
    → done (exit 0 · 101ms) 稚骁的电脑\覃庆培
  $ echo 快传端到端测试 & ver
    → done (exit 0 · 68ms) 快传端到端测试
```

**数据库回写（curl 直接查）：**
```json
{"_id":"a6da97516ae4a712000c76d017db50f4","deviceCode":"886613",
 "payload":"echo 快传端到端测试 \\u0026 ver","status":"done",
 "exitCode":{"$numberInt":"0"},"ms":{"$numberInt":"68"},
 "stdout":"快传端到端测试 \r\n\r\nMicrosoft Windows [Version 10.0.26200.9711]\r\n",
 "timedOut":false}
```

→ 手机写进云数据库的命令，电脑真的执行了，结果真的回到了数据库。**这条链路不再是前端演示。**

### 技术选择

Rust 标准库没有 TLS，所以 HTTP 请求走系统自带的 `curl.exe`（Windows 10+ 内置）。
好处：exe 依然零依赖、体积 270 KB 左右，不用打包 OpenSSL / rustls。
`curl` 的 body 一律写临时文件再 `--data-binary @file`（踩过的引号坑）。

### 命令安全

- 默认拦截：`format c:`、`rm -rf /`、`shutdown`、`diskpart`、`reg delete hklm`、`bcdedit` 等
- `--unsafe` 才解除
- 单条超时 60 秒，输出截断 8 KB
- 危险命令拦截时也会回写 `status=error`，手机端能看到原因

---

## 七、命名空间的坑（已解决，2026-10-30）

现象：小程序 `wx.cloud.database().collection('commands')` 报
`DATABASE_COLLECTION_NOT_EXIST: commands.4759588622381809665`，
但同一个集合用 HTTP API Key 读写完全正常、控制台也能看到。

关键发现：
- 报错里的表名带了项目 ID 后缀 → 平台给每个项目做了多租户表名映射
- 这个映射**只在平台侧创建过集合时才登记**。我用 API Key 直接在库里建同名集合，映射表里没有记录，
  所以小程序解析不到
- 让「AI 小老师」在对话里建一次集合后，小程序侧的诊断立刻变成：
  `云开发：云开发正常，commands 共 0 条`

结论 / 正确做法：

1. **集合必须让平台建**（对话里让 AI 小老师建，或平台控制台建），不要只用 API Key 裸建
2. 电脑端 exe 访问**不加后缀**的纯名字：`--cloud --code 886613`（不带 `--project`）
3. 验证顺序：小程序自检行显示「云开发正常」→ 再看数据能不能互通

exe 在纯名字集合上的实测（同一套代码，只是去掉 `--project`）：
```
  $ echo 纯名字集合测试 & ver
    → done (exit 0 · 68ms) 纯名字集合测试
```
