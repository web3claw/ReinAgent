# ReinAgent

ReinAgent 是一个桌面 AI 编程客户端：把多个大模型接入你的本地工作区，用自然语言驱动它读写代码、执行命令、操作浏览器，并支持从手机远程查看与控制。

![Tech](https://img.shields.io/badge/Tauri_2_React_19-TypeScript-blue) ![Platform](https://img.shields.io/badge/Platform-Windows_%7C_Linux-lightgrey)

## 功能特性

- **多模型对话**：接入 DeepSeek、GLM、OpenAI 兼容网关等多种服务商，按任务切换模型与推理强度
- **Agent 工具执行**：读写文件、执行命令（含后台任务）、内嵌浏览器自动化、任务清单（Todo）进度跟踪，工具调用可逐项审批或自动放行
- **会话管理**：多任务并行、消息编辑重发、历史检查点回退、对话分支、上下文压缩
- **任务清单胶囊**：模型自动拆解步骤，进度条实时跟踪，可随手关闭
- **助手（人设预设）**：为对话预设系统人设，按任务切换
- **子智能体**：委派独立上下文的子任务，支持后台运行与结果查询
- **远程访问**：局域网内手机扫码查看会话、发送消息、批准工具调用
- **导入**：从 Claude Code / Codex / OpenCode / Pi 等工具导入会话、模型配置、技能与 MCP 服务器

## 技术栈

- **前端**：React 19 + TypeScript + Vite + Tailwind CSS v4 + Zustand
- **桌面**：Tauri 2（Rust），Windows 使用 WebView2
- **包管理**：[Bun](https://bun.sh)

## 环境要求

- [Node.js](https://nodejs.org) ≥ 20 与 [Bun](https://bun.sh) ≥ 1.1
- [Rust](https://rustup.rs)（stable，MSVC 工具链）
- Windows 10/11（WebView2 运行时随系统分发）或 Linux（WebKitGTK）

## 开发运行

```bash
# 安装依赖
bun install

# 开发模式（Vite 热更新 + Tauri 窗口）
bun run tauri dev
```

## 生产构建

```bash
# 构建安装包（产物在 src-tauri/target/release/bundle/）
bun run tauri build
```

## 测试

```bash
# 运行全部单元测试（node --test，分域脚本）
bun run test:chat && bun run test:settings && bun run test:markdown && bun run test:agent && bun run test:providers && bun run test:hub && bun run test:assistants && bun run test:import && bun run test:promptEnhancement

# 类型检查
bun run tsc --noEmit
```

## 目录结构

```
├── src/                  # React 前端
│   ├── components/       # UI 组件（聊天 / 设置 / 侧栏 / 面板）
│   ├── lib/              # 核心逻辑（会话池 / Agent 运行时 / 工具 / 存储）
│   └── store/            # Zustand 状态
├── src-tauri/            # Rust 后端（Tauri 命令 / WebView2 / 存储）
└── docs/                 # 设计文档与路线图
```

## 说明

- 模型 API Key 在应用内「设置 → 模型服务商」配置，保存在本地用户目录，不上传
- 会话数据（消息 / 任务 / 设置）持久化在本地用户目录 `~/.ReinAgent/`（SQLite + JSON）
