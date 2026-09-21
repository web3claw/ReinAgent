# Tauri + React + Typescript

This template should help get you started developing with Tauri, React and Typescript in Vite.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## 已知限制

- **API Key 明文落盘。** 设置（含 DeepSeek API Key）经 `@tauri-apps/plugin-store` 以明文 JSON
  写入应用数据目录下的 `settings.json`（Windows：`%APPDATA%/<app-identifier>/settings.json`），
  未做加密、未接入系统钥匙串。任何能读取该文件的进程 / 账户都能取得 Key。
  当前定位为本机、单用户的自用桌面应用，故暂按可接受处理；若在共享机器上使用，
  请自行权衡。后续加固方向（需真实 Tauri 运行时验证）：`plugin-stronghold` 加密快照，
  或系统 keyring（Key 入钥匙串、`settings.json` 仅留 modelId/baseUrl）。
