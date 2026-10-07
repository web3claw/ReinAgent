# ReinAgent

<p align="center">
  <img src="public/app-icon.png" width="96" height="96" alt="ReinAgent Logo" style="border-radius: 20px;" />
</p>

<p align="center">
  <strong>高性能、自主可控的 Local-First AI 辅助编程与桌面 Agent 工作台</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Tauri_2-Rust_Backend-orange" alt="Tauri 2" />
  <img src="https://img.shields.io/badge/React_19-TypeScript-blue" alt="React 19" />
  <img src="https://img.shields.io/badge/TailwindCSS_v4-Semantic_Theme-38bdf8" alt="Tailwind CSS v4" />
  <img src="https://img.shields.io/badge/Local--First-SQLite_WAL-success" alt="Local-First" />
  <img src="https://img.shields.io/badge/Platform-Linux_%7C_Windows-lightgrey" alt="Platform" />
</p>

---

## 🌟 核心理念与设计哲学

ReinAgent 致力于构建一个兼具极致响应速度与高度自主可控性的本地 AI 编程客户端。系统深度对标顶级 AI 编程交互规范（重点参考 **ZCode** 的 UI/UX 与 **LiveAgent** 的底层工程架构）：

- **Local-First 数据自治**：所有会话历史、任务元数据、代码快照、服务商密钥与偏好配置均 100% 存储于本地用户目录（SQLite + JSON），绝不上传云端。
- **No-Fallback & Fail-Fast（真实交互铁律）**：坚决杜绝臆测兜底与伪造假数据。完整解析模型服务端的真实上下文容量（`context_window`）、输出上限与多模态支持；未知指标如实提示，网络或鉴权异常完整报错。
- **多平台深度融合**：针对 Linux (WebKitGTK) 与 Windows (WebView2) 针对性解决系统级差异（如原生剪贴板图像读取、大文本转附件、文件选择器与控制台 GBK/UTF-8 字符集自适应）。

---

## 🚀 核心特性全景

### 1. 智能交互与会话流（对齐 ZCode）
- **双层输入胶囊（LexicalComposer）**：
  - 富文本编辑、`@` 快速引用上下文、`/` 斜杠内置与自定义命令扩展。
  - 支持多图粘贴与拖拽，针对 WebKitGTK 环境深度优化剪贴板读取，超长文本（≥15KB）自动转存为文件附件引用。
- **模型与推理强度动态调度**：
  - 会话级模型快捷切换菜单，支持服务商分组、技术指标徽标展示。
  - **任务级独立模型记忆**：多任务窗口完全隔离，切换任务自动还原专属模型与推理等级，新建任务不产生配置污染。
  - **Reasoning Effort 6 档联动**：支持 `Default / Low / Medium / High / XHigh / Max`，与大模型步数（100~600 steps）及协议参数严格映射。
- **对话问题导航条（ConversationNavigator）**：
  - 浮动于消息区左侧，以用户提问为刻度，支持悬停双段预览、山峰衰减视觉动效与平滑视口定位。
- **任务进度与结构化交互**：
  - **任务清单胶囊（TaskProgressBar）**：多份 Todo 计划支持并排展示、圆环进度动态推进与 Popover 展开。
  - **交互式提问（AskQuestionCard）**：模型主动提问（`ask_user`）改版为单弹窗多 Tab 体验，支持收起为输入框悬浮徽章。

### 2. Agent 运行回路与安全审批
- **精细化工具集与尺寸闸门**：
  - 核心内置工具：`read_file`（2000行/256KB 上限）、`write_file`、`edit_file`、`list_dir`（8KB）、`exec_command`（30KB 内联收集）。
- **四档审批模式（ApprovalMode）**：
  - `plan`（计划模式，只读调研拦截修改）、`ask`（变更前审批）、`edit`（自动放行编辑，执行命令弹窗）、`full`（完全访问直通）。
  - 基于 `beforeToolCall` 挂起机制，审批触发时 Agent 运行回路安全暂停，决策后即时恢复。
- **代码改动检查点与原子回退（Checkpoint & Rewind）**：
  - 文件修改前由 Rust 后端自动留存前像，UI 支持逐轮代码改动撤销，具备 SHA-256 指纹 TOCTOU 冲突防护。

### 3. 多模型服务商与真实协议接入
- **多协议原生适配**：支持 `Chat Completions (/chat/completions)`、`Anthropic Messages (/v1/messages)`、`Responses (/responses)` 与 `Google Generative AI (/models)` 协议。
- **Fail-Fast 连通性探测**：切换 API 格式即发起真实握手探测，Base URL 规范化清洗与自动追加 `/v1`。
- **主流与自定义支持**：预设 DeepSeek、OpenAI、Anthropic Claude、Google Gemini、Ollama，并支持自由添加自定义兼容端点。

### 4. 轨迹分析与请求预览（对齐 LiveAgent）
- **轨迹视图（TrajectoryView）**：
  - 对话顶部支持无缝切换「对话 / 轨迹」模式。
  - 提供三泳道时间轴（输入/模型/工具）、表格视图与 8 Tab 详情面板，精确呈现 TTFT 首包耗时、工具消耗与 Token 用量。
- **下一次请求预览**：
  - 与真实发送共享同源装配逻辑（`assembleTurnContext`），发送前即可完整预览系统提示词、工具定义、上下文结构与原始请求 JSON。

### 5. 上下文预算与防截断机制
- **微压缩（Microcompact）**：非侵入式裁剪历史工具结果文本块，不破坏磁盘与 UI 原始数据，确保报文不超限。
- **动态水位线**：基于 `contextWindow - maxOutputTokens` 计算真实可用空间（70% 水位线自动压缩），本地反代放宽至 32MB 护栏，根除超长会话断连。

### 6. 工具链与生态扩展
- **Git 工作台集成**：
  - 顶栏分支快速检出与新建、未暂存/已暂存行级差异对比。
  - 集成 AI 提交信息生成（`CommitDialog`）与空目录一键初始化仓库。
- **局域网 Web 手机远控**：
  - 内置 Axum HTTP/WebSocket 服务，手机扫码鉴权配对，提供免构建单页 Markdown 会话渲染与远程工具审批。
- **语音输入（STT）**：
  - 支持腾讯云、火山引擎、百度千帆、阿里 DashScope 实时语音 WebSocket 转写，输入框草稿无缝接续。
- **生态导入与 Skills/MCP**：
  - 一键从 Claude Code、Codex、OpenCode、Pi 导入历史会话、模型配置、技能与 MCP 服务器。
  - 支持 Model Context Protocol (MCP) 与 ClawHub 技能生态。
- **双配色主题**：
  - 内置 AntiGravity 与 OpenCode 两种消息配色体系，全系统遵循 Tailwind CSS v4 语义变量换肤。

---

## 🏗️ 系统架构

```
ReinAgent 架构全景
├── Frontend (React 19 + TypeScript + Tailwind CSS v4)
│   ├── src/App.tsx                      # 根容器、全局快捷键、主视口分流 (Workbench / Settings)
│   ├── src/store/useAppStore.ts         # 全局响应式状态 (主题、语言、任务、工作区项目)
│   ├── src/components/
│   │   ├── chat/                        # 输入胶囊、消息流、回合分组、审批卡、导航条
│   │   ├── trajectory/                  # 轨迹视图、时间轴泳道、详情面板
│   │   ├── git/                         # 分支切换器、Git 图谱、提交对话框
│   │   ├── sidebar/                     # 侧边栏主体、项目与任务树、长按拖拽重排
│   │   └── settings/                    # 模型服务商、语音输入、导入工作台、远程访问
│   └── src/lib/
│       ├── chat/                        # conversationPool (会话池), conversationModel (状态机)
│       ├── providers/                   # runAgentTurn, modelFactory, assembleTurnContext
│       ├── storage/                     # db.ts (SQLite 内存缓存 + 防抖写透)
│       └── agent/                       # agentRuntime, 核心工具集, 路径决议
│
└── Backend (Tauri 2 / Rust)
    └── src-tauri/src/
        ├── lib.rs                       # Tauri 命令注册与应用生命周期
        ├── conversation_store.rs        # SQLite (WAL) 会话与任务持久化
        ├── checkpoint.rs                # 检查点创建、差异比对与代码回退引擎
        ├── fs_cmd.rs                    # 异步受控文件操作、原生文件夹选择、系统管理器调起
        ├── git_panel.rs                 # Git 分支、状态、提交与推送命令
        ├── remote_server.rs             # 局域网 Axum HTTP/WebSocket 远控服务
        ├── terminal.rs                  # 跨平台伪终端 (PTY) 会话管理
        └── clipboard_image.rs           # Linux 剪贴板原生图像读取适配
```

---

## 📦 技术栈与依赖

- **前端框架**：React 19 + TypeScript 6 + Vite
- **样式与组件**：Tailwind CSS v4 + Radix UI 原语 + Lucide Icons + Motion
- **编辑器与渲染**：Lexical 富文本 + Marked + Shiki (代码高亮) + @pierre/diffs
- **虚拟化与状态**：@tanstack/react-virtual + Zustand
- **桌面与后端**：Tauri 2 (Rust) + Axum + SQLite (rusqlite) + Tokio
- **包管理器**：[Bun](https://bun.sh) (`bun@1.4.2`)

---

## 💻 环境要求

- **操作系统**：
  - **Linux**：Ubuntu 22.04+ / Debian 12+ / Arch 等（需安装 `webkit2gtk-4.1` 或 `webkit2gtk-4.0`）
  - **Windows**：Windows 10 / 11（需安装 Microsoft Edge WebView2 运行时，系统通常自带）
- **开发运行时**：
  - [Bun](https://bun.sh) ≥ 1.1（建议严格使用 `bun@1.4.2`）
  - [Node.js](https://nodejs.org) ≥ 20（用于运行部分 Node 原生测试）
  - [Rust](https://rustup.rs) (stable)

---

## 🛠️ 快速上手

### 1. 安装依赖
```bash
bun install
```

### 2. 开发模式运行
启动前端开发服务器与 Tauri 桌面窗口：
```bash
bun run tauri dev
```

### 3. 代码验证与单元测试
ReinAgent 配备了严谨的分域单元测试矩阵：

```bash
# 执行全部关键子领域测试
bun run test:chat               # 会话模型、控制器、导航条、状态机测试
bun run test:providers          # 模型工厂、审批门、工具策略测试
bun run test:agent              # Agent 运行时、工具集、工作区路径决议测试
bun run test:git                # Git 分支切换与冲突处理逻辑测试
bun run test:hub                # 技能中心与 MCP 注册表测试
bun run test:settings           # 设置项持久化测试
bun run test:markdown           # Markdown 渲染块解析测试
bun run test:assistants         # 助手人设解析测试
bun run test:import             # 外部生态会话与配置导入测试
bun run test:promptEnhancement  # 提示词增强模板与流式生成测试

# 全局 TypeScript 类型检查
bun run tsc --noEmit

# Rust 后端类型与命令检查
cd src-tauri && cargo check && cargo test
```

### 4. 生产打包构建
```bash
# 构建正式可分发安装包 (产物输出至 src-tauri/target/release/bundle/)
bun run tauri build
```

---

## 📁 目录结构

```
ReinAgent/
├── src/                          # 前端源代码
│   ├── assets/                   # 静态字体、图标等资源
│   ├── components/               # React UI 组件 (chat, settings, sidebar, git, trajectory 等)
│   ├── hooks/                    # 通用 React Hooks
│   ├── i18n/                     # 中英双语国际化字典
│   ├── lib/                      # 核心业务逻辑 (agent, chat, providers, git, stt, storage 等)
│   ├── preview/                  # 右侧代码与差异预览面板组件
│   ├── store/                    # Zustand 全局 Store (useAppStore.ts)
│   ├── styles/                   # 全局样式与 CSS 语义主题变量 (global.css)
│   ├── App.tsx                   # 顶层工作台与视图路由
│   └── main.tsx                  # 应用入口与数据存储初始化
├── src-tauri/                    # Tauri 2 / Rust 后端
│   ├── src/                      # Rust 核心模块 (存储, 检查点, 文件, Git, 远控, PTY 等)
│   ├── icons/                    # 各分辨率桌面图标
│   ├── Cargo.toml                # Rust 依赖声明
│   └── tauri.conf.json           # Tauri 应用配置
├── docs/                         # 规范文档、差距分析与路线图 (ROADMAP, FIXPLAN, TASKS 等)
├── PROJECT_CONTEXT.md            # 项目全景架构与状态单点真相白皮书 (Single Source of Truth)
├── PROMPTS.md                    # 系统提示词单一真相源
└── package.json                  # 项目依赖与运行脚本
```

---

## 🔒 隐私与本地数据说明

- **配置存储**：模型 API Key 存储在本地文件 `~/.ReinAgent/provider_config.json`，不会上传任何三方服务器。
- **对话与任务库**：任务元数据与时间线持久化在本地 SQLite 数据库 `~/.ReinAgent/conversations.db`。
- **代码检查点**：代码修改前快照保存在 `~/.ReinAgent/checkpoints/<taskId>/`，仅供本机会话回退使用。
- **默认工作区**：未指定项目时，默认在 `~/.ReinAgent/DefaultProject/` 开展工作。

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源。
