# ReinAgent 项目全景架构与开发状态白皮书

> **文档定位**：供后续开发 Agent 与工程师快速接手本项目的**单点真相全景指南（Single Source of Truth）**。涵盖系统定位、架构分层、核心交互规范、最新进度、关键状态流转及避坑指南。

---

## 一、项目定位与核心使命

**ReinAgent** 是一个以 **Local-First** 为核心理念的高性能、自主可控的 AI 辅助编程与桌面 Agent 工作台。

- **核心技术栈**：Tauri 2 (Rust 后端) + React 19 + TypeScript + Tailwind CSS v4 + Zustand + Lexical 富文本编辑器。
- **设计与体验对齐**：全面参考顶级 AI 编程客户端（重点参考 **ZCode** 与 **LiveAgent**），在保持极致性能（低内存、毫秒级响应）的同时，实现高度可定制的交互体验。

---

## 二、关键参考源码与规范（⚠️ 必须严格遵守）

根据项目全局规范，严禁对任何打包文件（如 `.asar` 或二进制产物）进行反编译。研究实现原理与交互细节时，**必须直接查阅以下本地源码仓库**：

1. **ZCode 完整源码**：
   - 路径：`/home/web3claw/DevCode/ReinAgent/ZCode`
   - UI 组件库：`/home/web3claw/DevCode/ReinAgent/ZCode/packages/ui/`
     - 侧边栏与布局：`packages/ui/src/WorkspaceSidebar.tsx`、`WorkspaceSidebar/WorkspacePurposeSection.tsx`
     - 提示与交互：`packages/ui/src/ControlHintTooltip.tsx`
     - 偏好持久化：`packages/ui/src/lib/sidebarPurposeSectionPreferences.ts`
   - 核心前端包：`packages/` 与 `apps/`
2. **LiveAgent 完整源码**：
   - 路径：`/home/web3claw/DevCode/ReinAgent/LiveAgent`
   - Rust / Tauri 后端与工具实现：`crates/`
   - 客户端与生态接入：根目录及相关实现

---

## 三、系统架构与分层设计

```
ReinAgent 架构全景
├── Frontend (React 19 + TypeScript + Tailwind CSS v4)
│   ├── src/App.tsx                     # 根容器、全局快捷键、主视口分流 (Workbench / Settings)
│   ├── src/store/useAppStore.ts        # 全局响应式状态 (主题、语言、任务、工作区项目、终端控制)
│   ├── src/i18n/index.ts               # 轻量级中英文国际化双语字典 (zh-CN / en-US)
│   ├── src/components/
│   │   ├── sidebar/
│   │   │   ├── WorkspaceSidebar.tsx    # 侧边栏主体：品牌 Header、快捷操作、分组/项目 Tab、用户信息
│   │   │   └── ProjectList.tsx         # 项目与任务类目：折叠展开、长按拖拽重排、Tooltip 触发、时间流
│   │   ├── chat/
│   │   │   ├── LexicalComposer.tsx     # 双层对齐胶囊输入框、工作区项目选择器、@ 上下文、/ 快捷指令
│   │   │   ├── MessageList.tsx         # 会话流列表与滚动控制
│   │   │   ├── MessageItem.tsx         # 消息渲染（Markdown、代码块、思考折叠、工具调用、Diff）
│   │   │   └── EmptyState.tsx          # 欢迎页、快捷动作卡片
│   │   ├── terminal/
│   │   │   └── TerminalPane.tsx        # XTerm 终端集成与底栏展示
│   │   ├── settings/
│   │   │   └── SettingsPage.tsx        # 模型服务商、API Key、端点配置页面
│   │   └── ui/
│   │       └── Tooltip.tsx             # 基于 @radix-ui/react-tooltip 的通用精致提示浮层
│   └── src/lib/
│       ├── chat/                       # 会话控制器 (conversationController, stateBridge, useConversation)
│       ├── providers/                  # 模型路由与 Provider 抽象 (DeepSeek, OpenAI, Claude, Faux 演示)
│       └── agent/                      # 本地 Tool 执行与 AgentTurn 调度循环
└── Backend (Tauri 2 / Rust)
    └── src-tauri/
        ├── src/main.rs                 # Tauri 入口、窗口管理
        ├── src/lib.rs                  # 命令注册
        ├── src/terminal.rs             # 伪终端 (PTY) 会话管理与流转发
        └── src/fs_cmd.rs               # 异步受控文件与命令执行 (spawn_blocking 隔离防窗口卡死)
```

---

## 四、核心交互与 UI 规范现状

### 1. 侧边栏类目与拖拽排序（对齐 ZCode PurposeSection 原理）
- **默认排序**：`项目` 在上，`任务` 在下。
- **折叠展开持久化**：
  - `项目` 与 `任务` 均可通过左侧 `ChevronDown / ChevronRight` 独立展开与折叠。
  - 项目折叠状态保存于 `localStorage["reinagent-projects-section-expanded"]`。
  - 任务折叠状态保存于 `localStorage["reinagent-tasks-expanded"]`。
- **长按/拖拽手柄互换顺序**：
  - 手柄为 6 点图标（`GripVertical`），移除了原生易产生视觉干扰的 `title="Reorder"`。
  - 鼠标在手柄上按住（`onMouseDown`）并上下拖移超出阈值时，实时交换两者的渲染次序，带有高亮过渡。
  - 排序记忆保存于 `localStorage["reinagent-sidebar-section-order"]`，跨会话自动恢复。
- **精致悬浮提示（Radix Tooltip）**：
  - 项目右侧 `+` 按钮：悬停显示 `新建项目` / `New Project`。
  - 任务右侧 `MessageSquarePlus` 按钮：悬停显示 `新建任务` / `New Task`。

### 2. 任务与项目生命周期与隔离架构（对齐 ZCode 会话模型）
- **多任务独立隔离与会话切换恢复（Session Isolation & Instant Task Switching）**：
  - 每个任务独立拥有持久化的消息流（`reinagent-task-msg-${taskId}`），点击左侧侧边栏的任意历史任务时，主视图无缝切换至该任务，并精准恢复其保存在 `localStorage` 中的完整对话历史（含 Markdown 问答、思考过程与工具调用结果）。
  - 加固了切换快照防御机制：采用 `currentMessagesRef` 与非空校验守卫，防止在新建任务或切换离开时被 `clear()` 后的空状态误覆盖历史记录；切换后输入框无缝接续为后续多轮追问模式。
- **草稿态与懒创建机制（Draft Mode & Lazy Creation）**：
  - 点击任何「新建任务」（侧边栏快捷操作、项目右侧 `+` 或 `Ctrl+N`）不直接生成任务，而是回到首页 EmptyState 草稿态（`activeTaskId = null`）。
  - 若在某个具体项目下点击新建，项目下拉框自动预选该项目；若在全局新建，则默认“不在项目中工作”。
  - 自动将光标焦点置入底部输入框，待用户发送第一句后，才正式生成 `AppTask` 并分配 `taskId` 写入存储。
- **标题生成策略（三级标题保障体系）**：
  - **一级（首句即时兜底）**：发送首句瞬间，前 30 字符即时作为初始任务标题挂载，确保侧边栏立刻可见；
  - **二级（异步 AI 智能提炼）**：后台 sidecar 异步触发模型总结，自动识别配置的 Provider（DeepSeek、OpenAI、Anthropic Claude、Google Gemini、Ollama 等）并适配对应的 REST 协议与鉴权头。严格遵循 3~7 词摘要约束与 think 过滤，提炼完成后平滑更新任务标题并同步落盘；
  - **三级（本地规则语义提炼降级）**：若在无 Key 演示模式、弱网断网或 API 异常时，自动执行本地语义提炼（剥离口语前缀“你好/请帮我/请问”、去除末尾问号标点），截取核心动宾短语，确保即便在无 Key 状态下任务标题依然精简可读。
- **任务与项目 CRUD 交互规范（深度对标 ZCode）**：
  - **任务置顶（Pin / Unpin）**：
    - 鼠标悬停任务行时左侧显示图钉图标（`Pin`），点击自由切换置顶状态；
    - 已置顶任务图钉常驻显示且带有品牌色高亮，列表中**所有置顶任务优先固定在最顶部**展示；
    - 属性字段 `pinned?: boolean` 同步落盘至 `reinagent-tasks`。
  - **行内二次确认删除（无阻塞式）**：
    - 悬停点击删除垃圾桶按钮时，不调用任何系统级阻塞弹窗（`window.confirm`）；
    - 右侧原地平滑切换为红色圆角胶囊「确认」（`Confirm`）按钮与取消「✕」按钮；
    - 点击「确认」正式执行删除并清理消息分片；按 `Esc` 键或在列表外部点击任意位置自动安全回退取消。
  - **任务行内重命名**：支持悬停点击编辑图标触发行内输入框，回车或失焦确认更新。
  - **自定义项目管理**：支持添加自定义项目、重命名（级联更新已有任务的项目归属）以及删除项目。
  - **顶栏清爽化**：移除了原有的全局「清空对话」按钮，避免打断当前任务或误清空多会话上下文。

### 3. 双层胶囊输入框（LexicalComposer）
- **结构**：上下双层严格对齐胶囊形态，采用平滑圆角与自适应边框。
- **上层**：项目工作区选择器，支持关键词搜索过滤、打开本地文件夹、远程连接切换以及“不在项目中工作”。
- **下层**：Lexical 编辑区、`@` 触发上下文菜单、`/` 触发命令菜单、变更前确认模式（✋）、推理深度（off/low/medium/high/max）、发送/中止按钮。

### 4. 顶栏操作与国际化
- **中英文切换**：融合版 SVG 地球仪镂空刻字图标，根据当前语言动态镂空刻印 `中` 或 `EN`。
- **亮暗主题**：全系统变量级 CSS 变量换肤，支持即时切换并持久化保存。

---

## 五、状态存储键名速查（LocalStorage）

| 键名 (Key) | 类型 / 格式 | 用途说明 |
| :--- | :--- | :--- |
| `reinagent-theme` | `"dark" \| "light"` | 当前界面主题 |
| `reinagent-locale` | `"zh-CN" \| "en-US"` | 国际化语言 |
| `reinagent-sidebar` | `"true" \| "false"` | 侧边栏收起/展开状态 |
| `reinagent-sidebar-section-order` | `["projects", "tasks"]` | 侧边栏类目排列次序 |
| `reinagent-projects-section-expanded`| `"true" \| "false"` | 项目类目本身展开/收起 |
| `reinagent-tasks-expanded` | `"true" \| "false"` | 任务类目本身展开/收起 |
| `reinagent-projects-open-groups` | `Record<string, boolean>` | 每个具体子项目的折叠状态 |
| `reinagent-tasks` | `AppTask[]` | 任务元数据列表（id, title, createdAt, updatedAt, project, pinned） |
| `reinagent-task-msg-${id}` | `Message[]` | 各任务独立分片持久化的对话完整消息记录 |
| `reinagent-custom-projects` | `ProjectItem[]` | 用户自定义添加的项目集合 |
| `reinagent-active-task-id` | `string \| null` | 当前活动的任务 ID（null 为草稿/首页） |

---

## 六、Linux 编译、运行与环境隔离规范（严格基于 run-linux.sh）

由于宿主工程目录位于网络共享盘（CIFS/SMB 文件系统不支持 Linux 符号链接与标准文件锁机制），为了防止 `bun install` 软链接失败或 Cargo 编译锁死，**所有构建、类型检查与运行必须严格遵循 `run-linux.sh` 的环境隔离配置**：

### 1. 核心隔离参数
- **本地工作区**：`WORK_DIR="/tmp/reinagent"`
- **Rust Target 目录**：`TARGET_DIR="/tmp/reinagent/target"`（通过 `export CARGO_TARGET_DIR="$TARGET_DIR"` 挂载）
- **依赖隔离**：原生 Linux node_modules 安装在 `/tmp/reinagent/node_modules` 下。

### 2. 标准编译与验证命令
```bash
# 1. 增量同步源码至本地临时工作区
rsync -av --delete --exclude 'node_modules' --exclude 'target' --exclude '.git' /home/web3claw/DevCode/ReinAgent/ReinAgent/ /tmp/reinagent/

# 2. 前端类型检查与打包构建
cd /tmp/reinagent && bun run build

# 3. 单元测试 (Chat 状态机模型与调度逻辑)
npm run test:chat
```

### 3. 本地启动脚本执行（run-linux.sh）
- **启动前端 Vite 服务**：端口 `1420`，`(cd /tmp/reinagent && bun /tmp/reinagent/node_modules/vite/bin/vite.js --port 1420) &`
- **启动 Tauri 桌面应用**：`cargo tauri dev -c '{"build": {"beforeDevCommand": ""}}'`

### 4. 自动化无头视觉回归
本地运行 dev server 后（默认端口 1420），可通过 Chrome 无头模式快速截取实际渲染图像进行像素级对比：
```bash
google-chrome --headless --disable-gpu --screenshot=/tmp/screen.png --window-size=1280,800 http://localhost:1420
```

---

## 七、核心架构守则与避坑指南

1. **包管理器限制 (Package Manager Rule)**：
   - 项目采用 **Bun**（`bun@1.4.2` 与 `bun.lock`）。
   - 严禁使用 npm/pnpm 篡改依赖锁定文件；所有依赖安装与更新必须在 `/tmp/reinagent` 隔离区进行，防止损坏网络共享挂载盘的软链接。
2. **Tauri 2 + Web 双模兼容 (Dual-mode Compatibility Rule)**：
   - 涉及系统级能力（终端 PTY、受控文件操作等）时，必须保留 Web Mock / Fallback 兼容层，保证在 Headless Chrome（无头自动化测试/截图回归）或普通浏览器中依然能完整渲染并正常调试。
3. **Tailwind CSS v4 语义化主题 (Theme Styling Rule)**：
   - 严禁在组件中硬编码 Hex/RGB 颜色值；必须使用 `src/styles/global.css` 定义的 CSS 语义变量（如 `var(--bg)`、`var(--sidebar-bg)`、`var(--sidebar-text)`、`var(--border)`），确保跟随 `data-theme="dark|light"` 自动平滑换肤。
4. **Git 与工作区保护 (Workspace Discipline)**：
   - 未经用户明确许可或要求，**严禁自行调用 `git commit` 或 `git push`**。
   - 测试产物、截图、中间日志等临时文件必须存放于 `/tmp/`，严禁污染工程工作树。

---

## 八、后续迭代方向推荐

1. **项目管理真正落地**：
   - 目前项目为 Mock 数据，需打通 Tauri 原生对话框（`dialog.open`）选择真实本地目录。
   - 读取真实目录生成文件树（结合 ZCode `WorkspaceSidebarItem` 的树形渲染逻辑）。
2. **多会话持久化与导出**：
   - 将各个任务的聊天消息序列保存到本地 Sqlite 或 JSON 存储中，点击不同任务时真正恢复历史对话记录。
3. **Agent 工具执行沙箱**：
   - 完善 Rust 端的命令执行拦截与“变更前确认”审批流（ApprovalMode）。

