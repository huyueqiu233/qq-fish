# QQ 鱼 · DeepSeek Harness QQ 聊天一键包

把一个 QQ 号变成「住在群里的大肥鱼」：DSH（DeepSeek Harness）+ 自建桥接，带 48 个工具、长期记忆、黑话学习、QQ 表情包、带情绪的语音、主动搭话。

## 里面有什么

| 目录 | 内容 |
|---|---|
| `bridge/` | QQ 桥（Node）——所有开关在 `config.example.json` |
| `addons/` | IndexTTS 语音服务（可选，不装也能聊） |
| `tools/` | 豆包生图等辅助工具 |
| `install.ps1` | 一键安装脚本 |
| `README-安装说明.md` | 详细安装步骤 |
| `版本说明-1.11.md` | 这个版本改了什么 |

## 快速开始

1. 先装好 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）
2. 把本仓库下载到本地
3. 用管理员 PowerShell 运行 `install.ps1`
4. 按 `README-安装说明.md` 配 QQ 桥（SnowLuma）、群/私聊白名单

## 说明

- 包里**不含**任何账号、群号、token、本机路径；`config.example.json` 是空模板
- 语音是可选项，不装也能正常聊天
- 以后的新版本会发布在本仓库的 **Releases** 里，链接不变

## 相关

- 另一个项目：[villagewar](https://github.com/huyueqiu233/villagewar)（Minecraft 村庄演化模组，NeoForge 1.21.1）
