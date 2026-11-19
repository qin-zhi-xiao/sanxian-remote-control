# 快传

手机接管电脑终端与智能体（微信小程序竞赛项目）。

> ⚠️ **2026-11-16 安全更新**：旧的云开发 API Key 已吊销。所有客户端必须使用新的
> `.cloudbase-apikey`（放在 exe 同目录，或用 `--apikey` 传入），否则网关一律返回 401。
> **已经启动、还在跑的旧进程请重启**（进程内存里仍是旧 Key）。
> 云函数凭据已改为环境变量注入，部署说明见 [`cloud/README.md`](cloud/README.md)。

## 快速开始

1. 电脑端运行 `releases\kuaichuan-v1.5.0.exe --gw <网关地址> --code 886613`
   （或双击 `releases\start-kuaichuan.cmd`；局域网模式用 `dist\启动快传.bat`）
2. 手机微信扫码打开小程序
3. 首次打开填配对码 → 测试连接 → 进入欢迎页

> exe 同目录的 `.cloudbase-apikey` 是密钥文件，**不进版本库、不要贴到聊天或公开仓库**。

## 目录

| 目录 | 内容 |
|---|---|
| `src/` | 小程序源码（7 个页面） |
| `pc/` | 电脑端 Rust 源码（纯标准库 + Win32 FFI） |
| `cloud/` | 两个云函数；**部署说明见 `cloud/README.md`** |
| `dist/` | 本机运行用的 exe 与启动脚本 |
| `releases/` | 分发的 exe 与 zip（只放行正式分发文件） |
| `docs/` | **项目报告、需求方案、开发记录** |
| `tools/` | 推送、CDP 自动化脚本 |

## 从哪读起

- 接手这个项目、想快速看懂上下文 → `CODEBUDDY.md`
- 想知道这个项目做了什么、做到什么程度 → `docs/项目报告.md`
- 想知道最初的需求和设计 → `docs/快传-需求与方案-v0.1.md`
- 想知道云开发怎么打通的、踩了哪些坑 → `docs/B方案-云开发中转打通记录.md`
- 想部署云函数、配置密钥与鉴权 → `cloud/README.md`
- 想知道版本迭代细节 → `docs/开发记录-v0.2.md`

---

## 📥 下载

**推荐：完整分发包**（解压即用，无需任何配置）

- [kuaichuan-v1.5.0-win64.zip](https://raw.githubusercontent.com/qin-zhi-xiao/sanxian-remote-control/main/releases/kuaichuan-v1.5.0-win64.zip)

解压后双击 `启动快传.cmd`，三步上手：

1. 程序窗口显示 6 位配对码（首次随机生成，自动记住）
2. 手机打开「快传」小程序，输入配对码即可连接
3. 桌面快捷方式自动创建；关窗口即退出

> 包内含 `kuaichuan.exe`（约 410 KB）+ 启动脚本 + 服务密钥。网关地址已内置，双击 exe 也能直接跑。
> 网关模式会同时开一个本地网页控制台（自动在浏览器打开），电脑上也能看状态。
>
> 单文件 [kuaichuan.exe](https://raw.githubusercontent.com/qin-zhi-xiao/sanxian-remote-control/main/releases/kuaichuan-v1.5.0.exe)
> 也可用（网关地址已内置），但需自备 `.cloudbase-apikey` 密钥文件放同目录。

### 安全说明

服务密钥随分发包公开分发（教育版竞赛环境，数据均为演示数据）；电脑端的操作受
**配对码 + 账号设备绑定验证**保护（v1.6 起），拿到密钥不等于能操作别人的电脑。

### 首次使用

1. 电脑上运行 `kuaichuan.exe --gw <网关地址> --code 886613`
2. 微信打开小程序，填入配对码 `886613`
3. 点「测试连接」，通过后可进终端或和智能体对话

---

## 版本

| | |
|---|---|
| 已发布 | **v1.5.0**（2026-11-17）— [Release Notes](https://github.com/qin-zhi-xiao/sanxian-remote-control/releases/tag/v1.5.0) |
| 工作区源码 | 与发布一致（tag `v1.5.0`） |

> 版本号已在 README、`pc/src/main.rs`、`pc/Cargo.toml`、两个云函数 `package.json` 之间统一为 1.5.0。
> 改源码版本号后记得重新 `cargo build --release` 并更新 `releases/` 产物。
