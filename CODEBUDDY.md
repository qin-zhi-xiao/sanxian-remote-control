# 快传（kuaichuan）— 项目上下文交接

> 2026-11-15 从 DeepSeek Harness 会话迁移到 WorkBuddy 时建立，2026-11-16 安全整修后校对。
> 给接手这个仓库的 AI 助手看：先读完这一页，再动代码。

## 一句话

用微信小程序远程接管电脑终端与本地 AI 智能体（微信小程序竞赛项目，提交站 edu.weixin.qq.com）。
手机打字 → 云函数 → 电脑上的 `kuaichuan.exe` → ConPTY 假终端 / claude・codex 等 CLI。

## 链路

```
微信小程序 src/           云函数 cloud/                 电脑端 pc/
pages/index（配置/欢迎） ─┐
pages/login / account   ─┤
pages/shell / terminal  ─┼→ kuaichuan-fn（小程序侧直连库，带登录会话）
pages/agent / agentcfg  ─┘        │
                                  └→ kuaichuan-relay（HTTP 网关）→ kuaichuan.exe → shell / agent CLI
```

- 小程序用教育版云开发环境 `eval-lifecycle-d7gf433u22f6c2405`，直接读写 `commands` / `devices` 集合。
- 电脑端拿不到那张表（平台租户库无对外 API），所以多了 `kuaichuan-relay` 这个 HTTP 云函数中继：
  `poll` 拉 pending 命令、`update` 回写 stdout/exitCode、`heartbeat` 每 12 秒报活、`ping` 自检。
  详见 `cloud/README.md`。
- **2026-11-16 起**：relay 所有 POST 都要 `Authorization: Bearer <KC_API_KEY>`，
  另有免鉴权的 `GET /health` 供平台探活；网关层 `EnableAuth=false`，鉴权全靠函数层。

## 目录

| 路径 | 内容 |
|---|---|
| `src/` | 小程序源码：`pages/` **7 个页面**（index / login / shell / terminal / agent / account / agentcfg）；`utils/net.js` 接口层、`utils/relay.js` 中继调用、`utils/user.js` 用户态、`utils/tmpl.js` 模板 |
| `pc/src/main.rs` | 电脑端全部逻辑（**3660 行**），Rust **纯标准库**（`pc/Cargo.toml` 的 `[dependencies]` 是空的，Win32/ConPTY 直接 FFI） |
| `cloud/kuaichuan-fn/` | 小程序侧云函数（登录、会话、设备、命令） |
| `cloud/kuaichuan-relay/` | HTTP 网关中继云函数（重点） |
| `cloud/README.md` | **云函数部署、环境变量、鉴权、接口一览** |
| `dist/` | 本机运行用 exe（376,320 字节，11/3 构建）、`启动快传.bat`（局域网模式） |
| `releases/` | 分发 exe / zip / 启动脚本（只放行正式分发文件，密钥与日志一律忽略） |
| `docs/` | 项目报告 / 需求方案 / 云开发打通记录 / 开发记录 |
| `tools/` | CDP 自动化脚本（`push.js` 上传体验版、`rel-*.js` 发 release），大量截图 |

## 电脑端命令行（见 `pc/src/main.rs` 的参数解析处）

```
kuaichuan.exe --port <端口>      # 默认 8765
              --token <令牌>     # 优先级：--token > 配对码 --code > 随机
              --code <配对码>    # 默认 886613
              --gw <url>         # 云函数网关模式（推荐）
              --cloud            # 云开发直连模式（只能看到默认库，一般别用）
              --lan              # 监听 0.0.0.0，手机/局域网才能连
```

`--gw` 与 `--lan` 可同时给：v1.4.0 起会自动在局域网与云端之间分流。
密钥从 exe 同目录的 `.cloudbase-apikey` 读取（也可用 `--apikey` 传入）。

## 构建 / 运行

```powershell
# 电脑端（无外部依赖，直接编译）
cd pc; cargo build --release        # 产物 pc/target/release/kuaichuan.exe
# 小程序：微信开发者工具导入 C:\...\快传\src（不是仓库根目录）
# 云函数：CloudBase 控制台或 MCP 连接器部署，务必先配环境变量（见 cloud/README.md）
```

## 🔐 凭据与安全（2026-11-16 整修，最重要）

1. **绝不能提交的内联凭据**：`dist/.cloudbase-apikey`、`pc/.cloudbase-apikey`、
   `releases/.cloudbase-apikey`、`tools/key.json`，以及任何 API Key / 会话密钥。
   这些都被 `.gitignore` 挡住；也不要贴进聊天、日志或 issue。
2. 两个云函数**不再内联任何密钥**，统一读环境变量：
   `kuaichuan-relay` → `KC_API_KEY`；`kuaichuan-fn` → `KC_API_KEY` + `KC_SESS_SECRET`。
   缺失时快速失败（relay 返回 503、fn 登录类操作报「未配置」），不降级成弱密钥。
3. **旧的长期管理员 API Key 已吊销并换成新 Key**（2026-11-16）。
   旧串仍留在公开仓库的 git 历史里但已失效；清理历史需要 force push，**未经明确授权不要做**。
4. 轮换 Key 后必须同步所有客户端的 `.cloudbase-apikey` 并**重启进程**（内存里是旧值），
   否则云端返回 `401 unauthorized` / `ACCESS_TOKEN_INVALID`。
5. `.gitignore` 的 `releases/*` 是**白名单**：只放行 `*.zip`、`*.cmd`、`kuaichuan.exe`、
   `kuaichuan-v*.exe`。不要改回 `!releases/*`——它会把密钥、`gw.log`、`.kc-*` 一起放行。
6. `.workbuddy/`（AI 工作记忆）与 `*.bak` 保留在本机，不进公开仓库。

## 硬约束（踩过的坑，别重犯）

1. 两张同名 `commands` 表（小程序库 vs 环境默认库）是两个命名空间，这是必须走云函数中继的根因。
2. 云函数运行时没有 `wx-server-sdk` 的推送能力，所以是 600ms 轮询（延迟 1~2 秒）；别指望改几行就变实时。
3. 已知缺陷：`Ctrl+C` 透传无效、终端无颜色、无 canvas 渲染（120×40 字符网格）。
4. `tools/*.js` 全部依赖一个开着调试端口的 Chrome（CDP），路径/端口写死在脚本里；跑之前先确认浏览器状态。
5. `cargo check --release` 有约 48 个 warning，其中 `main.rs` 的一处 `unreachable pattern` 值得查，
   以及 `SESSION_CWD` / `get_cwd` / `term_run_legacy` / `AGENT_GEN` 等 dead_code（写了没接上线）；
   其余是 FFI 字段命名风格，无害。

## 当前状态（git）

- 远端 `github.com/qin-zhi-xiao/sanxian-remote-control`（**公开仓库**）。
- 2026-11-16 做了一次「收尾快照提交」，把安全修复、新页面（login / account / agentcfg）、
  图标资源、v1.5.0 分发文件与文档校对一并落地；提交后 `git status` 应接近干净。
  具体 HEAD 用 `git log -1` 看，别信文档里写死的 hash。
- **本地提交不等于推送**：推送前先确认没有把密钥或临时文件带上去。

## 版本号现状（尚未统一，下次发版一并处理）

| 位置 | 当前值 |
|---|---|
| README「已发布」 | v1.4.0 |
| 工作区 / `releases/kuaichuan-v1.5.0.exe` | v1.5.0 开发快照（11/6 构建，非当前源码） |
| `pc/src/main.rs` `VERSION` | 1.4.0 |
| `pc/Cargo.toml` | 0.1.0 |
| `cloud/kuaichuan-fn/package.json` | 1.4.0 |
| `cloud/kuaichuan-relay/package.json` | 1.0.0 |

> 改源码版本号就要重新编译 exe，否则「源码写 1.5.0、exe 报 1.4.0」又是一对新的不一致。

## 下一步（按优先级）

1. 统一版本号 + 重新构建并发布正式 v1.5.0
2. canvas 渲染终端，解决无颜色 / 滚动卡顿
3. 轮询 600ms → 300ms，压缩延迟
4. `Ctrl+C` 透传
5. 局域网直连走 UDP 广播自动发现，省掉手动填 IP
6. git 历史清理（需 force push，**必须先拿到授权**）、删除无路由的遗留模板云函数

## 文档索引

- 接手必读 → 本文件
- 云函数部署 / 鉴权 / 接口 → `cloud/README.md`
- 做了什么、做到哪 → `docs/项目报告.md`
- 最初需求与设计 → `docs/快传-需求与方案-v0.1.md`
- 云开发怎么打通的、坑在哪 → `docs/B方案-云开发中转打通记录.md`
- 版本迭代细节 → `docs/开发记录-v0.2.md`
