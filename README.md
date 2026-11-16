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

**Windows 客户端**（单文件，免安装，发布版约 370 KB / 376,320 字节）

- [kuaichuan.exe（v1.4.0）](https://raw.githubusercontent.com/qin-zhi-xiao/sanxian-remote-control/main/releases/kuaichuan-v1.4.0.exe)
- [zip 打包版（含启动脚本）](https://raw.githubusercontent.com/qin-zhi-xiao/sanxian-remote-control/main/releases/kuaichuan-v1.4.0-win64.zip)

> 下载的是 v1.4.0 发布包，**包内不含新密钥**。首次使用请把新的 `.cloudbase-apikey`
> 放到 exe 同目录再启动，否则连不上网关。

### 首次使用

1. 电脑上运行 `kuaichuan.exe --gw <网关地址> --code 886613`
2. 微信打开小程序，填入配对码 `886613`
3. 点「测试连接」，通过后可进终端或和智能体对话

---

## 版本

| | |
|---|---|
| 已发布 | **v1.4.0** — [Release Notes](https://github.com/qin-zhi-xiao/sanxian-remote-control/releases/tag/v1.4.0) |
| 工作区源码 | v1.5.0 开发快照（未打 tag；`releases/kuaichuan-v1.5.0.exe` 为本地构建） |

> 版本号在 README、`pc/src/main.rs`、`pc/Cargo.toml`、两个云函数 `package.json` 之间尚未统一，
> 下次发版时一并处理；现状清单见 `CODEBUDDY.md`。
