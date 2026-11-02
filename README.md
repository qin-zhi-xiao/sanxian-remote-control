# 快传

手机接管电脑终端与智能体（微信小程序竞赛项目）。

## 快速开始

1. 电脑端双击 `dist\启动快传.bat`（或运行 `dist\kuaichuan.exe --gw <网关地址> --code 886613`）
2. 手机微信扫码打开小程序
3. 首次打开填配对码 → 测试连接 → 进入欢迎页

## 目录

| 目录 | 内容 |
|---|---|
| `src/` | 小程序源码 |
| `pc/` | 电脑端 Rust 源码 |
| `cloud/` | 两个云函数 |
| `dist/` | 可执行文件与启动脚本 |
| `docs/` | **项目报告、需求方案、开发记录** |
| `tools/` | 推送、CDP 自动化脚本 |

## 从哪读起

- 想知道这个项目做了什么、做到什么程度 → `docs/项目报告.md`
- 想知道最初的需求和设计 → `docs/快传-需求与方案-v0.1.md`
- 想知道云开发怎么打通的、踩了哪些坑 → `docs/B方案-云开发中转打通记录.md`
- 想知道版本迭代细节 → `docs/开发记录-v0.2.md`
---

## 📥 下载

**Windows 客户端**（单文件，免安装，约 365 KB）

- [kuaichuan.exe](https://raw.githubusercontent.com/qin-zhi-xiao/sanxian-remote-control/main/releases/kuaichuan.exe)
- [zip 打包版（含启动脚本）](https://raw.githubusercontent.com/qin-zhi-xiao/sanxian-remote-control/main/releases/kuaichuan-v1.3.0-win64.zip)

### 首次使用

1. 电脑上运行 `kuaichuan.exe --gw <网关地址> --code 886613`
2. 微信打开小程序，填入配对码 `886613`
3. 点「测试连接」，通过后可进终端或和智能体对话

---

## 版本

当前 **v1.3.0** — [Release Notes](https://github.com/qin-zhi-xiao/sanxian-remote-control/releases/tag/v1.3.0)