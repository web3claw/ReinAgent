# ReinAgent 项目全景架构与开发状态白皮书

> **文档定位**：供后续开发 Agent 与工程师快速接手本项目的**单点真相全景指南（Single Source of Truth）**。涵盖系统定位、架构分层、核心交互规范、最新进度、关键状态流转及避坑指南。
>
> **配套文档**：[PROMPTS.md](./PROMPTS.md)（提示词单一真相源）、**[ROADMAP.md](./docs/ROADMAP.md)（三方功能差距分析 vs LiveAgent/ZCode + 优先级路线图，2026-09-28）、**[TASKS.md](./docs/TASKS.md)（P0 起步的分步开发任务清单，可验证可测试）**。

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
│   │   │   ├── LexicalComposer.tsx     # 输入胶囊：附件/图片粘贴、模型切换、推理等级、审批模式下拉
│   │   │   ├── Composer.tsx            # 输入胶囊壳（附件条、Lightbox 挂载）
│   │   │   ├── MessageList.tsx         # 会话流列表：虚拟化 + live tail 拆分 + 贴底跟随状态机
│   │   │   ├── MessageItem.tsx         # 消息渲染（Markdown、图片气泡、错误详情、重试按钮）
│   │   │   ├── TurnGroupView.tsx       # 回合分组：状态条/重连副行/查阅聚合卡/文件更改摘要卡
│   │   │   ├── ThinkingBlock.tsx       # 思考块三态折叠
│   │   │   ├── ToolCallCard.tsx        # 工具卡（类型化 header、终端卡、diff 视图）
│   │   │   ├── ApprovalCard.tsx        # 工具审批卡（允许/总是允许/拒绝）
│   │   │   ├── RetryDetailsBlock.tsx   # 重试详情折叠块（每次尝试错误原文卡片）
│   │   │   ├── ConversationNavigator.tsx # 对话问题导航条
│   │   │   ├── SessionStatsBar.tsx     # 会话统计行（轮/步/上下文/耗时/token）
│   │   │   ├── ContextUsageIndicator.tsx # 上下文容量圆环触发器 + HoverCard 面板
│   │   │   ├── ImageLightbox.tsx       # 图片放大浮层（附件缩略图与气泡共用）
│   │   │   ├── MarkdownText.tsx / MarkdownBlockRenderer.tsx / CodeBlock.tsx # Markdown 渲染链
│   │   │   └── EmptyState.tsx          # 欢迎页、快捷动作卡片
│   │   ├── terminal/
│   │   │   └── TerminalPane.tsx        # XTerm 终端集成与底栏展示
│   │   ├── settings/
│   │   │   └── SettingsPage.tsx        # 模型服务商、API Key、端点配置页面
│   │   └── ui/
│   │       └── Tooltip.tsx             # 基于 @radix-ui/react-tooltip 的通用精致提示浮层
│   └── src/lib/
│       ├── chat/                       # conversationPool（会话池）、conversationController（调度+重试裁决）、
│       │                               # conversationModel（纯状态机）、stateBridge、errors（错误链展开/诊断）、
│       │                               # turnActivity（回合分组）、useConversation、titleGenerator、contextUsage
│       ├── providers/                  # runAgentTurn（系统提示词+审批门）、modelFactory、catalog、fauxSource
│       └── agent/                      # agentRuntime（Agent 循环）、tools（五工具）、workspace（路径决议）
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

### 3. 双层胶囊输入框（LexicalComposer）与推理等级调度
- **下层**：Lexical 编辑区、`@` 触发上下文菜单、`/` 触发命令菜单、变更前确认模式（✋）、**模型快捷切换下拉菜单（Model Selector Dropdown）**、推理等级选择器、发送/中止按钮。
- **模型快捷切换菜单（Model Selector Dropdown）与多任务独立模型记忆机制**：
  - 点击底栏 `{服务商}/{模型名称}` 按钮弹出向上浮动的精致卡片菜单（与推理等级弹窗风格统一）；
  - **动态聚合已启用的模型**：按服务商（如 DeepSeek、OpenAI、自定义等）分组展示其下 `enabled !== false` 的全部模型；
  - **技术指标丰富呈现**：每一项展示模型名称、紧凑上下文窗口徽标（如 `1M`、`128K`）及 `[视觉]` 徽标；当前选中模型带有指示圆点与高亮；
  - **即时切换与会话级状态隔离**：点击任意模型后，**仅切换当前对话会话使用的服务商与模型**，立即生效并联动推理等级；**绝不修改或覆盖“服务商设置”里的系统默认模型**（系统默认模型依然牢牢固定在设置页面中通过“设为系统默认”指定的模型上）。
  - **任务级独立模型持久化与多窗口隔离（Task-Level Model Isolation & Persistence）**：
    - `AppTask` 数据模型扩展可选字段 `providerId?: string; modelId?: string;`，伴随任务列表自动持久化于 `reinagent-tasks`；
    - **多任务窗口完全隔离**：在具体任务窗口 A 切换模型时，触发 `updateTaskModel(activeTaskId, providerId, modelId)`，仅更新并持久化当前任务绑定的模型，其他任务窗口不受任何影响；
    - **任务切换生命周期自动还原**：侧边栏切换任务激活时，若目标任务已保存专属模型则精准还原呈现；若目标任务尚未绑定特定模型，或切换至草稿态（`activeTaskId === null`），自动干净回退至系统全局默认配置；
    - **草稿建任务无缝附着**：用户在草稿窗口切换特定模型后发送首条消息时，`createTask` 自动将当前选中的模型绑定给新创建的任务；
    - **新建任务（`+`）彻底清空污染**：点击新建任务时，不仅清空消息时间线，同时将会话模型重置回全局系统默认模型，杜绝上一个任务的定制模型外溢。
- **推理等级（EffortLevel / ThinkingLevel）与最大步数（maxSteps）动态映射**：
  - **6 档标准等级支持**：对齐现代大模型规范，包含 `default`、`low`、`medium`、`high`、`xhigh`、`max` 6 档；
  - **纯英文 UI 与首字母大写**：聊天窗口菜单使用纯英文展示（`Default`、`Low`、`Medium`、`High`、`XHigh`、`Max`），显示激活绿点 `●`、粗体高亮及 `{steps} steps` 徽章；
  - **动态步数映射（2026-09-25 用户定档，每级递增 100 步）**：
    - `default`: 100 steps
    - `low`: 200 steps
    - `medium`: 300 steps
    - `high`: 400 steps
    - `xhigh`: 500 steps
    - `max`: 600 steps
  - **完全访问模式无步数上限**：任务审批模式为 `full` 时 `maxSteps` 传 0（`agentRuntime` 仅在 >0 时启用硬闸；注意不能用 `undefined`——那会在 `runAgentTurn` 回退成 `DEFAULT_MAX_STEPS`=8），硬闸与「继续」机制不再触发；其余模式按上表生效
  - **动态过滤与模型真实能力严格联动（No Fallback）**：
    - 聊天窗口中，若当前模型声明了 `effort.supportedLevels`，**严格仅显示该模型声明支持的档位**，不支持的等级（包括未声明时的 `Default`）在列表中完全过滤隐藏，坚决不进行任何臆测兜底；例如 DeepSeek（支持 `["low", "high", "max"]`）的菜单中严格仅有 `Low`、`High`、`Max` 三项；
    - 模型编辑弹窗（`ModelEditModal`）中，同样通过一排胶囊按钮展示支持的等级，并支持点击直接高亮并设为模型默认等级；若模型上游未声明 effort，可手动开启并从完整档位中选择；
    - 当聊天窗口切换推理等级时，动态同步更新该模型的默认等级并实时写入 `provider_config.json`；
  - **发送给大模型的实际透传机制**：
    - 当选定具体等级（`low` / `medium` / `high` / `xhigh` / `max`）时，直接作为 `thinkingLevel`（在 OpenAI / DeepSeek 中对应 `reasoning_effort`）透传给后端 Agent 运行时；
    - 当选定为 `default`（或 `off`）时，传给后端 `undefined`，由服务端以模型原生的默认推理能力执行。
  - **步数硬闸触顶与一键「继续」机制**：
    - 当单轮工具调用/思考循环达到当前等级的步数上限时，`agentRuntime` 返回 `maxStepsReached: true`，状态机为末条助手消息标上 `truncatedBy: "maxSteps"`；
    - `MessageItem` 在展示「已达最大步数，本次回复已停止。」提示的同时，右侧提供精致的「继续」胶囊按钮（带有 `Play` 图标）；
    - 用户点击后自动发送“请继续执行未完成的步骤”，无缝衔接上一轮未完成的编码/任务流。
- **错误诊断与「重试」机制（2026-09-26 改版，对齐 LiveAgent）**：
  - 对网络抖动/断连（`Connection error`、`failed to fetch`、`socket hang up`、`ECONNRESET` 等）精准识别并映射为友好的「网络错误：连接中断或无法连接服务，请检查网络或代理设置」；
  - 错误行只保留原文 + `errorHint` 双层展示；**手动重试已迁移为 LiveAgent 语义**：助手消息悬停动作栏 RotateCw 确认弹层（「重试该回复？」）→ 以原始提问**截断重发该轮**（见 四点七.2），旧的红色「重试」按钮与「请重试刚才失败的操作」补发逻辑已移除。
- **活动任务 ID 持久化与刷新恢复机制**：
  - `activeTaskId` 实时写入 `reinagent-active-task-id` 本地持久化；
  - 页面刷新（F5 / Ctrl+R）或开发期 Vite 热重载重挂载时，自动精准恢复刷新前正在进行中的任务并加载完整历史消息，绝不退回主页草稿态。

- **原生文件夹选择与多项目管理（Native Folder Picker & Multi-project Management）**：
  - **Linux Webview 局限性与根因解决**：在 Linux Webview 环境下，Web 原生的 `<input type="file" webkitdirectory>` 受沙箱限制无法直接选目录且不提供绝对路径。对齐 LiveAgent 规范，在 Rust 端（`src-tauri/src/fs_cmd.rs`）实现 `fs_pick_folder`，基于 `rfd` 调起原生 OS 文件夹选择对话框，直接获取并返回用户的系统绝对路径。
  - **Web + Tauri 2 双模兼容**：在 Tauri 桌面端调用 `invoke("fs_pick_folder")`；在 Headless Chrome / 浏览器等 Web 环境下平滑回退至 `<input type="file" webkitdirectory>`，确保无头回归测试与 Web 调试全流程不崩。
  - **路径自动持久化与工作区绑定**：
    - 无论是从输入框胶囊顶部的“打开文件夹”，还是侧边栏 Projects 标题栏的“`+` 新建项目”，选中的文件夹绝对路径立即通过 `addProject(path)` 写入 `reinagent-user-projects` 本地持久化；
    - 选中的路径立即设为当前任务的工作区，后续 Agent 文件读取、写入和命令终端执行完全限定在选定目录（或在未指定时 fallback 至 `~/.ReinAgent/DefaultProject`）。
  - **侧边栏项目树与任务分层（对标 ZCode）**：
    - 侧边栏 Projects 分区动态渲染用户打开的项目列表，显示简洁的项目文件夹名，并通过 Tooltip 展示完整绝对路径；
    - 支持项目级快捷操作：悬停点击 `+` 在该项目下开启新任务，点击删除图标（`Trash2`）一键移除项目记录；
    - 支持展开/折叠项目查看其隶属的子任务，点击子任务直接跳转激活；
    - 全局 Tasks 分区专注聚合展示未关联具体项目的通用任务，主次结构层次分明。

- **多模型服务商管理体系（深度对标 ZCode ModelProviderSection）**：
  - **双栏现代交互布局**：
    - **左侧服务商导航栏（ProviderNavigation）**：清晰划分“主流服务商（DeepSeek、OpenAI、Anthropic、Gemini、Ollama）”与“自定义服务商”分组，配备矢量专属 Logo 与状态指示圆点（🟢 已配置并启用 / ⚪ 未配置），右上角支持快捷“+ 添加服务商”；
    - **右侧服务商详情面板（ProviderDetailCard）**：包含服务商总控开关（Switch）、名称行内重命名、API 端点（Base URL）自定义、**API 格式规范选择（深度对齐 ZCode 原生标准，包含 `Chat Completions (/chat/completions)`、`Anthropic Messages (/v1/messages)`、`Responses (/responses)` 与 `Google Generative AI (/models)`）**、密码显隐切换与官网获取 Key 快捷链接；
  - **细粒度模型管理、动态刷新与元数据编辑体系（深度对齐 ZCode 视觉交互规范）**：
    - **模型列表行视觉规范（完全对齐 ZCode）**：
      - **上下文大小 Badge**：显示紧凑技术规格徽标（如 `1M`、`2M`、`128K`、`64K`、`32K` 等），采用等宽字体与深底细边框；
      - **视觉能力 Badge（`[视觉]` / `[Vision]`）**：当模型支持图像输入（`supportsImage: true`）时呈现圆角胶囊徽标，自适应国际化；
      - **模型连通性测通（🔌 `Unplug` 图标）**：点击针对该模型独立发起轻量级握手测试，测通后呈现延迟毫秒数，异常精准报警；
      - **模型元数据编辑（✏️ `Pencil` 图标）**：打开 `ModelEditModal` 模态弹窗，支持可视化修改模型 ID、显示名称、上下文 Token 窗口（提供 32K/64K/128K/200K/1M/2M 快捷预设）、最大输出 Token 数及是否支持视觉输入；
      - **模型删除（🗑️ `Trash2` 图标）**：支持清理不需要的模型，带二次确认提示，若删除的是当前默认模型自动安全回退；
      - **启用/禁用 Switch 开关**：平滑动效 Switch 滑块组件（取代旧复选框），关闭后不出现在会话模型切换菜单中；
    - **真实数据与无假兜底原则（No Fallback & Fail-Fast Rule，项目核心铁律）**：
      - **严禁臆测兜底**：彻底拔除任何基于模型名称正则的硬编码猜测字典（如写死 DeepSeek 65.5K、写死各厂商窗口等）；
      - **100% 真实解析官方 API**：在 `parseProviderRawModels` 中真实完整提取服务端返回的 `context_window`、`max_output_tokens`、`supports_images` / `supports_image` / `input_modalities`（是否包含 `image`）等权威元数据，准确高亮 `[视觉]` 徽章；
      - **未提供即如实展示**：若上游服务商未提供某字段，严禁捏造假数据，UI 必须明确展示为“未提供”或空，并允许用户手动配置；
      - **出错即时完整提示**：接口请求、网络异常或鉴权失败时，严禁静默降级或用旧数据掩盖，必须将完整错误文本即时反馈至界面；
    - **动态远端模型刷新（对标 LiveAgent）**：在“添加模型”前配备“🔄 刷新模型列表”按钮，内置 `fetchProviderModels` 探测引擎，直接请求标准 `/v1/models`，去除任何 404 猜测与二次容错重试，严格真实报错（Fail-Fast）；
    - **Base URL 统一剥离 `/v1` 与请求端自动补全规范（Base URL Normalization Rule）**：
      - **存储与展示规范**：用户在服务商设置面板中输入或展示 Base URL 时，统一不带末尾的 `/v1`、末尾单斜杠或多余斜杠（例如 `http://192.168.3.27:8787`、`https://api.openai.com`）；
      - **输入失焦与写盘强制清洗（`cleanBaseUrl`）**：若用户输入时带了 `/v1`、`/v1/`、`/` 或 `///`，在输入框失焦以及写入 `provider_config.json` 磁盘时，自动剥离清洗干净；
      - **请求端自动追加 `/v1`（`ensureV1BaseUrl`）**：所有面向 OpenAI / Anthropic 兼容协议的网络请求（包括 Agent 聊天对话 `POST /v1/chat/completions`、模型列表刷新 `GET /v1/models`、连通性握手测试 `POST /v1/chat/completions` 以及会话标题后台生成），运行时底层自动补齐 `/v1`，彻底杜绝 `POST /chat/completions → 404` 路由缺失问题，且绝不重复拼接成 `/v1/v1`；
    - **智能增量合并（`mergeFetchedModels`）**：
      - 自动拉取远端模型列表并去重增量追加，新拉取到的模型**默认保持禁用状态（`enabled: false`）**，避免一次性刷新几十个模型撑满聊天栏选择器，由用户自主按需点亮；
      - **手动添加模型**（`ModelEditModal`）时，初始开关保持 **`enabled: true`**；
      - 已有模型的启用开关和自定义名称 100% 保持不变，同时用官方真实返回的最新规格指标补齐未配置项；
    - **模型搜索与过滤**：支持通过 `🔍 搜索模型...` 输入框快速模糊过滤模型 ID 与名称；
    - **主流服务商默认模型清空**：5 大主流预设服务商（DeepSeek、OpenAI、Anthropic、Gemini、Ollama）默认模型列表设为空（`models: []`），初始呈现空引导文案，由用户通过“🔄 刷新模型列表”自动探测拉取或“+ 添加模型”自定义；
  - **向下兼容与后端磁盘持久化（对标 ZCode ~/.ReinAgent/provider_config.json）**：
    - 多服务商完整配置由 Tauri/Rust 后端维护，直接独立持久化存储至宿主用户主目录下的 `~/.ReinAgent/provider_config.json`（避免浏览器 LocalStorage 容量限制或清理丢失）；
    - 前端通过 Tauri IPC 命令 `provider_config_load` / `provider_config_save` 实时异步读写；
    - 支持一键“设为默认”，自动将选中的服务商与模型映射回底层 `settings.json`（`provider`、`modelId`、`apiKey`、`baseUrl`），确保现有对话模型、代码生成与终端执行 100% 无缝衔接。

### 4. 对话问题导航条（ConversationNavigator，对齐 ZCode ConversationTurnNavigator）
- **布局与显隐**：
  - 覆盖式绝对定位（`absolute z-10`）浮于消息滚动区**左缘**（App.tsx 中 hasMessages 分支外层 `relative flex` 包装层承载），**不占布局空间**，不挤压 `max-w-2xl` 居中的消息内容；
  - 显隐规则对齐 ZCode：用户提问 < 2 条或容器宽 < 864px 时整体隐藏（`NAVIGATOR_MIN_ITEMS` / `NAVIGATOR_MIN_VISIBLE_WIDTH`）；
  - 上下留白 48px / 96px（下部额外避让吸底输入胶囊）。
- **刻度粒度**：**每条用户提问一根刻度**（`role === "user"`），助手回复与工具调用不产生刻度，仅体现在悬停预览中；
- **高度自适应规格（已确认）**：默认初始高度 **240px** 垂直居中；节点槽位 = 目标高度 ÷ 刻度数，双向钳制 **[10px, 24px]**（最小间距 10px 与 ZCode 刻度槽位 `h-2.5` 一致）；当 `刻度数 × 10 > 可用高度` 时锁定 10px 并进入**内部滚动**（`.navigator-rail` 隐藏滚动条）；
- **交互**：
  - **悬停**：Radix Tooltip（复用既有 `@radix-ui/react-tooltip` 依赖，Portal 防裁剪）弹出双段预览卡——用户提问预览 2 行 + 助手回复预览 3 行；220 字符 / 2 段截断（`truncatePreview`，纯文本不渲染 Markdown）；流式中显示「生成中…」，无回复显示「（尚无回复）」；
  - **点击**：手动计算 `scrollTop` 平滑跳转（目标行距视口顶 16px 呼吸），`prefers-reduced-motion` 时退化为瞬时定位；跳离底部后 `MessageList` 现有贴底跟随（120px 阈值）自然解除，零侵入；
  - **山峰衰减动效**：悬停时刻度短横线按距离呈山峰状放大（scaleX 2.6 / 1.7 / 1.25，opacity 1 / 0.86 / 0.72，远处 1 / 0.58），`motion-reduce` 兼容；
- **active 高亮**：无 IntersectionObserver，scroll 事件（rAF 节流）+ 锚点内容坐标几何计算（`resolveActiveAnchor`：取首个与视口相交的刻度行 `[start_i, start_{i+1})`，无相交回退视口顶上方最近一条）；
- **实现分层**：纯逻辑层 `src/lib/chat/conversationNavigatorHelpers.ts`（刻度构建 / 预览截断 / 自适应布局 / active 判定 / 山峰视觉，全部具名常量）+ 组件层 `src/components/chat/ConversationNavigator.tsx`；用户消息行由 `MessageItem` 打 `data-msg-id` 锚点；
- **a11y**：`role="navigation"`、每刻度为 button（`aria-label` 跳转文案、`aria-current="location"`、`aria-posinset/setsize`）；
- **i18n 键**：`turnNavigatorLabel`（对话问题导航 / Conversation query map）、`turnNavigatorJump`（含 `{index}` 占位）、`turnNavigatorEmptyReply`、`turnNavigatorRunning`；
- **测试**：`conversationNavigatorHelpers.test.mjs` 17 用例（截断规则 / 刻度构建 / 布局映射表 / active 几何 / 山峰参数），已挂进 `bun run test:chat`。

### 5. 回合工作状态展示（对齐 ZCode ConversationTurnGroup / Reasoning / ToolCallBlocks）
- **时间打点（数据层）**：`ChatMessage` 扩展纯展示字段 `startedAt` / `endedAt`（assistant 轮与工具条目）、`thinkingStartedAt` / `thinkingDurationMs`（首个 thinking_delta 起点 → 首个 text_delta / thinking_end 冻结）；由 `conversationController` 的注入时钟（`deps.now`）传入 `beginAssistant` / `applyEvent` / `applyLibraryEvent` / `finish` / `finishAborted`（新增可选 `nowMs` 参数）。**绝不参与 `toApiMessages`**；
- **按轮分组**：`groupTurns(messages)`（`src/lib/chat/turnActivity.ts`）——user 消息开轮至下一条 user 前；轮工时 = 最早 startedAt → 最晚 endedAt（运行中 = now 现算）；MessageList 按轮渲染并持有 1 秒 `setInterval` live tick（仅存在运行中轮时启动，对齐 ZCode 不用 rAF）；
- **运行中判定含会话级兜底**（2026-09-24 修复闪烁）：多步工具循环的轮与轮之间存在瞬态空窗（上一轮条目已 done、下一轮未建条目），仅凭条目状态判 running 会让状态条/思考块「展开→收缩→展开」闪烁——现由 App 透传 `isStreaming`，将**流式中的最后一轮**钉在 running（`live` prop），整个 Agent 循环期间状态条恒为「工作中」、思考块恒展开，循环结束才统一翻转折叠；
- **回合工作状态条（TurnGroupView）**：三态文案——运行中「工作中 {时长}」（**锁定展开、按钮 disabled、不渲染箭头**）/ 完成「已工作 {时长}」（**默认折叠、可展开**，运行→完成自动翻转折叠）/ 中止「已停止」；**历史消息无打点时如实显示「已处理」，绝不伪造时长（No-Fallback）**；时长格式化 `formatWorkDuration`（`Math.max(1, round)` 整秒、最多两段最靠前非零单位，中文「3 分 48 秒」/ 英文「3m 48s」）；
- **折叠体内容**：思考块（ThinkingBlock）+ 工具调用卡（ToolCallCard）+ 中间叙述文本（非末条 assistant 的正文）；**最终回复正文（轮内最后一条 assistant）在轮结束后外显**。**时间线不变式（2026-09-27，修复卡片位置漂移）**：工具条目在状态机里诞生于所属 assistant 消息之后，运行中最后一条 assistant 的正文**就地**渲染在折叠体的时间线位置（亮色 + ChatLoading，样式对齐 MessageItem 正文；纯文本轮靠 `liveAnswerInBody` 让折叠体仍渲染），轮结束后才由外显 MessageItem 接管——工具卡出现时必然落在正文下方且永不移动，彻底消除轮次切换时「卡片在简述上面↔下面」的跳动（对齐 ZCode `conversationTurnRenderUnits` 的 orderedRows 严格按产出顺序渲染，无「末条钉底」规则）；
- **思考块（ThinkingBlock）**：header「思考 · 持续了 N 秒」（整秒向上取整；无打点如实显示「持续了几秒」）+ 流式「正在思考」；默认收起；正文最暗文字层（`--text-dim` + 透明度）+ 左导线缩进 + 限高 240px 滚动 + `whitespace-pre-wrap` 纯文本；
- **查阅族独立卡（「查阅」聚合卡已按用户决策移除，2026-09-27）**：`list_dir` / `read_file` 不再聚合为组卡（`EXPLORE_TOOL_NAMES`/`buildActivityItems`/`ExploreGroupCard` 已删除），直接以独立卡渲染——**对齐 ZCode `ReadToolCallBlock` 独立形态**：类型标签（`读取`/`列出`，i18n `toolKindRead/List`，运行中 `正在读取/正在列出` 扫光由 ToolLayout 自动附加）+ Material 文件/文件夹图标 chip + 文件名 + 父目录段次要文本（`renderFilePath` 同款）；**成功不显示状态词，失败才显示「执行失败」**（`showFailureStatus` + tooltip 带错误原文，对齐 ZCode read 卡只传 showFailureStatus 的语义）；`read_file` chip 可点击在右侧面板打开文件预览，`list_dir` 目录 chip 不可点击（对齐 ZCode `canOpenPreview` 仅 file）；list_dir 工作区根（`.`）显示「当前目录」；`ToolCallCard` 的 `showIcon` prop 保留（透传 ToolLayout，默认 true）；
- **工具卡类型化**：header = 类型图标（read/list/write/edit/exec/calc → lucide 图标）+ 类型标签（`toolKindLabel`：读取/查阅/写入/编辑/终端/计算，**未知工具如实回退原名，不臆测分类**）+ 文件 chip（`toolArgPath` 取 basename，title 全路径）/ 终端命令内联摘要（收起即可见命令，`tool-cmd-inline` 尾部截断）+ `+N/－N` diff 统计（LCS 精确口径；绿 `--diff-added` / 红 `--diff-removed` 主题变量）+ 状态词（执行中/已执行/执行失败，i18n）；
- **终端卡（exec_command）**：`$ 命令`（mono、限高折行）+ 输出区**吸底-冻结引擎**（移植 ZCode ExecuteOutput：运行中每帧贴底；用户上滚 → 冻结跟随保留阅读位；滚回底部 → 恢复跟随；`hasStreamed` 守卫防静态结果误判）；输出区限高 120px 滚动，无输出如实显示「没有输出。」；
- **编辑/写入卡 diff 视图**：展开为逐行 diff（`computeToolDiffLines` → `computeLineDiff` 行级 LCS，零依赖，`DIFF_MAX_LINES=500` 上限保护）——行号跨增删连续计数 + `+`/`−` 符号列 + 增行绿底（`--diff-added-bg`）/ 删行红底（`--diff-removed-bg`）+ mono 限高 240px 滚动；`write_file` 视为全新增；失败附错误信息；语法高亮（Shiki）暂不引入（ZCode 亦需异步分帧防掉帧，后续单独评估）；保留失败默认展开、运行中无结果不渲染空折叠、`React.memo`；
- **a11y**：状态条为 button（运行中 disabled）+ `aria-expanded`；工具卡 `aria-label` / `aria-busy`；
- **i18n 键**：`turnWorking`/`turnWorked`/`turnWorkedNoDuration`/`turnStopped`（含 `{duration}` 占位）、`thinkingLabel`/`thinkingLive`/`thinkingFewSeconds`/`thinkingSeconds`（`{seconds}` 占位）、`toolStatusRunning`/`toolStatusDone`/`toolStatusFailed`/`toolPending`/`toolNoOutput`/`toolResult`；
- **测试**：`turnActivity.test.mjs` 15 用例（切轮、无 user 历史兼容、运行/完成工时聚合、四态判定、时长格式化、diff 口径、工具分类回退），已挂进 `bun run test:chat`。

### 6. 顶栏操作与国际化
- **中英文切换**：融合版 SVG 地球仪镂空刻字图标，根据当前语言动态镂空刻印 `中` 或 `EN`。
- **亮暗主题**：全系统变量级 CSS 变量换肤，支持即时切换并持久化保存。

---

## 四点四、流式渲染性能架构（对齐 ZCode，2026-09-25）

消息时间线按 ZCode ConversationTimeline 的五层性能架构实现（`MessageList.tsx`）：

1. **生产端节流**：池层 notify 走 30ms 节流窗（leading 立即 + trailing 合并，`NOTIFY_FLUSH_MS`），密集 delta 下 UI 每帧最多渲染一次；状态更新本身保持同步。
2. **引用稳定 + 行级 memo**：`groupTurns` 结果引用稳定化（entries 未变的轮复用旧 group 对象）；`TurnGroupView` / `ToolCallCard` / `MarkdownText`（text+streaming 双键）/ `MarkdownBlockRenderer` 全部 memo——流式时每帧只有正在流的轮重渲染。
3. **虚拟化 + live tail 拆分**：`@tanstack/react-virtual`（轮为单位，稳定 key，overscan 4，行高 LRU 缓存 `TurnHeightCache` 上限 4000）；**正在流式的最后一轮拆出虚拟列表放普通文档流**（消除流式长高回填跳动）；`scrollMargin` 动态测量 App 内边距包装；轮偏移注册表 `turnOffsetRegistry` 供导航条屏外轮兜底（`getRegisteredTurnOffset` → `ConversationNavigator.measureFallback`）。
4. **流式降级**：`streaming` prop 贯穿 MarkdownText → MarkdownBlockRenderer → CodeBlock，流式中的代码块跳过 Shiki 异步高亮（plain 渲染），流式结束自动恢复；`renderKey`/memo 键含 streaming 防子树错位。
5. **滚动权状态机**：following 存 ref；wheel/touch/键盘 capture 阶段预登记用户上滚意图（同帧解除跟随，不等 scroll 事件）；程序化贴底打 120ms 时间戳标记（窗内 scroll 事件不参与跟随判定）；贴底 `scrollTop = scrollHeight` instant 直赋；内容子树 `overflowAnchor: none` 禁用浏览器原生锚定；liveNowMs tick 只驱动正在流式的轮。

## 四点五、系统提示词单一真相源（PROMPTS.md，2026-09-25）

系统提示词的完整记录与 ZCode 借鉴映射见 **[PROMPTS.md](./PROMPTS.md)**：
- 第一部分：ZCode 提示词原文摘录（Communicating / Code style / Autonomy / Git / Environment / Edit-Read 失败文案 / 证据标准，含源码路径行号）；
- 第二部分：ReinAgent 当前全部提示词（DEFAULT_SYSTEM_PROMPT 分段、buildEnvironmentSection 动态段、PLAN_MODE_PROMPT / APPROVAL_HINT、五工具描述与失败文案、审批门/计划模式拦截文案、权限分级）；
- 第三部分：采纳映射表与待办（gitStatus 快照、记忆、AGENTS.md 注入、压缩、防注入包装等）。

**铁律**：修改 `DEFAULT_SYSTEM_PROMPT`、`buildEnvironmentSection`、`PLAN_MODE_PROMPT`、`APPROVAL_HINT_PROMPT` 或任何工具描述/失败文案时，必须同步更新 PROMPTS.md。

## 四点六、界面字号体系（对齐 ZCode，2026-09-26）

全部 UI 字号以 `src/styles/global.css` 的 **`--ui-font-size: 20px`** 为单一基准（对齐用户 ZCode 实例的界面字号设置），严禁散落硬编码：

- **`text-ui-*` 派生刻度**（语义刻度，新代码优先用）：`--text-ui-xl`(+4) / `--text-ui-lg`(+2) / `--text-ui-base`(=基准) / `--text-ui-caption`(−1) / `--text-ui-sm`(−2) / `--text-ui-xs`(−4)；
- **Tailwind 标准字阶整体上移**（侧栏/设置页等 `text-xs~xl` 的界面跟随放大）：`xs 16px` / `sm 18px` / `base 20px` / `lg 22px` / `xl 24px`（含配套 `--text-*--line-height`）；
- **聊天消息内容整体小一号（2026-09-27 用户定档 → 2026-09-29 推翻）**：~~`.md` 用 `--text-ui-sm`~~ **2026-09-29 用户调整：`.md` 升回 `--text-ui-base`（20px）+ line-height 1.7**，并全面加大段落/块级间距——p/blockquote/table/pre `margin 1em 0`、标题字号差压缩（h1 1.35em/h2 1.2em/h3 1.1em/h4 1.05em，字重 600 为主）+ 上 margin 加大、列表 0.8em/li 0.4em、行内代码改中性半透明底 `--code-inline-bg: rgba(127,127,127,0.12)`（dark/light 通用新语义 token）去边框、pre 圆角 6px、strong 降 600。消息区间距同步加大：`.message-list` padding 12px 0 + gap 20px、`.msg-assistant .msg-body` padding 14px 16px、**轮间距 `.turn-group` padding-top 22px→28px（虚拟化下 flex gap 只作用于虚拟块↔live tail，真实轮间距在组内 padding）**；`.turn-intermediate-text`/`.thinking-trigger` 仍用 `--text-ui-sm` 不变；用户气泡与输入框本就是 `text-sm`(18px)；界面其余部分维持原刻度不动；
- 既有组件内零散 px 字号（14px/15px 等）暂保留，后续按需迁移到 `text-ui-*` 刻度；新增样式**禁止直接写死字号**，统一走上述变量。

## 四点七、编辑重发 / 手动重试 / 回退本轮代码改动（对齐 LiveAgent，2026-09-26）

### 1. 编辑重发 = 硬截断（对齐 LiveAgent replaceConversationAtMessage 语义）
- **入口**：用户消息悬停动作栏（复制 / 编辑 Pencil / 回退 Undo2）；点击 Pencil 后整行被 `EditableUserMessageBubble` 替换（受控 textarea 行数自适应、聚焦 `preventScroll` + 恢复 `[data-scroll-viewport]` 的 scrollTop、附件卡可移除、**只有 Esc=取消**，Enter 是换行、必须点「发送」；提交 trim，空文本且无附件禁提交）。
- **单值编辑态**：`MessageList` 持有 `editingMessageKey`；被编辑行随截断消失时自动退出（useEffect 检测）。
- **提交链**（LiveAgent 同款「先退出编辑态，再异步重发」）：`onSubmit → onCancelEdit() → App.handleEditResend`——保留附件经 `buildOutgoingPayload`（`src/lib/chat/attachments.ts`，Composer 共用单一真源）折算：图片+视觉模型 → `fs_read_attachment_base64` 内联 image block；图片+非视觉 → 降级路径引用；文件 → `[Attached file]` 行。
- **controller.editResend(anchorMessageId, text)**：忙判定（streaming 拒绝）→ 锚点必须存在且 role==user → `messages.slice(0, anchorIndex)` + 原位替换新 user 条目（**新 id**，`nextMessageSeq` 单调递增）→ **同步** `beginAssistant`（与 send 同构，消除忙判定空窗；库 message_start 见末条 streaming 自动跳过重复建行）→ 清空 `retryAttempts/retrying` → `markTurnEntrance`（新气泡入场动画）→ `checkpoint_begin_turn` → 全新流水线。任何一步不受理原历史保持不变。
- **持久化**：截断后的时间线经池层 300ms 防抖 `conversation_sync` 全量落库（旧分支物理消失，无版本留存；对齐 LiveAgent，想保留用分支会话——未实现）。
- **贴底**：受理后 App `followSignal+1` → MessageList 强制恢复贴底跟随 + instant 置底（对齐 LiveAgent stickToBottom on run start）。
- **入场动画**：`entranceOnce.js` 诞生注册表（600ms 窗口）+ `chat-bubble-enter` CSS（0.3s cubic-bezier(0.16,1,0.3,1)，prefers-reduced-motion 退化）；初始构建/晚挂载行永不播放。

### 2. 手动重试 = 以原始提问重发该轮（对齐 LiveAgent RowActions retry）
- 助手消息悬停动作栏新增 `RotateCw` 确认弹层（Radix Popover）：「重试该回复？/ 将以原始提问重新发送，该回复及之后的对话内容将被删除。」确认后 `handleRetryFrom(messageId)`：向前扫描锚点 user → 文本沿用锚点原始载荷、图片直接复用其权威 `apiMessage` 的原生 image block（免重读文件）→ `poolEditResend`（同一截断管线）。**旧红色「重试」按钮已移除**（LiveAgent 无此形态）；错误行只保留原文+errorHint 双层展示。自动重试上限仍为 10 次（用户定档优先）。
- **自动重试对齐 LiveAgent withStreamRetry 三点**：① **已提交内容（text/thinking delta 或 toolcall 已开始）后的失败不再重试**（重发会重复，直接收敛 error 行，部分内容保留）；② **重试期间失败尝试的尾部 error 行不留在时间线**；③ **「重新连接中」副行从重试调度起持续显示并实时携带最新失败的错误原因**（`重新连接中… N/10 · <最新 errorMessage>`；`pushRetryAttempt` 置 `retrying=true` 并重建空流式行保持 live 轮），直到新尝试产出**首个内容事件**才撤下（onEvent 的 onRetryRecovered 语义；此前实现为「新尝试开始即撤下」，连接等待期副行闪现，2026-09-27 修复）。退避期间点停止会**立即收敛为已停止**（不再把下一次注定失败的请求发完才安静）。
- **重试详情块已从代码彻底删除（2026-09-27 定版）**：`RetryDetailsBlock` 组件文件、实时渲染、收敛后 `MessageItem` 的渲染与相关 i18n 键全部移除（用户明确要求完全删除而非隐藏；失败原因实时见重连副行）。重试记录（`state.retryAttempts` / 条目 `retryAttempts` part / 序列化）仍保留：实时副行的数据源 + 留档。停止（stop）不固化记录；重试耗尽的 error 收敛也不再有详情块 UI。
- **轮工时跨重试累加（2026-09-27 修复）**：重试重建的空流式行**继承被剪除行的 `startedAt`**（链式传递 = 本轮最初起点），工时不再每次重试从零计时。
- **错误行合并 + 行内重试按钮（2026-09-27）**：error 收敛行改为单行「`<错误原文> · <errorHint>`」（` · ` 分隔，允许折行），行右侧红色「重试」按钮（RotateCw）直接触发 `onRetryFrom`（截断重发该轮，无确认弹层）。⚠️ `handleRetryFrom` 读取图片时必须先判 `apiMessage.content` 是否为数组（pi-ai 的 UserMessage.content 纯文本时是**字符串**，直接 `.filter` 会 TypeError 导致按钮无反应）；`errorHint` 不落库，`deserializeRow` 水合时由 `diagnoseError(error)` 重算（否则刷新后友好提示丢失）。
- **助手动作栏常显 + 创建分支（2026-09-27，对齐 LiveAgent）**：助手消息动作栏**常显**（去 hover 门控），图标改为三枚——复制 / 重试（确认弹层）/ **创建分支**（GitBranch + 确认弹层），点赞点踩移除；行右侧时间戳 `YYYY-MM-DD HH:mm`（取 endedAt ?? startedAt，无打点不显示）。**分支语义（对齐 LiveAgent useBranchConversation/branch.rs）**：把此回复及之前的全部消息复制到一个新任务（标题「新分支」，沿用源任务的项目/模型/推理等级/审批模式），原任务保持不变，随后切换到新任务；实现走既有 IPC（`conversation_load` 取权威行 → 按锚点 msg_id 切前缀、seq 重排 → `conversation_sync` 写入新任务），无需新 Rust 命令。轮状态条文案「工作/已工作」→「处理中/已处理」（中英同步）。
- **流式加载指示器（2026-09-27，移植 ZCode ChatLoading）**：`ChatLoading.tsx` = lucide `LoaderIcon` + `animate-spin` + 弱化前景色（`--text-dim`），`size="sm"`（16px）用于流式助手正文末尾，替换旧「▋ msg-caret 竖条光标」（`.msg-caret`/blink 动画已从代码删除）；`loading=false` 不渲染。

### 3. 回退本轮代码改动（checkpoint/rewind，完整移植 LiveAgent checkpoint.rs）
- **数据记录层（Rust `src-tauri/src/checkpoint.rs`）**：`fs_write_file` 落盘**前**把被改文件的前像写入 `~/.ReinAgent/checkpoints/<taskId>/`（`index.jsonl` 追加日志 + `blobs/` 原始字节拷贝，schema v2）。ReinAgent 的 edit=读后整文件写回，故只挂钩 write 一处。捕获尽力而为：失败只追加 `kind="error"` 记录（该轮 UI 显示不完整），绝不阻断写入。turnId=用户消息 id；turn_seq 由 Rust 在 INDEX_LOCK 下单调分配（同 turnId 复用）。容量防线：单 blob 32MB/会话 512MB/10000 条（尾部 64 条留给 error）。
- **命令**：`checkpoint_begin_turn`（发送瞬间打轮边界，零文件轮也是合法回退点）/ `checkpoint_list` / `checkpoint_diff_stats`（预览：restore/delete/clean/skip-dir/missing-blob/unresolvable + 现状哈希）/ `checkpoint_rewind_code`（带 expected 哈希做 TOCTOU 冲突检测，缺指纹一律判冲突 fail-closed）/ `checkpoint_clear`（删任务时清理）。⚠️ Tauri 命令**不加** `rename_all = "snake_case"`（本项目 JS 侧统一驼峰键，加了会要求蛇形键导致 invoke 失败）。
- **回退语义**：「恢复到第 N 轮开始前」= 聚合撤销 turn_seq>=N 的所有路径（每路径取最早前像）；本轮新建文件（existed_before=false）→ 删除；完整回退（无冲突/失败/跳过/捕获缺口）才写 `kind="rewind"` 剪枝标记——读取侧丢弃 >= target 的陈旧未来记录，**多轮各自独立回退、回退第 N 轮连带撤销其后的轮且不影响 < N**。安全链：授权根白名单（fail-closed）+ 根/路径链逐级拒符号链接 + Unix 多硬链接拒绝 + 写前 reverify + 临时文件原子 rename（Windows 备份名回滚）。
- **UI**：`CheckpointRewindProvider`（`src/lib/chat/checkpointRewind.tsx`）+ 行内 Undo2 按钮（pending 时 Loader2 转圈；无检查点/发送中禁用，title「回退本轮代码改动/本轮没有可用的代码检查点」）。流程=preview → 确认框（标题「回退到本轮开始前」+ 时间副标题 + 逐项统计描述 + 等宽路径 detail 清单 + 红色确认键，组件 `src/components/ui/ConfirmDialog.tsx`）→ 回传全部预览哈希执行 → toast（成功「已回退代码：恢复 N 个、删除 N 个文件」，数字间 U+00A0 防折行）/ 部分完成对话框 → 重拉轮列表。**文件更改摘要卡的假「撤销」占位已移除**（LiveAgent 摘要卡无撤销）。终端命令的写入不在检查点内（与 LiveAgent 一致，需用户知悉）。

## 五、状态存储速查（2026-09-25 起迁移至 SQLite）

### 1. 本地磁盘持久化（Tauri Backend）

**`~/.ReinAgent/conversations.db`**（SQLite，WAL 模式，`conversation_store.rs`；前端经 IPC 访问）：

| 表 | 结构 | 用途 |
| :--- | :--- | :--- |
| `message` | `(task_id, msg_id)` PK + seq/role/status/started_at/ended_at/tool_name/tool_call_id/is_error/truncated_by/error/thinking_* | 时间线条目骨架（一行一个 TimelineEntry） |
| `part` | `(task_id, msg_id, part_index)` PK + kind/payload | 条目内容块（text/thinking/tool_args/tool_result/**api_message**），为全文检索铺路（对齐 LiveAgent message/part 拆分）。**api_message**（2026-09-25）：assistant/tool 条目的权威 API 消息原件（AssistantMessage/ToolResultMessage，含 usage 与精确 API 格式）——对齐 LiveAgent「落盘原件而非 UI 投影」：恢复后 token 统计/缓存命中率/上下文容量不再归零，`toApiMessages` 恢复完整历史（修复刷新后模型失忆）；改动前入库的旧轮次无此块，usage 如实缺失 |
| `task` | `id` PK + seq/payload/updated_at | 任务元数据（标题/时间/项目/置顶/模型绑定，JSON payload） |
| `kv` | `key` PK + value | UI 偏好（主题/语言/侧栏状态/active-task-id/user-projects/thinking-level/user-home） |

**IPC 命令**：`conversation_sync`（任务全量替换，事务）/ `conversation_load` / `conversation_delete` / `task_sync` / `task_list` / `kv_get_all` / `kv_set_many`；另有检查点五命令（`checkpoint_begin_turn/list/diff_stats/rewind_code/clear`，见 四点七.3，数据存 `~/.ReinAgent/checkpoints/<taskId>/`，不入库）。

**前端访问层 `src/lib/storage/db.ts`**：`main.tsx` 渲染前 `await initStorage()`（kv 全量 + 任务列表 + user-home 进内存缓存）→ 之后所有同步读走缓存；写入走写透（缓存 + 防抖批量 IPC）。

### 2. 会话池（`src/lib/chat/conversationPool.ts`）

- `Map<taskId, PoolEntry>`：每任务一个独立 conversationController + 外部 store（getSnapshot/subscribe，供 useSyncExternalStore）；
- **切任务 ≠ 停止**：切换只换 UI 订阅目标；后台任务流式照常跑、照常落库（「注销 ≠ 停止」）；
- 持久化时机：状态变化防抖 300ms 全量 sync（含流式中的条目，恢复时消毒收敛）；
- 治理：空闲条目 LRU 上限 12（豁免流式中）；删除任务 → `destroyTask`（abort + 清内存 + 删 SQLite）；
- 侧栏「进行中」标记：`subscribeStreaming`/`getStreamingTaskIds`（仅集合变化才通知，流式 delta 不触发侧栏重算）。

### 3. localStorage（已废除）

对话与任务数据的全部 localStorage 键（`reinagent-task-msg-*`、`reinagent-tasks` 等）已于 2026-09-25 移除，历史数据不迁移（从零开始）。例外：ZCode 预览面板移植件内部零散偏好已改走 kv；仅第三方库内部缓存不归本项目管辖。


## 六、Linux 编译、运行与环境隔离规范（严格基于 run-linux.sh）

由于宿主工程目录位于网络共享盘（CIFS/SMB 文件系统不支持 Linux 符号链接与标准文件锁机制），为了防止 `bun install` 软链接失败或 Cargo 编译锁死，**所有构建、类型检查与运行必须严格遵循 `run-linux.sh` 的环境隔离配置**：

### 1. 核心隔离参数
- **本地工作区**：`WORK_DIR="/tmp/reinagent"`
- **Rust Target 目录**：`TARGET_DIR="/tmp/reinagent/target"`（通过 `export CARGO_TARGET_DIR="$TARGET_DIR"` 挂载）
- **依赖隔离**：原生 Linux node_modules 安装在 `/tmp/reinagent/node_modules` 下。
- **根目录 `node_modules` 软链接机制**：
  - 工程根目录下的 `node_modules` 为指向 `/tmp/reinagent/node_modules` 的软链接（`ln -sfn /tmp/reinagent/node_modules node_modules`）；
  - **核心作用**：仅供宿主 VS Code / 编辑器（TSServer / Language Server）进行模块语法高亮、TypeScript 类型推导与代码自动补全；
  - **解耦影响**：若该软链接被删除或重命名（如 `node_modules.bak`），**不会影响任何编译与运行**（因 `run-linux.sh` 与构建脚本使用 `/tmp/reinagent/node_modules` 原生依赖），但会导致宿主编辑器出现找不到模块的红线警告并失去代码补全。如需恢复 IDE 提示，仅需重新建立指向 `/tmp/reinagent/node_modules` 的软链接即可。

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
   - **表单控件原生样式隔离（Form Controls Native Appearance Rule）**：在 Linux Webview（WebKit2GTK）环境下，原生 `<select>` 必须配置 `appearance-none` 并配合自定义 `ChevronDown` 箭头图标，全局绑定 `var(--bg-card)` 与 `var(--text-primary)`，杜绝因操作系统原生 GTK 白色控件覆盖导致的“白底白字不可读”问题。
4. **Git 与工作区保护 (Workspace Discipline)**：
   - 未经用户明确许可或要求，**严禁自行调用 `git commit` 或 `git push`**。
   - 测试产物、截图、中间日志等临时文件必须存放于 `/tmp/`，严禁污染工程工作树。

---

## 八、工作区与路径决议机制（对齐 ZCode 规范）

### 1. 业务工作区决议规则（Workspace Resolution）
- **活动任务优先（2026-09-27 修订，修复重启回退 DefaultProject）**：有活动任务时，工作区根目录严格跟随**任务自身持久化的 `project` 字段**（`App.tsx` 的 `workspaceProject = activeTask ? activeTask.project : selectedProject`，单一真相源，不依赖 UI 态同步时机）；**草稿态**（无活动任务）才使用 `selectedProject`（侧边栏/输入框所选项目）。
- **有指定项目**：若当前任务选中了项目（或会话绑定了 Project），则工作区根目录 `workspaceRoot` 为该项目所指定的文件夹路径。
- **无指定项目（默认回退）**：若任务未指定项目（或点击“不在项目中工作”），工作区根目录自动回退到用户主目录下的：
  👉 `~/.ReinAgent/DefaultProject`（如 Windows 下 `C:\Users\<user>\.ReinAgent\DefaultProject`）。
  - 若该目录不存在，首次文件写入或命令执行时由系统自动创建（`mkdir -p`）。
- **`selectedProject` 同步纪律（2026-09-27）**：① `hydratePersisted` 恢复持久化字段时必须从恢复的 activeTaskId 同步 `selectedProject`（历史缺陷：漏掉导致重启自动恢复的任务“在项目下显示、工具却落在 DefaultProject”）；② `setActiveTaskId` 切到已有任务严格跟随 `targetTask.project ?? null`（无项目如实为 null，绝不残留上一个任务的项目），切回草稿态保留当前所选。
- **用户主目录真实来源（No-Fallback，严禁编造路径）**：
  - 前端 `getDefaultWorkspaceRoot()`（`src/lib/agent/workspace.ts`）的三级来源为：① `localStorage["reinagent-user-home"]` 缓存；② Node/Bun 测试环境的 `HOME` / `USERPROFILE` 环境变量；③ **全部缺失时返回空串，绝不返回任何编造的默认路径**（历史遗留的 `/home/web3claw/...` 硬编码兜底已彻底移除）。
  - 应用启动时 `App.tsx` 调用 `initUserHome()`：经 Tauri IPC 命令 `path_home_dir`（`src-tauri/src/fs_cmd.rs`，优先读 `USERPROFILE`，其次 `HOME`，均缺失则真实报错）拉取宿主真实主目录，写入 `reinagent-user-home` 缓存；Web/无头环境下后端不可达时保留既有缓存并返回 null。
  - **工作区未知告警条**：当未选项目且主目录不可得时，顶栏下方展示 `--warn-*` 主题色告警条（i18n 键 `workspaceUnknown`），明确告知文件与命令工具受限，严禁静默假兜底。
  - 主目录未知时 `~` 展开与基于空根目录的相对路径解析（`resolveWorkspacePath` / `resolveWorkspaceRoot`）会**抛出真实错误**（“用户主目录未知”/“工作区根目录未知”），由工具层如实上报，绝不生成编造路径。
  - 行为已由 `src/lib/agent/workspace.test.mjs` 用例 6/7 锁定（纳入 `bun run test:agent`）。

### 2. 路径决议策略（Path Policy）
- **文件工具（`write_file` / `read_file` / `edit_file` / `list_dir`）**：
  - 前端工具层引入 `resolveWorkspacePath(inputPath, workspaceRoot)`，所有相对路径在发送给底层前，自动基于当前的 `workspaceRoot` 拼接为绝对路径；
  - 绝对路径保持原样，支持跨目录绝对路径读写；
  - 杜绝相对路径裸传导致文件落入 Tauri 默认进程 CWD（`src-tauri/`）的问题。
- **命令行工具（`exec_command`）**：
  - 若未指定 `cwd`，自动使用 `workspaceRoot` 作为默认执行目录；
  - 若指定了相对路径的 `cwd`，自动基于 `workspaceRoot` 解析。
- **Rust 后端双重防呆（`src-tauri/src/fs_cmd.rs`）**：
  - 后端接收到路径时，如遇相对路径，同样基于 `~/.ReinAgent/DefaultProject` 进行安全解析与自动建目录，提供系统层双重保险。

---

## 九、模型推理等级 (Reasoning Effort) 与聊天深度联动规范

### 1. 真实元数据与 API 规范（No Fallback 铁律）
- 服务端模型列表接口如果返回 `effort` 字段（如 `"effort": { "supported_levels": ["low", "high", "max"], "default_level": "high" }`）：
  - `parseProviderRawModels` 完整真实提取 `supportedLevels` 与 `defaultLevel`，写入 `ModelItem.effort`；
  - 若上游未提供，严格保留为 `undefined`，绝不凭模型名瞎猜或预设假数据；
- `mergeFetchedModels` 增量更新时，真实同步服务端的 `effort`、`contextWindow`、`maxOutputTokens` 与 `supportsImage`。

### 2. 模型编辑弹窗交互规范（Pill Button Group）
- 在 `ModelEditModal.tsx` 中配置推理等级：
  - **摒弃传统下拉框**，采用一排水平胶囊按钮组（`[ low ]` `[ high ]` `[ max ]`）；
  - 点击哪个档位，哪个档位立即呈主题色（`var(--accent)`）高亮，并设置为该模型的 `defaultLevel`；
  - 若模型来自 API 且未声明 `effort`，UI 明确标注“上游接口未声明支持推理等级 (未返回 effort)”，亦可由用户按需手动开启。

### 3. 聊天窗口 (`LexicalComposer`) 联动与双向同步
- **推理能力乐观兜底（对齐 LiveAgent，2026-09-24 修订）**：
  - **未声明 `effort` 元数据的模型乐观视为支持思考**：推理深度按钮恒可用（不再置灰禁用），下拉提供通用档位 `Default / Low / Medium / High`（不含 xhigh / max——这两档需要模型显式映射，未知模型不发）；`buildModel` 的 `reasoning` 同步兜底为 true → 请求带 `reasoning_effort`（服务端不支持时会自行忽略）；动机：实测 WorkBuddy 网关（192.168.3.27:8787）`hy4-preview` / `glm-5.3-flash` 默认输出 `reasoning_content`、`deepseek-v4.1-flash` 带 `reasoning_effort` 才思考，而其 `/v1/models` 不返回任何 effort 字段——严格门槛会让这类模型永远无法显示思考；
  - 声明了 `effort.supportedLevels` 的模型仍**严格按声明过滤**档位（不臆测加档）；
  - **已知网关怪癖**：`glm-5.3-flash` 带 `reasoning_effort` 参数反而不思考（默认参数才思考）——该网关对参数语义解析异常，遇到时切 off 或换模型；
  - 思考内容仍然**只渲染服务端真实流下来的** `reasoning_content`，绝不伪造；
- **禁用与高亮判定（历史行为，已被乐观兜底取代）**：~~未声明 effort 的模型按钮置灰禁用~~；声明了 effort 的模型，下拉菜单中点亮该模型支持的档位，不支持的档位呈禁用置灰态；
- **双向实时同步机制**：
  - **聊天窗口 ➔ 模型配置写盘**：用户在聊天窗口切换推理深度时，调用 `updateModelEffortDefaultLevel` 实时将当前模型在 `provider_config.json` 中的 `defaultLevel` 设为所选等级；下次打开编辑弹窗时该等级自动高亮；
  - **模型配置 ➔ 聊天窗口**：在编辑弹窗中保存了新默认等级时，若当前聊天窗口正在使用该模型，聊天窗口底部的推理深度立即联动更新为该等级；
  - **模型切换自动联动**：用户切换模型时，若新模型支持 `effort` 且有 `defaultLevel`，聊天窗口自动切为该默认等级；未声明 effort 的模型沿用当前全局等级（默认 high），**不再强制切 off**。

### 4. 大模型请求透传机制（底层 HTTP Payload 装配）
- 透传链路：`LexicalComposer / Store` ➔ `App.tsx` ➔ `useConversation` ➔ `conversationController` ➔ `runAgentTurn` ➔ `agentRuntime (Agent.initialState.thinkingLevel)` ➔ `pi-agent-core (agentLoop reasoning)` ➔ `pi-ai (streamFunction)`；
- 底层适配器自动将 `reasoning` 映射为对应协议的真实 HTTP POST 请求体：
  - OpenAI / DeepSeek 格式：自动添加 `"thinking": { "type": "enabled" }, "reasoning_effort": "high"`；
  - Anthropic 格式：自动添加 `"thinking": { "type": "enabled", "budget_tokens": ... }`；
  - Google 格式：自动添加 `"thinking_config": { ... }`。
- **⚠️ 必须使用 `streamSimple` 而非裸 `stream`（runAgentTurn 的 getStreamFnForApi）**：pi-ai 各协议适配器导出两个入口——`streamSimple` 负责把会话层 `reasoning`（思考等级）钳制变换为 `reasoningEffort` 并组装思考开关；裸 `stream` 只认已变换好的 `reasoningEffort`，直接传 `reasoning` 会被无视，且对 DeepSeek 等协议会落入「显式禁用思考」分支（发出 `thinking: {type: "disabled"}`），导致模型永远不输出思考过程。历史事故：2026-09-24 曾因误用裸 `stream` 导致所有模型思考不显示（已修复）。排查手段：劫持 `globalThis.fetch` 捕获实际请求体，检查 `thinking` / `reasoning_effort` 字段。

---

## 十、后续迭代方向推荐（2026-09-24 刷新）

1. **项目管理深化**：原生目录选择（`fs_pick_folder`）与工作区决议已落地；**目录文件树渲染**（结合 ZCode `WorkspaceSidebarItem` 树形逻辑）尚未实现。
2. ~~**对话持久化升级**~~：**已完成（2026-09-25）**——对话/任务已迁移至 `~/.ReinAgent/conversations.db` SQLite（见 五），localStorage 对话/任务键全部废除。
3. **Agent 工具执行沙箱**：前端审批流（ApprovalMode 四档 + beforeToolCall 挂起审批 + 计划模式拦截）已落地（见 十一 #14）；剩余：Rust 端命令执行拦截/沙箱、计划批准 elicitation（ExitPlanMode 批准后自动退出计划模式）、审批规则持久化、后台任务审批红点徽标。
4. **推理能力元数据整改（铁律整改项）**：`modelFactory` 仍写死 `contextWindow: 128000 / maxTokens: 8192`，应解析上游 `/v1/models` 的 `context_length` / `max_tokens` 真实字段（WorkBuddy 网关已实测返回这两个字段）。
5. 其余聊天窗口未实现项见 **十一、聊天窗口 ZCode 对标实现状态清单**。

---

## 十一、聊天窗口 ZCode 对标实现状态清单（截至 2026-09-24）

### 1. 已实现（全部通过 99 项单测 + 浏览器运行态实测）

| # | 功能 | 要点 | 关键文件 |
| :--- | :--- | :--- | :--- |
| 1 | 回合工作状态条 | 「工作中 X 秒」（运行中锁定展开+每秒计时）/「已工作 X 秒」（完成折叠）/「已停止」/「已处理」（历史无打点 No-Fallback）；时长格式化最多两段非零单位 | `TurnGroupView.tsx`、`turnActivity.ts` |
| 2 | 思考块三态折叠 | 流式默认展开+吸底跟随 → 整轮完成自动收一行；用户点击优先；Markdown 渲染 + 320px 限高 + 左导线 | `ThinkingBlock.tsx` |
| 3 | 工具卡类型化 header | 类型图标/标签（未知工具回退原名）+ 文件 chip + 命令内联摘要 + `+N/−N`（LCS 精确口径）+ 状态词；**文件 chip 对齐 ZCode renderFileChip**（2026-09-25）：Material Icon Theme 彩色 SVG（`public/material-icons/` 40 个常用扩展名，颜色固化在 SVG，onError 三级回退）+ 文件名可点击（编辑/写入 → 右侧 patch diff；读取 → 文件预览；onMouseDown 阻断行折叠）+ 目录段带尾斜杠更暗一级 + 条件 ±N（added>0 绿 / removed>0 红，零不显示）；顺带修复 edit_file 参数名错配（工具签名 target/replacement vs 代码读 old_string/new_string 导致 ±N 与 diff 恒空，补回退） | `ToolCallCard.tsx`、`fileDisplay.tsx`、`fileDisplayHelpers.ts`（ps1/bat/cmd 别名）、`turnActivity.ts` |
| 4 | 终端卡 | `$` 命令区（mono 限高折行）+ 输出区**吸底-冻结引擎**（上滚冻结/回底恢复）+「没有输出。」 | `ToolCallCard.tsx` |
| 5 | 编辑/写入 diff 视图 | 行级 LCS diff（零依赖，500 行上限）+ 行号跨增删连续计数 + 增行绿底/删行红底 + 240px 滚动 | `ToolCallCard.tsx`、`turnActivity.ts` |
| 6 | 查阅族独立卡（原「查阅」聚合卡已按用户决策移除，2026-09-27） | list_dir/read_file 直接渲染独立卡（对齐 ZCode ReadToolCallBlock）：图标 + 文件/目录 chip + 路径次要文本；**成功不显示状态词、失败显示「执行失败」+ tooltip**；list_dir = 目录读取形态（文件夹 chip，`.` 显示「当前目录」） | `ToolCallCard.tsx` |
| 7 | 对话问题导航条 | 用户提问粒度刻度 + Radix Tooltip 预览 + 平滑跳转 + 山峰衰减动效 + 自适应高度（240px/10~24px） | `ConversationNavigator.tsx` |
| 8 | 时间打点数据层 | assistant/tool 条目 `startedAt/endedAt`、`thinkingStartedAt/thinkingDurationMs`；注入时钟贯通状态机；不参与 toApiMessages | `conversationModel.js/.d.ts` |
| 9 | streamSimple 修复 | 修复误用裸 `stream` 导致思考被显式禁用的事故（详见 九.4） | `runAgentTurn.ts` |
| 10 | 推理能力乐观兜底 | 无 effort 元数据模型视为支持思考（档位 Default/Low/Medium/High，可 off）；已声明模型仍严格按元数据过滤 | `App.tsx`、`LexicalComposer.tsx`、`modelFactory.ts` |
| 11 | 右侧代码/变更预览面板（PreviewPane 完整移植） | 编辑/写入卡审查 → patch 模式（Shiki 高亮 diff）；读取卡 → 文件行号预览（Rust `fs_read_text_file` 256KB 截断+二进制探测）；`@pierre/diffs` + `shiki` 已引入；Media/PDF/PPTX/Office 为诚实降级 stub | `src/preview/**`（约 40 文件）、`fs_cmd.rs`、`CodeViewerPaneHost.tsx` |
| 12 | 文件更改摘要卡 | 轮内 edit/write 客户端现算摘要「N 个文件已更改 +A −B」；每文件行 审查（patch 面板）/ 打开（文件预览）；**仅在整轮结束后显示**（编辑过程中看各工具卡，对齐 ZCode 时机）；同文件多次编辑按路径聚合为净变更，净零文件过滤；**`.ReinAgent/temp/` 下的一次性脚本不进摘要**（`isReinAgentTempPath`：不列行、不计入数量与增删统计，全部为 temp 时整卡隐藏；用户确认不做自动清理，手动清理按钮保留）；撤销按钮 gating 未开（需 Rust 写入轨迹日志，阶段 2）；header 附**「清理临时目录」**按钮（行内二次确认 → `fs_clean_reinagent_tmp`） | `TurnGroupView.tsx`（TurnFileSummaryCard） |
| 13.4 | 会话统计行（SessionStatsBar，对齐 LiveAgent 底部统计条） | 底栏下一行等宽小字：`N 轮 · M 步 | 上下文 P% | LLM/工具 耗时 | 输入/输出 tok · 命中 %`；耗时来自时间打点累计（流式段按当前时刻实算）；命中率 = 累计 cacheRead /（累计 input + cacheRead）（全会话口径，修复只取末条的 0%/100% 跳变）；居中、13px、亮色 | `SessionStatsBar.tsx`、`App.tsx` |
| 13.5 | 上下文容量面板 | 触发器=输入框工具栏 SVG 圆环（进度弧）；HoverCard 面板：标题（上下文容量 + 紧凑数字摘要）+ 多段进度条（品牌色按排名淡化）+ 分类行（消息/系统工具/系统提示词，字符估算口径与 ZCode 一致：中文×2÷3 取整）+ 缓存命中率（移至会话统计行，≥0 才显示）；已用取真实 usage（input+cacheRead+output），上限取模型 contextWindow 声明值；无数据不渲染（No-Fallback）；**不含剩余额度**（用户确认排除）；**明细行可点击**——有内容的类别（消息/系统提示词/系统工具）懒构建真实文本在右侧面板查看（markdown/json 高亮），无内容类别（技能/MCP/其他）如实 0.0% 且不可点击 | `contextUsage.ts`、`ContextUsageIndicator.tsx`、`LexicalComposer.tsx`、`App.tsx` |
| 14 | **任务级设置隔离 + 审批模式落地（对齐 ZCode task-local thoughtLevel/mode）** | 三项设置按任务隔离：模型（`providerId/modelId`，已有）、推理等级（`thinkingLevel?`）、审批模式（`approvalMode?`），字段随 task payload 进 SQLite；有活动任务读写任务字段，草稿态读写全局默认（首次发送随 createTask 落到新任务）；模型切换自动对齐改为任务粒度（只修正覆盖不受支持的任务，绝不冲掉仍受支持的覆盖）。审批模式四档（对齐 ZCode 用户可切面）：`plan 计划模式`（写/执行一律拦截+系统提示词约束只读调研）/`ask 变更前确认`（写+执行弹审批卡）/`edit 自动编辑`（写自动放行，执行弹卡）/`full 完全访问`（默认，零开销直通）；工具分级 `resolveToolPermissionKind`（read 直通/write/exec 受限，未知工具保守视为 write）。审批流经 pi-agent-core 原生 `beforeToolCall` 钩子：需要批准时 await 用户决策（**循环挂起不中止**，同 ZCode 权限流语义），拒绝 → `{block:true, reason}` 错误工具结果（模型知道被拒不重试）；审批卡（`ApprovalCard`）渲染于输入框上方（工具名+参数摘要+允许/总是允许/拒绝），「总是允许」为任务级内存免审集合；stop/clear/轮次异常结束均以 reject 解除挂起；模式下拉对齐 ZCode（图标+标题+描述，full 态触发按钮 warning 色）。实测：隔离（A 改 B 不动+全局不动）、拒绝（模型停手文件未创建）、允许（批准后文件真实落盘）全链路通过 | `useAppStore.ts`、`tools.js`（resolveToolPermissionKind）、`agentRuntime.js`（beforeToolCall 透传）、`runAgentTurn.ts`（createApprovalGate/PLAN_MODE_PROMPT）、`conversationPool.ts`（审批协调器）、`conversationController.js`（requestApproval/resolveApproval）、`conversationModel.js`（pendingApproval）、`ApprovalCard.tsx`、`LexicalComposer.tsx`、`App.tsx`、`approvalGate.test.mjs` |
| 15 | **应用品牌换装（logo + 应用图标 + 底栏图标条）** | 应用图标全套更换：R 主题（蓝色渐变圆角方块 + 白色粗体 R，`src-tauri/app-icon.png` 1024 源图经 `cargo tauri icon` 生成 icon.ico/icns/各尺寸 PNG/Store logos），窗口/任务栏/开始菜单生效（需 Rust 重构建后启动）；左上角 logo 改为同源内联 SVG（`AppLogo` 组件，替换原文字方块）；左下角用户栏移除（头像 K/用户名 kwtgsgi8 删除），替换为 **PI-Desktop sidebar-footer 同款图标条**（lucide 14px 图标 + 32×32 命中区 + radix Tooltip 300ms，对齐 TooltipButton/footer-action）：齿轮=设置（可点，i18n settings）/ **插头 Plug=扩展**（navPlugins，占位）/ 时钟=定时任务（navScheduled，占位）/ 电脑（原 Monitor，占位）——占位无功能、默认全部不高亮；右侧版本号 `v{getVersion()}` 对齐 footer-build（**12px tabular-nums leading-none、UI 字体非 mono**；浏览器模式取不到则隐藏） | `WorkspaceSidebar.tsx`（AppLogo + 底栏）、`src-tauri/icons/*`、`src-tauri/app-icon.png` |
| 13 | 临时/资料目录约定（B+C 组合，对齐 pi 的 `.pi/` 模式） | 系统提示词约定：一次性脚本/分析产物必须放 `<工作区>/.ReinAgent/temp/`（视为可丢弃）；记忆等持久资料也统一放 `<工作区>/.ReinAgent/` 下各自子目录（禁止散落项目根）；Rust `fs_clean_reinagent_tmp` 白名单清理 `.ReinAgent/temp`（两级路径严格校验 + 幂等 + 递归删除 + 条目计数）；摘要卡 header 一键清理（行内二次确认、3 秒回退、成功/失败如实反馈）。参照：PI-Desktop host-core 的 `.pi/` 工作区目录模式（plans/artifact.rs，路径安全校验同思路） | `runAgentTurn.ts`、`fs_cmd.rs`、`TurnGroupView.tsx` |

### 2. 未实现（Gap 清单，按主题分组）

**修复记录（2026-09-24）**：
- 工具瘦身：移除 `get_current_time` 与 `calculate` 两个演示工具（代码/注册表/测试/文档同步清理），工具集仅保留 read_file / write_file / edit_file / list_dir / exec_command；
- 持久化迁移 SQLite（两表结构对齐 LiveAgent）+ 会话池多任务并行流式（2026-09-25）：切任务不再 abort，后台任务照常跑；localStorage 对话/任务键废除；
- **修复：useSyncExternalStore 嵌套更新循环**——pi 库 processEvents 同步循环逐事件 notify，useSyncExternalStore 对每次快照变化强制重渲染，50 次即抛「Maximum update depth exceeded」（表现为轮次「请求失败」）。修复：池的 notify 按微任务合并（一轮事件爆发只渲染一次，状态已同步更新、订阅者拿到最新快照）；
- **修复：草稿首条消息发送竞态**——handleSend 的 createTask/setActiveTaskId 后，hook 闭包里的 taskId 仍是 null → poolSend 被静默拒绝。修复：草稿提升路径用新 taskId 直接调池；
- **修复：任务元数据落库缺 seq**——syncTasks 统一按索引派生 seq（= 创建顺序）；
- 恢复消毒：`restoreState` 将残留的 streaming/running 条目标记为 stopped 并补 `endedAt`——消除重启后「执行中」僵尸条目导致的统计爆炸（如 LLM 9h17m）与状态条永久工作中；
- 命中率口径修正：pi-ai 的 `input` 不含缓存命中部分，命中率 = 累计 `cacheRead / (input + cacheRead)`；容量 used = input + cacheRead + output。
- **修复：exec 终端命令大面积失败（2026-09-26）**——根因是 Rust `Command::arg()` 按 MSVC 规则把命令内引号转义成 `\"`，而 cmd 不认该转义，`findstr /c:"..."` 与多词带引号模式被拆坏（`FINDSTR: Cannot open <词>`）。修复：`fs_execute` 改用 `raw_arg` 原样透传命令行；同时主命令加 `CREATE_NO_WINDOW`（不再弹黑框抢焦点）、输出收集加 5s 有界收尾（防孙进程持管道永久挂起）、输出 256KB 截断（防巨型输出拖垮 IPC）。另：模型把 exec 参数名写成 `cmd` 导致的校验秒败已由 schema 别名修复（见提交 059903f）。
- **错误详情展示 + 自动重试（2026-09-26，对齐 LiveAgent）**——controller 捕获错误时用 `describeErrorChain` 展开 Error 的 **cause 链**（OpenAI SDK 的 APIConnectionError message 只有 "Connection error."，真实原因在 cause 上），错误行以**原文为主**（状态码/上游原因/URL 一并展示）+ `errorHint`（diagnoseError 友好提示）小字；`finish` 同步存储 error(原文)/errorHint 两字段；diagnoseError 新增 5xx 分支（502/503/504/forward）；**自动重试两层（对齐 LiveAgent withStreamRetry）**：provider 层 `maxRetries: 2`（pi-ai retryProviderRequest，连接级瞬时重试）+ **controller 层统一重试裁决 5 次**（对齐 codex stream_max_retries=5；关键覆盖点：pi-ai 把 HTTP 错误作为 stopReason:'error' 的 errorMessage 返回而非 throw，只 catch throw 会完全漏掉 502 这类失败——throw 与 errorMessage 两路归一进同一裁决，失败判定 = `result.errorMessage` 非空（pi-ai 的 HTTP 错误以 stopReason:'error' 正常收敛、agent_end 照常到达，`reachedAgentEnd === false` 的判定会完全漏掉它们——已修正为检查 errorMessage））；退避 200ms x 2^(n-1) x uniform(0.9,1.1)；`isRetryableError` 覆盖网络/超时/429/500/502/503/504/524/Cloudflare 52x；401/402 等确定性失败不重试；每次重试重建历史（R13 剔除失败行）并 beginAssistant 另起新行；手动重试按钮保留。自动重试上限 **10 次**（2026-09-26 用户定档，替代初版 5 次）；每次重试追加 RetryAttemptRecord（attempt/maxAttempts/errorMessage/plannedDelayMs）到 state.retryAttempts；UI 两处（对齐 ZCode/LiveAgent）：① 状态条下方**重连副行**「重新连接中… N/10」（`reconnect-line`，仅流式中的轮显示，对齐 ZCode 重连样式）；② **「重试详情 (N)」折叠块**（RetryDetailsBlock，对齐 LiveAgent RetryDetailsBlock：RefreshCw 图标 + 折叠头 + 每次尝试卡片「第 N/M 次重试 + 错误原文」）——实时轮从 state.retryAttempts 传入，完成后固化到 assistant 条目（retryAttempts part）随消息持久化；关键修复：beginAssistant 保留轮次级 state 字段（原实现构造全新对象把 retryAttempts 抹掉，导致记录只剩 1 条）。
- **修复：markdown 列表/标题渲染丢失（2026-09-26）**——Tailwind preflight 把 `ul/ol` 的 list-style 与 `h1-h4` 的字号/字重重置，`.md` 只补了边距，导致模型输出里的列表渲染成无符号缩进段落、`## 标题` 渲染成与正文同大的普通文本（用户感知为「总结没有列表、很紧凑」）。已显式恢复：h1-h4 分级字号（1.5/1.3/1.15/1.05em）+ 700-600 字重，ul disc / ol decimal + `li::marker` 暗色，li 项间距 0.25em。
- **新增：附件与图片粘贴（2026-09-26，对齐 LiveAgent）**——Rust 命令 `fs_pick_files`（rfd 多选）/ `fs_import_pasted_file`（粘贴图片 base64 落盘 `.ReinAgent/temp/pasted/`）/ `fs_read_image_preview`（≤5MB 缩略图 base64）/ `fs_read_attachment_base64`（≤25MB 发送内联）；前端 Composer 真实附件状态（上限 9、扩展名图片白名单）、textarea onPaste 粘贴图片、缩略图点击 Lightbox 放大（Radix Dialog）、X 删除；发送时文本附件以路径引用追加、**图片转 pi-ai 原生 image content block 内联**（非视觉模型降级为路径引用提示）；后续轮次重建历史时图片不再保留（v1 限制）。
- **修复：用户气泡图片点击放大失效（2026-09-26）**——MessageItem 的返回结构是「用户分支提前 return + 助手分支 return」，Lightbox 最初只挂在 assistant 分支的树尾，用户气泡分支的树里没有该节点（点击后 setState 生效、组件重渲染，但 JSX 树中无 Lightbox → 无 DOM 变化）。已在用户分支 return 的根 div 内补挂 ImageLightbox（Composer 附件条与消息气泡共用组件）。
- **任务级隔离 + 审批模式（2026-09-25）**：见已实现清单 #14；`ApprovalMode` 值域由无实效的 always/suggest/auto 替换为 plan/ask/edit/full；全局默认持久化 kv（`reinagent-approval-mode`，缺省 full）。
- **修复：Linux 编译回归（2026-09-27）**——commit 177ad5a 的 `fs_cmd.rs` `spawn_shell` 用 `if cfg!(target_os = "windows")`（运行时布尔宏，不做条件编译）包裹 Windows 专属代码（`std::os::windows::CommandExt` 的 `raw_arg` / `creation_flags`），两个分支在 Linux 上仍参与类型检查，导致 E0433/E0599、桌面端在 Linux 无法编译启动。已改为 `#[cfg]` / `#[cfg(not)]` 属性条件编译（Windows 分支保留 raw_arg + CREATE_NO_WINDOW 语义，Unix 分支 `sh -c`），`CREATE_NO_WINDOW` 常量同步加 cfg 门；Windows 行为不变，Linux 恢复可编译。
- **修复：工具结果一刀切 8KB 截断导致大文件读不全（2026-09-27，对齐 ZCode 按工具分设上限）**——原 `TOOL_LIMITS.maxResultBytes = 8192` 对**所有工具**统一截断，85KB 的 PROJECT_CONTEXT.md 一次只能读前 8KB，模型被迫用 exec `sed -n` 按 8KB 一段磨十几步（exec 结果同样被 8KB 闸拦住）。已改为**按工具分设**：`read_file` = 2000 行 / 256KB（对齐 ZCode `READ_DEFAULT_MAX_LINES` / `READ_MAX_FILE_SIZE_BYTES`，行数闸 `applyReadLineCap` 先行 + 字节闸二次兜底，details 带 `totalLines/linesTruncated`）、`exec_command` = 30KB（对齐 ZCode bash `MAX_INLINE_OUTPUT_BYTES`）、`list_dir` = 8KB 维持；`buildTextToolResult` 增加每工具 `maxBytes` 参数；read_file/exec 描述文本同步告知模型上限；Rust 侧 `fs_execute` 的 256KB 收集上限保持不变。
- **改动：快捷动作卡改为「预填不发送」（2026-09-27，用户定档）**——EmptyState 四个快捷按钮（周报总结/报错修复/需求开发/闲时任务）点击后**只把提示词填进输入框**（聚焦 + 光标到末尾，可编辑后手动发送），不再自动发送。实现：`LexicalComposer` 新增 `prefillRequest?: { text, nonce } | null` prop（nonce 变化触发 setText + 聚焦，沿用 `focusRequestTrigger` 模式），App 持有 `composerPrefill` 状态 + 单调 nonce（hooks 声明在设置页早退 return 之前）。**固定填充文案**（`EmptyState.prompts[].fill`，与按钮标签分离）：周报总结→「每周五总结这一周发生的事情。」；报错修复→「请分析以下终端报错日志，找出导致该错误的根本原因，并提供可以直接运行的修复代码示例。」；**pptMake 按钮标签改为「需求开发」**（i18n zh/en 同步），填充→「先完整阅读所有文档和代码，掌握整个开发流程和进度，严格遵守开发规则，等待新需求」；闲时任务暂保留预填、待自动化页面移植后改为页面导航。欢迎页快捷按钮与输入框间距 `mt-8`→`mt-16`（聊天框下移）。

**渲染增强类**：
- [x] diff 视图 / 代码块的 **Shiki 语法高亮** —— 已随 PreviewPane 移植引入（`shiki@^4` + `@pierre/diffs`，工具卡内联 diff 视图仍为单色形态）
- [ ] **PPTX / PDF / Office / 媒体预览引擎**（PreviewPane 模式壳已移植，渲染引擎未引入，激活时如实显示「不可用」）
- [ ] 流式「正在思考」**扫光动画（shimmer）**（LiveAgent/ZCode 用 CSS 渐变动画表达运行态，替代旋转图标）
- [x] 临时文件目录约定 + 白名单清理（B+C 组合，2026-09-24 落地）
- [ ] **`<think>...</think>` 内嵌标签解析兜底**（Ollama 式网关把思考内联在 content 里；LiveAgent 有 `inlineThinkTagStream` 归一化；WorkBuddy 实测走原生 `reasoning_content`，暂无需求）

**工具卡类**：
- [ ] 查阅卡**搜索类 bucket**（当前无搜索工具；加入后自动扩展 N 搜索 徽标）
- [ ] **多文件编辑子卡**（ZCode 多文件 edit 每文件独立展开块；ReinAgent edit 为单文件模型）
- [x] 文件 chip **点击打开代码查看器** —— 已实现（编辑/写入/读取卡 header 点击 → 右侧 PreviewPane；~~撤销真回滚待 Rust 写入日志~~ **已由 checkpoint/rewind 实现**（见 四点七.3，行内 Undo2 按钮，2026-09-26））
- [ ] 工具卡展开态**跨重挂载记忆**（ZCode 用模块级 `toolLayoutOpenState: Map<toolId, boolean>`）

**回合/时间线类**：
- [ ] **多段回合独立折叠**（ZCode 每个 assistant 段独立 Collapsible；ReinAgent 一轮一个头）
- [ ] **权威工时**（ZCode TurnHeaderRow `activeMs` 排除权限/输入/校验等待；ReinAgent 全按墙钟）
- [ ] 运行中段尾 **ChatLoading 转圈 + API 重试计数**
- [ ] 长会话**虚拟滚动**（ZCode 用 @tanstack/react-virtual）与历史**分页 hydration**

**元数据与持久化类**：
- [ ] `context_length` / `max_tokens` 真实元数据解析（替代 `modelFactory` 写死 128000/8192，见 十.4 铁律整改项）
- [ ] 对话持久化升级 Sqlite / `~/.ReinAgent/` JSON（见 十.2）
- [ ] 查阅卡目录文件树渲染（见 十.1）

**基础设施类**：
- [ ] worktree 多 agent 并行 + Vite 端口参数化（用户已决策暂用分支方案，见记忆）


## 十二、已知问题：Linux 窗口大小/位置记忆失效（2026-09-27 诊断完毕；**过渡方案已落地**）

**过渡方案（2026-09-27 用户定档，方案 A/B 仍待后续决策）**：Linux 平台**停用** `tauri-plugin-window-state`（`lib.rs` `with_window_state` cfg 门：非 Linux 才注册插件），每次启动按 `tauri.conf.json` 窗口默认值 **1800×1200 + `center: true`** 启动（工作区 2560×1440 内放得下，不触发合成器强制改尺寸）；Windows 端窗口记忆不受影响。`~/.config/com.reinagent.app/.window-state.json` 旧状态文件在 Linux 上已无效。

### 1. 症状与环境
- 症状：Linux 下每次启动都不按上次的窗口大小和位置打开。
- 环境：GNOME 50.1 / Wayland 会话（`GDK_BACKEND=wayland`）/ 显示器 2560×1440@100% 缩放（工作区约 2493×1400：顶栏+停靠栏占位）/ `tauri-plugin-window-state 2.4.1` + tauri 2.11.5 + tao 0.35.3。
- 状态文件：`~/.config/com.reinagent.app/.window-state.json`（label `main`，内容 2105×1371@(0,0)，mtime 2026-09-24 07:16 后从未更新）。

### 2. 三层根因（全部实测证实）
1. **保存侧：非优雅退出 = 永不写盘**。插件仅在 `RunEvent::Exit` 时写文件（lib.rs:503），窗口事件只更新内存缓存。开发流程的 Ctrl/C/SIGTERM/SIGKILL/重启全部丢失——实测 pkill 后文件 mtime 不变。这是「9-24 之后调整的窗口全部没记住」的原因。
2. **恢复侧（尺寸）：Wayland 下恢复请求被合成器强制覆盖（主凶）**。`WAYLAND_DEBUG=1` 协议级证据：应用启动后确实请求了恢复尺寸 `xdg_surface.set_window_geometry(26, 23, 2105, 1418)`（GTK CSD 客户端装饰使窗口比保存值膨胀约 +47px，1371→1418），**高度 1418 超出工作区 1400**，Mutter 立即回发 `xdg_toplevel.configure(2493, 1400)`（= 工作区大小）强制放大，窗口从此钉在 2493×1400——即用户看到的「每次都是错误尺寸」。对照实验：`GDK_BACKEND=x11`（XWayland，SSD 系统装饰，无 CSD 膨胀）下**尺寸恢复正常**（xdotool 实测 client 2105×1363）。
3. **恢复侧（位置）**：Wayland 协议层面禁止应用自定位（`gdk_window_move` 是 no-op），保存的 x/y 永远被忽略；X11 下插件的 `set_position` 发生在窗口映射前，仍被 Mutter 初始摆放覆盖（存 0,0 实测开在 305,139）——**映射后（post-map）再定位才有效**。
- 附：插件恢复逻辑（lib.rs:194-206）有 `available_monitors?` + `set_position(...)?` 的 `?` 级联——任一 Err 会使 set_size 也被跳过（`let _ =` 吞掉错误）；`intersects` 门槛对本例不构成问题。

### 3. 修复方案（已定，待实施）
**方案 A（推荐，大小+位置都能恢复）**：
1. `src-tauri/src/lib.rs` 在 Tauri 启动前（Linux 平台）`std::env::set_var("GDK_BACKEND", "x11")` 走 XWayland——SSD 无 CSD 膨胀、位置可设置。当前 100% 缩放下无模糊风险；**若将来启用分数缩放需重新评估 XWayland 渲染质量**。
2. 保存加固：`on_window_event` 监听 `Resized`/`Moved`，防抖 ~600ms 调用插件现成的 `window.save_window_state(StateFlags::all())`（`WindowExt`，lib.rs:115）——不再依赖优雅退出。
3. 恢复后移：窗口 show 后（setup 内延迟任务或首个 Resized 事件）再 `set_position` + `set_size`（钳制到工作区内）；X11 下 post-map 的 move 走 ConfigureRequest，Mutter 会真实执行。Windows 端维持插件现状（cfg 门隔离，零影响）。

**方案 B（纯 Wayland 折中）**：只做上述 2+3（不切 X11）——尺寸可恢复（钳制后不再触发合成器覆盖），位置永远记不住（Wayland 硬限制）。

### 4. 复验手段（实施后验收用）
- Wayland 现状复现：`WAYLAND_DEBUG=1 /tmp/reinagent/target/debug/reinagent` 抓 `set_window_geometry` / `configure` 序列；
- X11 恢复验证：`GDK_BACKEND=x11` 启动后 `xdotool search --name ReinAgent getwindowgeometry`（本机有 xdotool/xwininfo；GNOME 50 的 Shell Screenshot/Introspect DBus 已确认 AccessDenied 不可用）。


## 十三、自动化定时任务（一期，2026-09-27 落地；对齐 ZCode AutomationsSection）

### 1. 架构
- **Rust `src-tauri/src/automation.rs`**：
  - 存储：`~/.ReinAgent/conversations.db` 新增 `automations` / `automation_runs` 两表（独立连接，WAL 多连接并存）；scheduleRule 结构化规则为调度权威（JSON 列），cronExpr 仅展示；
  - IPC 8 命令：`automation_list / create / update / delete / set_enabled / run_now / list_runs / run_finished`（serde camelCase DTO 与前端 types.ts 一一对应）；
  - 调度线程（`start_scheduler`，setup 钩子启动）：每 **20s** 轮询（对齐 ZCode POLL_INTERVAL_MS）`enabled=1 且 next_run_at<=now` 的任务 → claim（写 running run 行 + `run_count+1` + 推进 `next_run_at`）→ `app.emit("automation-due", payload)` 派发前端；启动时残留 running 一律收敛 `stopped`（应用重启中断）；next 计算失败退避 1h 并记 last_error。
- **前端**：
  - `src/lib/automations/types.ts`（DTO 类型 + `inferPreset` / `applyPreset` / `describeRule` 摘要）与 `store.ts`（zustand：列表缓存 + CRUD + loadSeq 过期响应守卫）；
  - `AutomationsPage.tsx`（列表页：页头/刷新/创建按钮、状态筛选 pills 全部·进行中·已暂停·失败、卡片网格 `grid-cols-1 lg:grid-cols-2`、卡片=标题+提示词两行+频率徽标+运行计数+下次运行+启停开关+立即运行+行内二次确认删除、空态引导）；
  - `AutomationEditView.tsx`（创建/编辑：名称、**频率构建器**（预设 pills 每小时·每天·工作日·每周·每月·自定义 + 规则编辑器：间隔/时间/星期 chips/月日 chips）、提示词、模型双下拉（服务商+启用模型）、工作区只读、保存/取消）；
  - **App 派发器**（`dispatchAutomationRun` + ref + `automation-due` 事件监听一次注册）：到点 → `createTask(title, workspacePath, 模型, approvalMode="full")` → `poolSend(prompt, maxSteps=0)` → 5s 轮询 `getEntrySnapshot` 收敛（done/error/stopped）→ `automation_run_finished` 回报 outcome；
  - 入口（2026-09-27 修正补全）：**侧栏 Quick Actions 的「自动化」按钮**（Timer 图标，原为无 onClick 的占位——用户点击无反应的根因）+ 侧栏底栏**时钟图标** + 欢迎页**闲时任务按钮**（`onOpenAutomations` 导航，替代预填）；`ViewMode` 扩展 `"automations"`；**页面为主视图形态**（渲染在主内容区、保留侧边栏与顶栏，统计行/终端面板仅 workbench 视图显示，页面根由 `h-screen` 改 `h-full` 填充主区）；**从自动化页激活任务自动切回工作台**（`setActiveTaskId` 内：currentView 为 automations 时任何任务激活/新建任务都切回 workbench——点击侧栏任务即进入对话；自动化自身派发走 `createTask` 内部赋值不经此 action，页面停留不被打断）。
- **调度规则语义**（ScheduleRule）：`unit: minute|hourly|daily|weekly|monthly`（年/yearly 一期不做）、`interval≥1`、`hour/minute`、`weekdays`（0=周日…6=周六，工作日预设=1-5）、`monthDays`（1-31，月末越界自动跳过）；预设映射：每小时=hourly/1，每天=daily/1，工作日=weekly[1-5]，每周=weekly 单选星期，每月=monthly 单选日期；计算=从 now 起按锚点对齐向后扫描（epoch 分钟/小时/天/周/月对齐），有界防死循环。
- **样式**：颜色/字号全部走项目语义变量（`--brand/--surface/--text-dim/--border` 等 + `text-ui-*` 刻度），交互对齐 ZCode（卡片 hover 显现动作、切换开关、pills 单选）。

### 2. 已知边界（一期范围外，二期候选）
- 运行历史 tab（`automation_runs` 已落库、`list_runs` 命令已备，UI 未做）与运行记录跳转会话；
- ZCode 的 OffPeak 闲时任务 tab、任务模板库、cron 自定义对话框、workspace 选择器（一期工作区取创建时的 `selectedProject`）；
- 调度要求**应用处于运行状态**（桌面常驻应用语义，与 ZCode 桌面端一致；应用关闭期间到点的任务错过不补跑）。


## 十四、LiveAgent 资源中心移植：搜索 / MCP / 记忆 / Skills（一期，2026-09-27）

照抄 LiveAgent（源码 `crates/agent-ui` + `crates/agent-gui/src-tauri`）的四个功能，存储路径全部 `~/.ReinAgent/`。

### 0. 侧栏重排（照抄 LiveAgent ChatHistorySidebar + sidebarShortcuts）
- 新建任务行右侧 = **放大镜**（原 Ctrl+N 字样删除；点击打开搜索弹窗）；
- 自动化下新增 **Skills（Blend 图标）/ MCP（Cable）/ 记忆（Brain）** 三个入口（setCurrentView 新增 `skills/mcp/memory` 三视图，页面为主视图形态保留侧栏顶栏）；
- **插件市场占位删除**（pluginMarket 键移除）。

### 1. 搜索（ConversationSearchDialog 移植）
- **UI**：居中 Radix Dialog（防抖 180ms、分组结果、空态最近会话 12 个、↑↓/Enter/Esc 键盘导航、`[...]` 片段标记保留、点击结果跳转对应任务并聚焦）。
- **Rust `src-tauri/src/history_search.rs`**：`chat_history_search` 命令——标题命中（task.payload 提取）加权优先 + 消息全文命中（part 表 text/thinking LIKE，UTF-8 边界安全片段窗口 40 字符），每任务最多 5 条片段、最多 20 组；空查询返回最近任务。FTS5 二期。
- **接线**：`WorkspaceSidebar onOpenSearch` prop → App 的 `searchOpen` 状态 + `ConversationSearchDialog`（`onOpenTask` = setActiveTaskId + 聚焦）。

### 2. MCP（LiveAgent commands/integration/mcp.rs 同构实现，2026-09-27 升级）
- **Rust `src-tauri/src/mcp.rs`**（进程级 `OnceLock<McpRuntimeManager>` 单例连接池，map 锁不跨 client 锁）：
  - **配置** `~/.ReinAgent/mcp_servers.json`：`McpServerConfig` 与 LA 同构（camelCase serde）：`id/description?/docsUrl?/enabled/transport(stdio|http|sse)/command/args/env?/cwd?/url?/headers?/timeoutMs(缺省 60000)/messageUrl?`；旧 JSON（含废弃 `name`、缺新字段）serde default 兼容读取不迁移。auth/OAuth 本期不做。
  - **三传输**：stdio（spawn 子进程 + 行协议；**Windows .cmd/.bat 经 `cmd.exe /E:ON /V:OFF /D /S /C` + raw_arg 整行转发**（LA issue #205），PATHEXT 解析裸程序名；stderr 环形 tail 200 行；进程树 kill = Windows `taskkill /PID x /T /F` / Unix 进程组 `-TERM`→`-KILL`）；streamable-http（POST + `Accept: application/json, text/event-stream`，保存 `MCP-Protocol-Version`/`mcp-session-id` 响应头，响应 JSON/SSE 双解析，404+有会话=SessionExpired404）；legacy http+sse（后台线程 GET 长连，重连退避 1s→30s 指数、成功复位，endpoint 事件解析 POST 地址，messageUrl 覆盖/相对 join/`/sse→/message` 猜测）。
  - **协议层** `McpClient`：initialize 协议版本依次尝试 `["2025-11-25","2025-06-18","2025-03-26","2024-11-05","2024-10-07"]`，成功后发 `notifications/initialized`；会话过期 reset+re-init+retry 一次；超时全部按 `timeoutMs`；连接同 id 同配置复用、配置变更重建、重建失败逐出 stale。
  - **8 命令**（JS 侧 camelCase 参数键）：`mcp_save_servers(servers)` / `mcp_list_servers()` / `mcp_list_tools(servers)`（全量已启用列表入参，返回 `Vec<McpToolInfo{serverId,serverLabel,name,description,inputSchema}>`，部分失败跳过、全部失败才 Err）/ `mcp_call_tool(serverId, toolName, arguments)` → `{content:[{type,text|image}], isError, details}` / `mcp_test_server(server, includeSchema?, persist?)` / `mcp_restart_server(server, includeSchema?, persist?)`（均返回 `McpRuntimeTestResponse{ok, phase: config|spawn|initialize|tools_list, transport, durationMs, running, initialized, toolsCount, tools, error, stderrTail}`）/ `mcp_runtime_status(serverId)` / `mcp_stop_server(serverId)`。
- **Agent 集成（`src/lib/mcp/mcpTools.ts`，已适配新契约 2026-09-27）**：`createMcpTools()` 枚举工具走单次 `mcp_list_tools({ servers })`（传全量已启用列表；失败如实跳过），工具名 `mcp__<serverId>__<tool>`，执行透传 `mcp_call_tool({ serverId, toolName, arguments })`（isError/content[] text 拼接；错误 throw → 库侧 isError toolResult）；`runAgentTurn` 将 MCP 工具附加到工具数组，权限分级保守视为 write（未知工具名 → ask/edit 需审批，plan 拦截）。
- **页面（`src/components/mcp/`，LA pages/mcp-hub 全量 10 文件移植）**：三 tab（已配置/MCP Store/本地导入）+ HubHeader 大标题；已配置卡片（启停/编辑/删除/传输徽标/args·env·headers 计数；OAuth 与 ToolPolicy 列一期裁剪留 TODO(phase2)）；MCP Store 三源 registry（official/smithery/glama，经 hubFetch）+ 预览抽屉 + 配置弹窗；本地导入（四外部源扫描 + 任意 JSON/TOML 文件，勾选批量导入）；`hubSettingsAdapter.ts` 提供 `updateMcp(prev,patch)` 保持 LA 调用点逐字。

### 3. 记忆（LA services/memory 全量移植，2026-09-27 升级）
- **Rust `src-tauri/src/memory/`**（LA `services/memory/` 8600 行逐字移植 + `commands.rs` 薄包装，单例 `OnceLock<Arc<MemoryStore>>`）：
  - **存储** `~/.ReinAgent/memory/`：`memory-index.sqlite3`（WAL；FTS5 unicode61 + trigram 双虚表、审计表 op/actor CHECK、`memory_organize_runs` 表、schema version 4，integrity_check 失败自动隔离重建）+ `global/{user/, daily/YYYY-MM-DD.md（.archive/<年>/ 90 天归档）, .trash/, .organize-snapshots/}` + `projects/<sha256 前 16 hex>/{.workdir.json, .trash/}` + `.quarantine/`（wipe 隔离）。
  - **frontmatter**：`name/type/scope/description/headline/date?/createdAt/updatedAt/source{trigger,conversationId?,model?,risk_flag?,unreviewed}/links`；daily 另有 `appendCount`+`sources[]`；证据块（confidence/source_quote≥5字否则自动降级/reasoning/aliases/conflicts_with/supersedes/override_reject+auto_downgraded）由 Rust 渲染与契约校验。
  - **语义**：`unreviewed` 仅 extractor/整理器写入为 true（用户手写免审）、memory_accept 通过审核；quota 每作用域 500 条（80/95/100% 三级）；删除进 `.trash`、wipe 进 `.quarantine`；daily 只能 append（32KB 上限，普通 8KB），凌晨 4 点滚动日界。
  - **23 命令**（`memory::commands::*` 注册为 `memory::*`）：list/read/search/write/update/delete/delete_project/accept/apply_batch/organize_run_{create,update,list,read,clear_history}/organize_due_{claim,complete}/index_overview/paths_info/recent_rejections/today_local_date/today_daily/quota_summary/wipe_all。
  - 测试 38 例（LA 39 例移植，仅 `#[cfg(unix)]` 符号链接用例 Windows 平台过滤）；已知一期边界：`memory_search` 的 `historyMatches` 恒空（与 history_search 表结构不合，二期接）。
- **Agent 集成（对齐 LA 注入格式）**：`runAgentTurn` 经 `src/lib/memory/prompts/injection.ts` 注入 `# Memory Index` 分桶索引（User/Unreviewed/Project/Global/Daily 五桶、`[slug|u*:h|d0]` 置信度/新鲜度标记、每桶 30 条上限、16K 字符截断）+ `## Memory` 工具规则段；并挂载 `MemoryManager` 工具（`src/lib/memory/memoryManagerTool.ts`，action 判别 list/read/search/write/update/delete/accept + 证据字段结构化透传；权限分级走未知工具保守 write）。
- **页面 `MemoryPanel.tsx`**：~~记忆卡片（类型徽标 + 标题 + 三行摘要 + 更新日期）+ 新建/编辑弹窗（标题/类型/正文）+ 行内二次确认删除~~ 已于 2026-09-27 被 LiveAgent Memory Hub 完整移植版整体替换（见下）。

### 3.1 记忆 Hub 前端整体移植（LA pages/settings/memory/ 全量 6 文件 + ResourceManagementPage 外壳 → `src/components/memory/`，2026-09-27）
- **页面结构与导出形态**：`MemoryPanel({ workdir?, modelOptions? })`（App 侧接线：workdir=当前工作区根即 project 作用域数据源；modelOptions=整理/总结模型选择器选项 `{value,label,group?}`（`providerId::modelId`），缺省空数组时 ModelPicker 如实显示空并出「未配置模型」警告横幅）。外壳 = `HubHeader(title=settings.navMemory, prominent)`（对齐 LA ResourceManagementPage 只传 title，描述行由面板内承担）+ `MemoryPanelInner`（LA MemoryPanel 1:1 移植体）；settings/setSettings 来自 `useHubSettings`；页面最外层与全部自建 Portal 弹层（新建 Dialog / 设置抽屉 / AlertDialog / SelectContent）追加 `hub-scope`。
- **面板功能**：三 tab（全局/项目/日志，segmented Tabs 带计数）+ 关键词过滤（matchesFilter）+ 项目作用域按 workdir 分组 `<details>` 折叠列表 + 右侧详情编辑（daily 为追加模式 appendBody，其余 replace）+ 新建 Dialog（slug/类型/作用域/描述/正文）+ 待审核横幅（unreviewed 计数）/云同步目录横幅（memory_paths_info）/配额警告横幅（healthy/warning/danger/full 阶梯）+ 审核（memory_accept）/删除（ConfirmDeletePopover，文案 props 注入）/清空全部（memory_wipe_all + AlertDialog 二次确认）。
- **设置抽屉 `MemorySettingsDrawer`**：配额阶梯横幅（`memory_quota_summary` + lib/memory/organizer/quota deriveQuotaLadder，{scope}/{used}/{limit} 占位替换）；驱动模型双 ModelPicker（整理模型清空即自动关整理开关；总结模型清空=跟随对话模型）；整理开关/频率（不执行|每天|每周）/时间（400ms 防抖 + 卸载 flush）/星期/范围/模式 + 「下次自动整理」状态行（`organizerSchedule.ts` 的 computeNextMemoryOrganizerRunAt 纯函数，LA themeAndMemory.ts 移植）；存储路径展示（memory_paths_info.root，fallback `~/.ReinAgent/memory`）；危险区清空。配置经 `updateMemorySettings`（settings.memory 切片 spread）持久化 kv `reinagent-memory-settings`。
- **Organizer 一期边界（用户定档）**：设置项照常读写持久化；「立即整理」点击仅 `toast.error(settings.memoryOrganizerPhase2)`（zh「记忆整理器将在后续版本提供，敬请期待」），**不移植** pokeMemoryOrganizer/canRunOrganizerLocally/memoryOrganizeRunCreate，绝不伪造整理运行；历史弹窗 `OrganizerHistoryModal` 正常读 `memory_organize_run_list`（一期恒空态如实展示），状态过滤/清历史/统计卡/手动建议勾选应用（memory_apply_batch + runRecord v4 协议）/跳过分布/裁剪协议折叠逻辑全量保留（无运行记录时自然不可达）。
- **适配要点**：每个文件顶部标注 LA 源路径；图标 lucide-react 同名；`web:max-820:*` → `max-[820px]:*`；LA tokens 类改等值 arbitrary（`gap-12px`→`gap-3`、`pb-settings-memory-panel-pb`→`pb-[max(14px,env(safe-area-inset-bottom))]`、`max-h-settings-memory-entry-list-max-h`→`max-h-[min(42svh,320px)]`、`grid-cols-memory-navigation`→`grid-cols-[280px_minmax(0,1fr)]`、`grid-cols-skill-filter`→`grid-cols-[auto_minmax(9rem,auto)]`、`min-h-auto`→`min-h-[auto]`）；i18n 走 `createMemoryTranslate` 适配层（hub/zh.ts 已收录的 174 个 settings.memory* 键直读 + `i18n/hub/extra-memory.ts` 补 8 个缺失键：settings.close/cancel/delete、chat.searchModel/noModelFound/collapseProvider/expandProvider、settings.memoryOrganizerPhase2）；lw 内部弹层（ConfirmDeletePopover 气泡、ModelPicker 下拉）已由集成方在 lw 组件内部补注 hub-scope（confirm-action-popover/tooltip/ModelPicker 的 Portal 内容类名），弹层同样吃 LiveAgent 色板。

### 4. Skills（LA services/skills 全量移植，2026-09-27 升级）
- **Rust `src-tauri/src/skills/`**（LA `services/skills/` 全文件移植：mod/types/util/paths/metadata/library/sources/install/jobs/clawhub/create/validate/builtin/external/external_mcp + `commands.rs`）：
  - **存储** `~/.ReinAgent/skills/`（写锁 `SKILLS_WRITE_LOCK` 互斥；安装=stage-then-swap 原子换目录，conflict=backup|fail|overwrite；安装源支持 GitHub URL/HTTP zip/本地路径；后台安装任务 jobs（phase queued→downloading→…→done|error|cancelled，完成项保留 60 分钟））。
  - **内置技能**（`builtin.rs` + `src-tauri/prompt/skills/` 三目录 include_str! 编译期内嵌，文案宿主名已改 ReinAgent）：`skills-installer`、`skills-creator`（前端 ALWAYS_ENABLED 恒启用）、`liveagent-code-review`；所有权标记 `_reinagent_builtin.json`，启动时 setup 钩子播种（冲突备份、无效替换、内置防删防覆盖）。
  - **外部扫描**：`~/.claude/skills`、`~/.codex/skills`、`~/.codebuddy/skills-marketplace/skills`、`~/.agents/skills`（与 LA 完全一致）；`external_mcp.rs` 同文件移植（四 MCP 配置源 + 任意 JSON/TOML 文件解析）。
  - **6 命令**：`system_manage_skill(payload)`（action 分发 list/read/install/install_start/install_status/install_cancel/delete/scan_external/scan_external_mcp/scan_mcp_file/clawhub_install/create/validate/package）/ `system_read_skill_text` / `system_read_skill_metadata` / `system_ensure_builtin_skills` / `mcp_scan_external` / `mcp_scan_config_file`。测试 57 例（44 skills + 13 external_mcp）。
  - HTTP 下载用 ureq 3（进度回调写 job 字节计数；LA 的 reqwest/system_proxy 未引入，代理走进程环境变量）。
- **Agent 集成（对齐 LA 注入格式）**：`runAgentTurn` 读 `hubSettingsStore.settings.skills`（enabled+selected），经 `lib/skills/index.ts` 的 `buildSkillsSystemPrompt({rootDir, selected: SkillSummary[]})` 注入 `skill://` 路径协议 + 渐进披露清单（元数据技能只列 name/description/skillFile/baseDir；README 回退技能带 inlineContent 全文）。
- **页面 `SkillsHubPage.tsx`**：~~技能卡片（名称/描述/id chip/启停开关/编辑/删除）+ 新建/编辑弹窗（id 目录名/名称/描述/正文 Markdown）~~ 已于 2026-09-27 被 LiveAgent Skills Hub 完整移植版整体替换（见下）。

### 4.1 Skills Hub 前端整体移植（LA pages/skills-hub/ 全量 17 文件 → `src/components/skills/`，2026-09-27）
- **页面结构**：三页签（已安装 installed / 商店 store / 本地导入 import）+ 顶部常驻搜索框 + 排序 Select + 资源级启用 Switch（写入 `hubSettingsStore.settings.skills`）。`SkillsHubPage()` 无 props（内部取 `useHubSettings`），渲染 `SkillsHubPageInner` 1:1 移植体（`isAgentMode` 恒 true，chat-mode 锁定分支保留但不可达）。
- **已安装页**：memo 化 `InstalledSkillCard`（latest-ref 回调 + `[content-visibility:auto]`），ClawHub 分类 chips 本地启发式分类（`classifyInstalledSkill`）、名称/描述 fuzzy 搜索高亮、`useDeferredValue` 防卡顿、单卡启停（ResourceActivationSwitch）/删除（ConfirmDeletePopover）/预览抽屉（`InstalledSkillPreviewDrawer`，`system_read_skill_text` 读 10000 行 + frontmatter 元数据剥离 + Markdown 预览走 chat MarkdownText）。
- **商店页**：ClawHub 目录（`lib/skills/clawHub.ts` 经 hubFetch→Rust 通道）+ `skillStoreCache` LRU 目录/详情缓存（目录 2min/详情 10min 新鲜期）、`install_start/install_status/install_cancel` 任务轮询（600ms）、分阶段进度条、分类过疏自动补页。
- **导入页**：`scan_external` 扫描 Claude Code/Codex/CodeBuddy/Agent Skills 四源（`SkillsImportSourceTabs`），勾选批量导入（`manage_skill action=install source=<baseDir> conflict=backup`），已安装技能锁定不可再导入。
- **批量模式**：工具条（数量/全选当前筛选/批量启用/禁用带 Undo toast/批量删除带预览确认）；Ctrl+A 全选当前筛选（输入框聚焦时让位浏览器默认）、Esc 退出、Shift+点击区间选择（installed/import 两页均支持）。
- **存储**：skills 切片持久化 kv `reinagent-skills-settings`（`{enabled, selected[]}`，always-enabled 内置技能恒在列，对齐 LA `mergeAlwaysEnabledSkillNames`）。
- **适配要点**：i18n 走 `./useLocale` 适配层（`useTranslation` + `i18n/hub/extra-skills.ts` 补 4 个缺失键：settings.cancel / settings.delete / settings.cronViewClose / settings.switchToAgentMode）；`removeWorkspaceResourceReferences` 桩化为恒等（TODO(phase2)，无工作区资源概念）；lw Sheet 为 Radix 实现，`useDrawerPresence` 改为钩子内自管理（entered 首帧置位 + 关闭 220ms 后释放快照，替代 Base UI `onOpenChangeComplete`）；Portal 弹层（SheetPopup/SelectContent）追加 `hub-scope`（lw 内部的 ConfirmActionPopover/Tooltip 弹层由集成方在组件内补注，色板一致）。

### 5. 验证与边界（2026-09-27 全量落地后实测）
- 前端：`bunx tsc --noEmit` 0 错误；`bun run build` 通过；测试基线 test:chat 108 / test:agent 39 / test:providers 8 / test:settings 6 / test:markdown 12 / **test:hub 57（新增：ClawHub 分类/归一化/owner 收敛、installedSort、mcpRegistry 白名单与安装草稿、memory schema/quota/runRecord v4）**。
- Rust：`cargo check` 0 error；`cargo test --lib` **123 通过**（memory 38 + skills 57 + mcp 19 + 既有 9）。
- 样式审计：移植类 token 经 Tailwind 真实编译引擎比对 0 真实缺失；构建产物含全部移植关键类（settings-tile 系/shadow-ui-*/animate-hub-loading-progress/hub-scope 双主题变量/dark 变体 `:where([data-theme=dark]...)`）。
- **二期候选（用户定档一期范围）**：记忆 Organizer 执行引擎（五阶段 LLM 管线 + due_claim 调度接线，Rust 表与命令已备）、记忆 Extraction 聊天后自动抽取（钩子点=conversationController 轮次持久化后）、MCP OAuth 全链（LA services/mcp_oauth，依赖 keyring/getrandom）、MCP 卡片 ToolPolicyToggle（需 `system.toolPolicies` 设置切片）、`memory_search` historyMatches 接 history_search、ClawHub 安装的 agent 侧 SkillsManager 工具、技能 `/name` 显式提及注入。

### 6. Hub 移植公共基建（2026-09-27，Skills/MCP/记忆三页共用）
- **主题桥（`global.css`）**：`.hub-scope` 作用域内把共享色板覆盖为 LA 原版中性色（亮/暗两套 `--lw-*` 变量，值逐项对齐 LA tokens.css；`background/foreground/border/card/popover` 六色走 `var(--lw-x, 宿主色)` fallback 链，作用域外维持既有色板零影响）；新增 settings-tile 系/segmented/control-surface/muted/primary/destructive/success/ring 语义色与 `text-tiny`、`shadow-ui-hubchrome-24/25`、`shadow-ui-skillshubpage-51`、`shadow-ui-mcpregistrybrowser-45/46`、`shadow-ui-memorysettingsdrawer-50`、`animate-hub-loading-progress` 及字面量 `@utility`（max-w-1320px/grid-cols-form-label/min-h-360px/pb-safe-bottom-10rem 等）；`@custom-variant dark` 跟随 `data-theme`。
- **lw 组件库（`src/components/lw/`，46 文件）**：LA `components/ui`+`hub`+`resources`+`settings` 的 Radix 适配移植（Base UI→Radix：`data-[active]→data-[state=active]`、render→asChild、Switch/Checkbox/NumberInput 自写、Select 基于 Popover listbox、AlertDialog 由 Dialog 组合）；`toast.ts/toaster.tsx` 同 API 移植（success/error/warning + action Undo + appearance:"notice" + toast.dismiss）；cn 经 `extendTailwindMerge` 对齐 LA 合并语义。**lw 内部 Portal 组件（ConfirmActionPopover/Tooltip/ModelPicker 下拉）已内嵌 hub-scope**。
- **i18n**：`src/i18n/hub/{zh,en}.ts` 501 对键（机械提取自 LA translations）+ 三个 extra 补充文件（skills 4/mcp 5/memory 8 键）经 `src/i18n/index.ts` spread 合并；页面侧 `useLocale.ts`（skills）/`useHubTranslation`（mcp）/`createMemoryTranslate`（memory）三个轻适配层统一放宽键型（运行时同一字典）。
- **设置层（`src/store/hubSettingsStore.ts`）**：`useHubSettings`（settings: {skills, mcp, memory} + setSettings(updater)）；skills/memory 切片写透 kv（`reinagent-skills-settings`/`reinagent-memory-settings`），mcp 切片整表写回 Rust `mcp_servers.json`（`hydrateMcp()` 启动装载，App 已接）。
- **出网通道（`src-tauri/src/hub_http.rs` + `src/lib/hub/hubFetch.ts`）**：ClawHub/MCP Registry 统一走 `hub_fetch_json` 命令（ureq rustls 直连绕开 WebView CORS；**`http_status_as_error(false)`：非 2xx 不在 Rust 层抛错，status+body 原样透传**），前端 hubFetch 返回真实 `Response`，LA 调用方零改动（registry 的 fetchJson 自行格式化「HTTP 401: <响应体>」）。**已知外部事实（2026-09-27）**：Glama 的 `/api/mcp/v1/servers` 已开始强制 API Key（401 响应体指引 glama.ai/settings/api-keys 创建；LA 同样受影响）——Glama tab 如实显示该错误，Official/Smithery 正常；为 Glama 加 Key 配置属二期。
- **App 接线**：`<Toaster dismissLabel/>` 挂 hub-scope 包裹层；MemoryPanel 传 `workdir={effectiveWorkspaceRoot}` + `hubModelOptions`（启用服务商×启用模型）；三页 `<XxxPage />` 无 props 导出形态保持 App 调用面不变。
- **⚠️ 教训**：清理 i18n 键时严禁只 grep 双引号 `t("key")`——侧栏等组件用单引号 `t('key')`，漏判会误删在用键（2026-09-27 已回滚一次，index.ts 以 HEAD+合并重建）。

### 7. 2026-09-28 增量（同日第二批：注入结构 ZCode 同款）
- **meta_user 注入结构**：runAgentTurn 新增 `buildMetaUserBlock`/`prependMetaUserBlock`——currentDate（ZCode 同款文案）+ 记忆索引 + 技能清单包 `<system-reminder>` 并入首条 user 消息头部；系统提示词保持静态（Environment 段留 system，Current date 行移出；faux 回显剥注入块）。面板「其他」行改名「用户上下文」（key=metaUser，i18n contextUsageOther），内容=currentDate+记忆段（与注入同源、可点击）；「系统提示词」行估算补 Environment 段（ZCode env_info 归 system_prompt 口径）。测试 providers 套件 8→11（新增 6/6b/6c 三用例）。

### 7. 2026-09-28 三项增量
- **Glama API Key 配置入口**（用户拍板的超出 LA 对齐范围增量）：`src/lib/hub/registryKeys.ts`（kv `reinagent-mcp-registry-keys`）+ `McpRegistryToolbar` 钥匙按钮 + `GlamaApiKeyDialog`（lw Dialog，password 输入/保存/清除）；`lib/mcpRegistry searchGlama` 有 Key 时注入 `Authorization: Bearer <key>`。背景：Glama /api/mcp/v1 自 2026-09 强制 Key（LA 同样 401）。
- **上下文容量进度条口径修复（对齐 ZCode Progress 双口径）**：轨道上指示条宽度=真实 used/window 百分比（min-w-[2px]），构成分段以 flexBasis 画在指示条内部（原误把构成比铺满整条轨道，出现「0.2% 满条」）。ZCode 依据：packages/ui/src/components/ui/progress.tsx（indicator width=value%、segment flexBasis%）+ contextUsage.tsx buildContextUsageBreakdownSegments（segment percent=chars/totalChars）。
- **上下文面板技能/MCP 工具分类接真实内容**：App 订阅 hubSettings 技能切片→discoverSkills+buildSkillsSystemPrompt 得注入文本；MCP 列启用服务器（签名+60s TTL 模块缓存）→mcp_list_tools 得工具 schema JSON；两分类有内容时非 0 且可点击（右侧面板查看 markdown/json），不可得如实 0（与发送链路同源，对齐 ZCode skills/mcp_tool_schemas breakdown 口径）。



### 8. MCP 诊断与枚举失败反馈（2026-09-28，用户反馈「启用了没带上」驱动）
- **根因实例**：用户启用的 `node_repl` 服务器指向 Codex 版本哈希目录（`runtimes\cua_node\<hash>\bin\node_repl.exe`），Codex 更新后路径失效 → spawn 失败 → `mcp_list_tools` 全失败 Err → `createMcpTools` 返回空 → 本轮未带 MCP 工具；此前失败只进 console，界面零反馈。
- **卡片诊断按钮**（已配置 tab，启用中的服务器显示 PlugZap 图标）：调 `mcp_test_server(server, persist=true)`，成功显示「连接成功 · N 个工具 · 耗时」，失败行内显示错误原文 + phase（title 全文）。i18n：`mcpHub.cardTestOk/cardTestFailed`（extra-mcp）。
- **发送链路反馈**：`createMcpTools` 全失败时经 `useHubSettings.setMcpEnumNotice` 通知（lib→store→UI，不持久化），App 订阅后 `toast.error`（8s；seen 时间戳去重）。后端部分失败跳过、全失败才 Err——单服务器部分失败仍不可见（后端 list_tools 丢弃 per-server 错误，二期补结构化返回）。
- **⚠️ 浮层层级必修课（2026-09-28 用户报「删除点不了」根因）**：Radix popper wrapper 是 `position:fixed; z-index:auto`，而 Hub 页容器带 `relative z-10`（LA 页面结构原样）——z:auto 的浮层被 z:10 页面容器整体压住，表现为**弹层看得见但所有点击落在页面上**（Playwright actionability 报 covered-by，elementFromPoint 实证）。修复：lw `popover.tsx` 的 PopoverContent 与 `dropdown-menu.tsx` 的 popupClassName 补 `layer-popover`（z 10000，LA 原版浮层都有；tooltip/sheet/dialog/alert-dialog/select 移植时已带）。浏览器实测：删除确认弹层点击恢复可用。

### 8.1 批次 A（TASKS.md 首批）落地：A1 attention + A2 模型元数据真实解析（2026-09-28）
- **A2 模型元数据真实解析（铁律整改完成，PROJECT_CONTEXT 十.4 项关闭）**：`modelFactory.buildModel` 不再写死 `contextWindow: 128000 / maxTokens: 8192 / input: ["text","image"]`；`ProviderConfig` 新增 `contextWindow?/maxOutputTokens?/supportsImage?`，由 `App.buildTurnOptions`（与自动化派发）从模型目录透传。未知语义：`contextWindow` 传 **0**（pi-ai `clampMaxTokensToContext` 对 `<=0` 跳过钳制；容量面板同样以 `<=0` 不渲染）、`maxTokens` 传 **0**（openai 兼容适配器 `if (options?.maxTokens)` 即不发送该字段）、**anthropic-messages 例外**——其 `max_tokens` 为协议必填且 pi-ai 会 `Math.max(1,…)` 兜成 1 token，故未声明时用请求级常量 `ANTHROPIC_REQUIRED_MAX_TOKENS = 32000`（文档注明非元数据、UI 不展示）、`input` 只在 `supportsImage === true` 时含 `image`。测试 `modelFactory.test.mjs` 7 例（含「严禁回退写死值」回归断言），providers 套件 11→18。
- **A1 回合状态条 attention 强制展开 + 隐藏窗口停表**：`turnActivity.ts` 新增 `isAttentionRequired(group, pendingApproval)`（判据：会话级 `pendingApproval` 非空，或轮内 `ask_user`/`exit_plan_mode` 类工具处于 running——等人类工具运行中即表示在等人；未知工具名不臆测）与 `effectiveWorkMs(startedAt, nowMs, hiddenSpans)`（隐藏时段按与轮区间求交集扣除，乱序/倒置/越界容忍、结果非负）。UI：`TurnGroupView` 加 `pendingApproval`/`hiddenSpans` props——attention 时状态条文案「等待你的决定」（i18n `turnAwaitingDecision`）、`lockOpen` 强制展开且按钮 disabled 不渲染箭头、DOM 标 `data-attention="true"`；`MessageList` 以 `visibilitychange` 维护隐藏时段 ref 并下传实时轮；`App` 透传 `state.pendingApproval`。测试 `turnActivity.test.mjs` 15→29（attention 四态 + 停表交集/边界 6 例）。

### 8.2 批次 B（工具扩军）落地（2026-09-28）
- **工具集 5 → 9**：新增 `glob`（模式匹配文件路径）、`grep`（正则搜内容）、`delete_file`（删除文件）、`todo_write`（任务清单）。权限分级：glob/grep/todo_write = **read**，delete_file = **write**（ask/edit 需批准、plan 拦截）。
- **Rust `src-tauri/src/fs_search.rs`（新）**：`fs_glob(root, pattern, limit?)` / `fs_grep(root, pattern, include?, ignore_case?, limit?)`。glob 语义 `*` 不跨目录、`**` 跨目录、`?` 单字符；**字符类 `[ ]` 与花括号显式拒绝**（`[unclosed` 曾会静默当普通文本匹配，测试抓出后改为如实报错——No-Fallback）。安全：根 canonicalize + 遍历逐条 `strip_prefix` 复核（符号链接逃逸拒绝）；跳过 `.git/node_modules/target/dist` 等；grep 跳二进制与 >2MB 文件并**如实回报 `skipped_files`**；两者都有 limit 截断标记。10 个 Rust 单测。
- **`fs_delete_file(path, checkpoint?)`（fs_cmd.rs）**：拒绝符号链接与目录（只删普通文件）；删除前把前像写入检查点 ⇒ 用户「回退本轮代码改动」可恢复被删文件。前端 `delete_file` 工具强制 **read-before-delete**（未读先删报错）。
- **前端**：`tools.js` 四工具注册（描述含「用 grep 而非 exec 拼 findstr」的引导）；`ToolCallCard` 新增 **Todo 卡**（表头当前项 + N/M，展开三态图标：绿勾+删除线 / 箭头 / 空心圆）与 **搜索卡**（glob/grep：模式 + 命中数 + 结果行）；`turnActivity` 补四工具的类型标签与代号。
- **任务进度条 `TaskProgressBar.tsx`（新，挂输入框上方）**：读末条 `todo_write` 条目（覆盖语义 ⇒ 末条即当前清单），SVG 圆环 + 「任务进行中 N/M · 当前项」/「任务已全部完成」+ hover Tooltip 展开清单；无清单不渲染（No-Fallback）。纯逻辑抽到 `src/lib/chat/todoProgress.ts`（`extractLatestTodos` / `todoProgress`），4 个单测挂进 test:chat。
- 验证：`tsc` 0、`build` ✓、test:chat 114→**118**、test:agent 39→**43**、cargo 123→**133**。
- **Tauri 端实测（2026-09-28，按用户要求今后只用桌面端验证）**：经 WebView2 CDP（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`）驱动运行中的应用实测——模型真实调用 `todo_write`（回显「三步计划已建立，当前进度 0/3」）与 `glob`（`**/*.md` 无匹配，模型主动 `list_dir` 复核确认非工具故障）；页面渲染 **进度条**（`role="progressbar"`、aria 0/3、文案「任务进行中 0/3 · 当前项」）与 **Todo 卡 / 匹配卡** 类型标签均正确。
- **⚠️ Tauri 实测抓出的致命 bug（单测/tsc/构建全测不出）**：`TaskProgressBar` 初版直接用裸 `@radix-ui/react-tooltip` primitive 而**未包 `TooltipProvider`** → React 整树抛 `Tooltip must be used within TooltipProvider` → **应用白屏**。修复：改用项目既有 `../lw/ui/tooltip`（组件内置 Provider，其文件头本就写着这条教训）。**教训沉淀：新组件一律复用 lw/ui 组件，不得直接引 radix primitive；功能验收必须启动 Tauri 实测，禁止用浏览器代替**（浏览器模式还读不到 Tauri 侧 provider 配置，测不出真实工具调用）。

### 8.3 批次 C（输入侧能力）落地（2026-09-28）
- **C1 斜杠命令（真实现，替换原硬编码假菜单）**：
  - Rust `src-tauri/src/commands.rs`：`commands_scan(workspace_root?)` 扫描 `<工作区>/.ReinAgent/commands/*.md`（frontmatter `name`/`description` + 正文模板；name 缺省取文件名；目录不存在返回空数组**非错误**；仅收 .md；单文件读取失败跳过并 stderr 记录）。5 单测。
  - 前端纯逻辑 `src/lib/commands/slashCommands.ts`：`parseSlashQuery`（行首 `/` 且无空格才进命令态）、`filterCommands`（前缀优先）、`expandCommandTemplate`（`$ARGUMENTS` 替换；无占位符时参数追加末行**不静默丢弃**）、`toCustomCommands`（脏数据防御：空白名/无名字丢弃）。5 单测。
  - Composer 接线：`/` 触发真菜单（内置三命令 + 自定义命令带「内置/自定义」标签）；内置 `/clear` → App `handleClearConversation`（`useConfirmDialog` 二次确认 → `conversationPool.clearConversation`（新导出：controller.clear + schedulePersist））；`/compact` → `toast.error(compactPhase2)` 诚实占位（批次 D 接引擎）；`/help` 把命令列表贴回输入框。自定义命令选中即模板展开**填入输入框**（可编辑不直接发送）。
- **C2 @提及（真实现，替换原 @workspace/@terminal 假菜单）**：
  - 纯逻辑 `src/lib/chat/mentions.ts`：`parseMentionQuery`（@ 前须行首/空白且其后无空白）、`extractMentions`（无空白路径 + 带引号路径 + 尾斜杠目录提及；去重；上限 8）、`buildMentionBlock`（`<file path>`/`<directory path>` 包裹 + 「上下文非指令」免责句 + 读取失败如实标注 `[unavailable: …]`）、`capMentionContent`（32KB 截断标注）。6 单测。
  - `src/lib/chat/mentionResolver.ts`：发送时读文件（`fs_read_file`）/列目录（`fs_list_dir`）并组装注入块；`appendMentionBlock` 拼到用户文本尾（**挂当轮 user 消息，不进系统提示词**——缓存友好，对齐 ZCode/LiveAgent）。
  - Composer：`@` 触发候选菜单（`fs_glob` 查询 `**/*{query}*`，防抖 200ms，限 40 条）；选中把「@查询词」替换为「@路径 」。
- **⚠️ Tauri 实测抓出的潜伏缺陷（第 4 个）**：**聊天区（hasMessages 分支）的 LexicalComposer 从未传 `workspaceRoot`**（只有空态传了）⇒ 有任务时 @提及报「root 不能为空」、附件默认目录也失效。已补传 `effectiveWorkspaceRoot`。此类 props 缺口只有真实运行可发现。
- 验证（Tauri 端 CDP 实测）：`/` 真菜单（三内置命令 + 标签）出现、旧假菜单消失、零运行时异常；`@` 列出真实文件候选；选中 `@attention-test.txt` 发送后，SQLite 落库的 user 消息含完整注入块（`<file path="attention-test.txt">hello</file>` + 免责句）。`tsc` 0、`build` ✓、test:chat 118→**128**、cargo 133→**138**。

### 8.4 批次 D（上下文工程）落地（2026-09-28）
- **压缩引擎 `src/lib/chat/compaction.ts`（纯逻辑，11 单测）**：
  - `findCompactionRange`：按轮切分（user 开轮口径同 groupTurns），保留最近 `KEEP_RECENT_TURNS=4` 轮原样；**在途轮截断连续段**（其后的轮不压）、**已压缩轮跳过不截断**（初版 break 语义会让 compact 轮之后的轮永远压不了，实测后改为 continue）；绝不切进工具调用对。
  - `buildCompactionSource`（工具条目只留结果首行 200 字）+ `buildCompactionPrompt`（对齐 ZCode：保留文件路径/决策/未完成任务；**安全约束逐字保留**；不编造）。
  - `applyCompaction`：区间替换为 `kind:"compact"` 的 assistant 条目（id=`compact-<start>` 幂等；**`coveredCount`=被压缩消息总数存条目上**——初版渲染层重算恒 0，实测抓出后改为写入）；摘要同时落 apiMessage（刷新后可回灌）。
  - `microcompactMessages`：发送前裁较早轮 >4KB 的工具结果（首 800 + 尾 400 字符 + 省略标注），keepLastEntries=6 内不裁；**只影响发送视图不改时间线**；无变化返回原引用。
- **controller 接线**：`launchTurn(turnId, {autoCompact})` 发送前检查上一条 assistant 的 usage/contextWindow ≥ `COMPACTION_TRIGGER_RATIO=0.8` → 先压缩再发送；`compactNow()` 手动入口（忙时 false）；摘要调用走 runAgentTurn 通道（**systemPrompt 换成纯摘要引擎提示、不给 workspaceRoot**；⚠️ `maxSteps:1` 会把 faux/真实模型的摘要请求截死在工具轮（faux 两步形态：工具轮+正文轮）→ 实测抓出后改 8 步兜底）；失败**保持原状**（No-Fallback）+ `onCompactionEvent` 事件（started/done/failed/skipped）经池转发。
- **池**：`compactConversation(taskId)` + `onCompactionEvent(taskId, handler)`（entry.compactionHandlers 集合转发）。
- **UI**：`CompactionBand.tsx`（running shimmer 文案 / settled 可展开 seam：chips「已压缩 N 条消息」+ 摘要 markdown，全部语义变量 + prefers-reduced-motion 退化）；`TurnGroupView` 轮首 compact 条目渲染为 band、activity 渲染跳过之；`/compact` 接真实现（无内容 toast 诚实提示）。
- **Tauri 实测**：多轮任务（5 轮对话）`/compact` → 压缩带「已压缩 1 条消息」正确渲染、摘要落 SQLite、console 零 compaction 错误；2 轮任务 `/compact` 诚实报「没有可压缩的轮」。**实测抓出并修复 3 个 bug**：maxSteps:1 截断摘要（空内容）、coveredCount 数据链断（恒 0）、初版 compact-break 语义（压过一轮后永远不能再压）。
- 验证：`tsc` 0、`build` ✓、test:chat 118→**128**（compaction 11 例）、cargo 138。

### 8.5 批次 E（通知与红点）落地（2026-09-28，P0 收尾）
- **E1 后台任务完成系统通知 + 提示音**：
  - Rust：`tauri-plugin-notification = "2"`（capabilities 加 `notification:default`，lib.rs 注册插件）。
  - 前端 `src/lib/chat/taskNotifications.ts`：`sendSystemNotification`（权限请求 + 发送，Web 模式静默跳过）、`playNotificationSound`（WebAudio 合成双音 880→1320Hz，无音频资源依赖，失败静默）、`summarizeOutcome`（终态摘要：错误原文/已停止/末条 assistant 文本截 120 字）、开关持久化 kv `reinagent-notification-sound`（缺省开）。
  - 池：`refreshStreamingSet` 里检测「上一轮在流式、现在不在」的任务 → `subscribeTaskTerminal` 发终态事件（done/error/stopped + 末条 assistant 文本 + error + **awaitingDecision 标记**——审批挂起不算真终态）。
  - App 接线：订阅终态 → 「不是当前可见任务」才通知（`activeTaskId` + `document.visibilityState` 双判）→ 系统通知 + 提示音；runKey 去重（taskId+outcome+正文前 40 字），Set 上限 200 防泄漏。
  - 设置页：基础设置加「任务提示音」开关（WebAudio 播放开关，系统通知始终开）。
- **E2 侧栏审批红点（TaskInteractionBadge 最小版）**：
  - 池：`subscribePendingApprovals` / `getPendingApprovalTaskIds`（与流式集合同款签名通知，只有集合变化才重算；挂进 flushNotify）。
  - ProjectList 两类任务行（项目任务行 + 通用任务行）渲染琥珀色脉冲点（`--status-warn` + animate-pulse，title=approvalRequiredBadge）；点击任务即进入处理（现有行为）。
- **Tauri 实测**：任务 A 发消息后立即切到任务 B → A 完成（done）触发通知链路、console 零错误；模块/开关/订阅全部验证。**系统通知弹窗本体在 Windows 通知中心**（首次会请求授权），提示音为可听验证项。
- 验证：`tsc` 0、`build` ✓、五套前端测试全绿（128/43/18/6/12）+ hub 57 + cargo **138**。
- **菜单键盘导航（2026-09-28 补齐，用户反馈）**：`/` 与 `@` 菜单支持 ↑/↓ 移动高亮（循环）、Enter/Tab 选中、Esc 关闭；高亮项 `data-active` 标记 + `scrollIntoView(block:nearest)` 滚动跟随；查询词/候选变化时高亮复位第一项；菜单打开时 Enter 被导航拦截（不发送消息）。菜单过滤列表提升为组件层 `slashFiltered`（keydown 与渲染共用同一份）。Tauri 实测：两菜单 ↑↓↑ 与 Enter 选中全链路通过。

### 8.6 P1-1 工具级策略（2026-09-28）
- **存储**：`AppTask.toolPolicies?: Record<toolName, "allow"|"ask"|"deny">`（任务级，随任务落库；`updateTaskToolPolicy` 增改删一体）。MCP 服务器级策略存 `McpSettings.serverPolicy?: Record<serverId, policy>`（**纯前端字段**：App `setSettings` 只把 `servers` 发给 Rust，serverPolicy 不进 mcp_servers.json；hydrate 时从上一份切片保留）。
- **审批门语义（runAgentTurn `createApprovalGate` 新增第三参 toolPolicies）**：`allow` 直通（**full 模式下也生效**——显式用户意图优先于模式）；`deny` 拦截并告知模型策略设置；`ask` 把 effectiveMode 降为 ask（edit 对 write / full 对一切的自动放行被策略覆盖，强制挂起审批）。gate 注入条件放宽：`approval && (mode !== "full" || toolPolicies)`。
- **UI**：MCP 已配置卡（启用中的 server）恢复 LA 的 ToolPolicyToggle 列（allow/ask/deny 三态，服务器级——作用于该 server 全部 `mcp__<id>__<tool>` 工具）。
- 测试：`toolPolicy.test.mjs` 5 例（allow 直通/deny 拦截含 read 工具/ask 覆盖 edit 自动放行/未配置不回归）→ providers 18→**23**。
- MCP 服务器级策略的运行时匹配说明：MCP 工具名是 `mcp__<serverId>__<tool>`，策略键需为 serverId 时由门内 `resolveToolPermissionKind` 保守视为 write + `toolPolicies[toolName]` 精确名匹配；服务器级 → 工具名的展开由 UI 写入时按前缀匹配（后续增强，当前按工具全名/服务器 id 精确键）。
- **P1-2 AGENTS.md 注入（2026-09-28）**：Rust `agents_md.rs` `agents_md_read(workspace_root)` 按优先级扫 `AGENTS.md` → `.agents/AGENTS.md` → `CLAUDE.md` → `.claude/CLAUDE.md`（只取最优先命中一个；64KB 截断标注；空文件跳过；不存在返回空数组非错误）。`runAgentTurn` 组装 meta_user 块时注入为 `<instruction-file source path>` 段（标题「Project instructions — authoritative for this workspace」）。`buildMetaUserBlock` 参数序：currentDate → agentsMd → memory → skills。

### 8.7 P1-3 AskUserQuestion 工具 + 回合内提问卡（2026-09-28）
- **工具 `src/lib/agent/askUserTool.ts`**：`ask_user_question`（1..4 题 × 2..4 选项，≤1 推荐/题，允许自由输入缺省 true；schema maxLength 约束）。execute 走 `approval.request({ args: { kind: "question", questions } })` **挂起**；resolve 值三种：结构化 `{answers:[{question,answer}]}` → 回显 Q/A 收敛；`"reject"` → 跳过提示收敛；null/undefined → 未回答收敛（全部 No-Fallback 文本）。`isAskUserAnswer` 类型守卫。
- **通道放宽**：`ApprovalCoordinator.request` / controller `resolveApproval` / pool `resolveApproval` 接受 `ApprovalDecision | Record<string, unknown>`（审批字符串不变；结构化对象仅在 gate 消费层视为放行——回答负载由工具自身经 request 的 resolve 拿回）。
- **UI `AskQuestionCard.tsx`**（App 审批卡渲染分支：`args.kind === "question"` → 提问卡，否则审批卡）：标题「提问」+ 逐题单选卡（推荐项绿标）+ 「其他」自由输入 + 跳过/提交回答（未答齐禁用提交）。提交 → `resolveApproval(taskId, { answers })`。i18n askQuestionTitle/askOptionRecommended/askCustomPlaceholder/askSubmit/askSkip/askQuestionIncomplete。
- **挂载条件**：`runAgentTurn` 仅在有 approval 协调器时挂 `ask_user_question`（无协调器场景挂起无人应答）。
- **Tauri 实测**：ask 模式真实模型调用 → 提问卡挂起（问题+选项+推荐标渲染）→ 点选「继续」提交 → 工具收敛、模型确认收到回答。全链路（挂起→作答→收敛→继续）通过。

### 8.8 P1-4 后台 Bash 三件套（2026-09-28，Tauri 实测闭环）
- **Rust `src-tauri/src/bg_process.rs`**（4 命令，均为 `spawn_blocking` + `*_sync` 内部函数供测试）：
  - `bg_spawn(command, cwd)`：`spawn_shell` 启动（Windows `cmd /C` + `CREATE_NO_WINDOW` + `raw_arg`；Unix `sh -c`），stdout/stderr 各一读线程 `pump_stream` 追加进共享 `Arc<Mutex<Vec<u8>>>` 缓冲（**256KB 上限，丢头部保尾部**并累计 dropped），立即返回 `taskId`（`bg-<ms>`）；进程驻留不阻塞回合。
  - `bg_output(taskId, offset)`：`try_wait` 收割退出状态 → status（running/exited）+ exitCode + 增量 `newOutput` + `totalBytes` + `droppedBytes`。**offset 推进口径：totalBytes**。
  - `bg_stop(taskId)`：Windows `taskkill /PID <pid> /T /F` 杀进程树；幂等（不存在 → stopped:false）；停止后从注册表移除（**stopped 后历史不可读**，与 ZCode 语义一致）。
  - `bg_list()`：全部任务（刷新用）。
  - 单测 `bg_process_tests.rs` 4 例（spawn→增量读→stop 幂等→长驻强杀）全过。
- **前端 `src/lib/agent/tools.js`**：`background_bash` / `task_output` / `task_stop` 三工具（权限=exec；cwd 经 `resolveWorkspacePath`），回合内 turnActivity 标签「后台命令/任务输出/停止任务」。
- **⚠️ camelCase 铁律（Tauri 实测抓出的真 bug）**：`BgOutput`/`BgSpawnResult`/`BgStopResult` 均为 `serde(rename_all = "camelCase")` → JS 侧必须读 `taskId/exitCode/newOutput/totalBytes/droppedBytes`；首版写成 snake_case 导致模型看到 `output bytes: undefined`。**新增 Tauri 命令后，前端取值字段名必须对照 Rust 结构体的 serde 改名核对一遍。**
- **Tauri 实测记录**（CDP 驱动，模型真实调用）：`ping -n 60` 驻留 → taskId 秒回；自然退出后 `status: exited / exit: 0 / output bytes: 3149` 三字段真实填充；`task_stop` 返回 stopped；裸调验证 13,990 字节/301 行明文完整、**全链路无 base64 封装**（模型自称「输出带 base64 标记」系误读）。环境观察：本机 PATH 下 `timeout` 解析到 GNU coreutils（非 Windows timeout.exe），`sleep 6` 可用；全项目输出解码统一 `from_utf8_lossy`（exec/terminal/bg_process 一致，本机系统代码页为 UTF-8）。
- **同批附带修复（全量回归发现，均非 P1-4 引入）**：
  - `markdownBlocks.js` ReDoS 真回归：`DEFINITION_LINE_RE` 的 label 体贪婪吞尾+逐字回溯撞 V8 大字符串悬崖（64KB 敌意行 17.5ms，n 翻倍耗时 62×）→ 新增 `hasLinkDefinitionLine`：`]:` indexOf 快筛候选行、逐行跑完整正则（语义等价：能匹配的行必含 `]:`；12 语义用例 + 18 个仓库 md 对拍 0 mismatch）。
  - `taskModelIsolation.test.mjs` 过期断言（断言已废弃的 localStorage 键 `reinagent-tasks`，任务持久化已迁 SQLite）→ 删除旧键断言保留状态级隔离断言；同文件 `globalThis.window` mock 泄漏污染后续测试文件 → `after()` 还原现场。
  - 10 个测试文件静态 `import { registerHooks } from "node:module"`（Node 22.15+ API）在 bun 1.4.x 下抛 SyntaxError 且被计为文件级失败 → 改动态导入 + `typeof` 能力检测（bun 原生支持 .ts 无需钩子）；⚠️ 其中 compaction/todoProgress 是 CRLF 行尾，批量替换需按文件实际 EOL。
- 验证：**全量 297/297 全绿**（修复前 240 pass/10 fail/10 errors——registerHooks 连累 47 个测试没跑起来）+ `tsc` 0 + cargo bg 4/4。

### 8.9 P1-5 WebFetch / WebSearch（2026-09-28，Tauri 实测闭环）
- **调研结论**：ZCode/LA 的 WebSearch 都依赖 **provider 服务端原生搜索**（Anthropic `web_search` 工具注入/SSE 解析），我们的 OpenAI 兼容网关不支持 → 走**纯客户端路线**：Rust 出网（WebView 直连有 CORS）+ 无 Key 的 DuckDuckGo HTML 端点。ZCode WebFetch 的客户端实现思路（15min 缓存/100k 截断/结构化错误/egress 防护）直接移植。
- **Rust `src-tauri/src/web_tools.rs`**（2 命令，spawn_blocking + `*_sync`）：
  - `web_fetch(url, max_bytes?)`：URL 规范化（无 scheme 补 https、http 强制升级 https、拒凭证/超长/本地与保留地址）→ ureq GET（30s 超时、2MB 响应体硬上限 `take(max+1)` 超限即断）→ 文本类 MIME 校验 → HTML 经 `html2text` 转纯文本。UA 用标识 UA `ReinAgent-WebFetch/0.1`（对齐 ZCode）。
  - `web_search(query, allowed_domains?, blocked_domains?, max_results?)`：`html.duckduckgo.com/html/?q=` GET → 正则解析 `result__a` 链接 + `result__snippet` 摘要 → `uddg=` 百分号解码还原真实 URL → 广告剔除 + 客户端域名后缀过滤（白/黑名单不可同给，对齐 ZCode）→ 默认 10 条（上限 25）。**搜索 UA 必须用浏览器 UA**（标识 UA 收 202 反爬挑战页，实测）。
  - **广告过滤双保险**：外层直链 `duckduckgo.com/y.js` + **uddg 解码后兜底再查一次**（DDG 常把广告包在跳转里，实测抓出）。
  - **SSRF 防护**：`is_blocked_host`（localhost/.local/.internal、IPv4 私网/环回/CGNAT/基准网段、IPv6 ::1/fc00::/7/fe80::/10/::ffff: 映射）。⚠️ 实测踩坑：host 提取最初用 `rsplit(':').next()` 取到的是**端口**（"127.0.0.1:9333"→"9333"），带端口 URL 绕过拦截——必须 `split(':').next()`（`extract_host`），IPv6 方括号形态单独处理。
  - 单测 `web_tools_tests.rs` 8 例（实体解码/DDG 解析含包装广告/域名过滤/URL 规范化/SSRF 段位）。
- **代理支持（用户网络环境硬需求，实测 DDG 直连超时）**：`resolve_proxy()` 三级——kv 设置 `reinagent-web-proxy` 优先（非法值**如实报错**不静默直连）→ 环境变量（`Proxy::try_from_env`）→ 直连。设置页「联网代理」输入框（`src/lib/web/webProxy.ts`，kv 持久化，失焦/回车保存）。
- **前端工具（tools.js）**：`webfetch {url, prompt?}` + `websearch {query, allowed_domains?, blocked_domains?}`（权限=read 级）。webfetch 带**模块级 15min TTL 缓存**（LRU touch + FIFO 50 条上限，对齐 ZCode 进程级缓存语义），结果文本经 `TOOL_LIMITS.webFetchBytes`(30KB)/`webSearchBytes`(16KB) 截断；websearch 结果附 REMINDER（回答后必须以 Sources: 列表给链接，对齐 ZCode）。`prompt` 参数作为「关注点」提示随内容返回（不额外调模型——ZCode 用会话模型低档位回答，我们简化为内容直返）。
- **UI**：
  - `ToolCallCard` 新增 websearch（Globe + query + 结果数）与 webfetch（Globe + URL + `HTTP 状态 · 字节 · 缓存`）专属卡。
  - **联网搜索聚合行**：`buildActivitySegments`（turnActivity.ts，相邻 websearch 合段，隔任何其他条目即断组）+ `WebSearchGroupCard`（「已搜索 N 次 · N 个来源」+ 运行中扫光 + 部分失败红标 + 展开 query 行/来源行（favicon `/favicon.ico` 兜底 a.favicon.im，收起 5 条 + 「查看其余 N 个」），对齐 LA HostedSearchGroupView）。i18n 10 键（zh/en）。
- **Tauri 实测**（CDP 裸调 + 模型调用）：搜索 939ms/11 条、广告 0（修复前第一条是 uddg 包装的 Udemy 广告——单测补夹具）；`web_fetch` 抓 rust-lang.org 200/18,594B→5,159 字符可读文本（走代理）；SSRF 实测抓出 host 提取绕过 bug（已修+补测）。
- 验证：前端 300/300 + `tsc` 0 + Rust 150/150（web_tools 8 例）。

### 8.10 P1-6 子代理系统（第一批：引擎 + 回合内卡，2026-09-28）
- **形态取舍（调研结论）**：ZCode = 子代理是完整独立 session（事件镜像/右侧回放/恢复，重）；LA = 进程内递归 runner + 结构化卡 + 私有持久化（轻）。选 **LA 形态**：子代理跑 `subagentRunner.ts` 内的嵌套 `runTurn`（agentRuntime），转录只在内存、不写主会话历史，最终报告作为 `agent` 工具的 toolResult 回到主循环。
- **`src/lib/providers/subagentRunner.ts`**：
  - `createSubagentTool(deps)`：工具名 `agent`，参数 `{description, prompt, subagent_type?}`（**不暴露 model/run_in_background**——ZCode 教训：历史 tool call 里的旧 override 会长期污染）。类型 Explore / general-purpose，未知类型如实报错不猜测。
  - **结构性禁递归**：agent 工具由 runAgentTurn 解析出 model 后注入，`getTools()` 注册表里没有 agent——子代理工具集经 `filterToolsFor` 从注册表过滤，天然无递归。
  - **Explore**：只读白名单（read_file/list_dir/glob/grep/webfetch/websearch）+ 只读提示词 + 不挂审批门（结构性安全）；**general-purpose**：注册表全量 + 继承父审批门/AbortSignal（写操作弹主会话审批 = ZCode「路由回父」语义；父停子停）。
  - `SUBAGENT_MAX_STEPS=6`（ZCode 默认 4；实测 Deepseek 碎步形态 4 步连「列目录+报告」都触顶，放宽；触顶走 maxStepsReached 事实链）。子代理结果 = 事实头（类型·工具调用数·时长·token 聚合 + 触顶/停止/错误 ⚠）+ 最终报告；`details.kind="subagent"` 带 summary/usage 供 UI。
  - faux 分支同样注入（runAgentTurn 两条 source 路径）。
- **权限分级**：`resolveToolPermissionKind("agent") = "read"`（派发免审批，对齐 ZCode needsApproval:false）——实测首版未注册被保守视为 write 弹了审批；拦截下沉到子代理内部工具（general-purpose 继承父 gate，plan 模式下子代理写工具同样被拦），语义安全。
- **UI**：ToolCallCard agent 分支（Bot 图标 + description 主文案 + 完成后 `类型 · N 工具调用 · Ns` 次要文本 + 展开报告全文）。
- **测试**：`subagentRunner.test.mjs` 6 例（filterToolsFor 白名单/禁递归前置、summarize 聚合、端到端嵌套 faux、未知类型报错、审批门继承判别、常量与提示词）。
- **Tauri 实测**：模型真实派发 Explore 子代理（嵌套循环跑 glob/list_dir 调研）→ 报告回传主循环转述；第二轮验证派发不再弹审批；步数触顶 ⚠ 事实链生效（子代理如实报告不完整，主模型如实转告并自己补验证）。
- **本批未做（后续增量）**：子代理目录侧栏（Running/Ended，需内存 registry 或持久化）、后台子代理（run_in_background + 完成通知）、「在右侧打开」完整回放（依赖子会话持久化）、用户自定义 agents/*.md profile、MCP/记忆工具带入子代理。
- 验证：前端 306/306 + `tsc` 0。

### 8.10.1 P1-6 增量：后台子代理 + 运行登记表 + 目录面板（2026-09-28）
- **`src/lib/subagents/subagentRegistry.ts`**（内存登记表，对齐并行池的并发纪律）：
  - 快照**不可变更新**（getSnapshot 稳定引用）+ notify **微任务合并**（同步多笔变更一轮通知，防 Maximum update depth）；AbortController 存内部 controls 表**不进快照**。
  - `registerRun/updateRun/finishRun/stopRun/getRun/getRunSignal`；id 形态 `sub-<ms>-<seq>`；`__resetForTests` 测试隔离。
- **`agent` 工具新增 `run_in_background`**：立即返回 `Background subagent started: <id>` + `subagent_output` 查询提示；嵌套循环脱离父轮继续跑（独立 AbortController，侧栏可停）；后台完成 → registry 收束 + notify 回调（默认实现 = 系统通知 + 提示音，复用 E1 taskNotifications；可注入便于测试）。
- **`subagent_output` 工具**：按 id 查询状态/耗时/tokens/报告；未 id 如实报错。⚠️ **诚实性修复（实测抓出）**：后台触顶时 summary 可能只是中间叙述——`maxStepsReached` 必须随 finishRun 落 registry，查询输出带「⚠ 触达步数上限：下方内容可能是中间叙述」（首版后台路径丢标记，模型误把过程性文字当报告）。
- **权限分级**：`subagent_output` = read（⚠️ 又一次踩「未登记新工具被保守视为 write」——连续两批同坑，**新增工具必须同步登记 resolveToolPermissionKind**）。
- **右侧目录面板**：codeViewerSource 联合类型加 `{type:"subagents", title, focusId?}`；CodeViewerPaneHost 对应分支渲染 `SubagentsPanel`（实时 useSyncExternalStore 订阅）：Running/Ended 分组（ZCode TUI SubagentsSection 形态）、运行行 Stop 按钮（后台运行）、行点击进详情（id/类型/状态/时长/tokens/工具调用数/后台标记 + 任务全文 + 报告/错误）。agent 工具卡 `summaryAction`（「在右侧打开子代理面板」）聚焦对应运行。
- **Tauri 实测**：后台启动立即返回 id → 父轮继续 → 30s 后 subagent_output 查询 → completed + 触顶 ⚠ 如实转述；主模型正确识别「Explore 只读无法写文件」的能力边界并给出替代方案；面板详情视图全字段渲染正确。
- 验证：前端 310/310 + `tsc` 0（新增 subagentRegistry.test.mjs 3 例 + 后台端到端 1 例）。

### 8.11.1 用量面板复刻 ZCode（用户要求「一模一样」，2026-09-28）
- **做法**：直接复制 ZCode 源码（packages/ui/src/settings/usage-stats/ + components/ui/chart.tsx + tokenNumberFormat）到 `src/components/settings/usage-stats/`，仅适配 import 路径与两个兼容层——**图表逻辑零改动**。
- **兼容层**（差异全部收口）：`usageIntl.tsx`（同名 `useZCodeIntl`，内部 t+占位替换，settings.usage.* 键走宽松查询）；`usageTooltip.tsx`（ControlHintTooltip → lw Tooltip，⚠️ Radix Tooltip 必须 Provider——lw/ui/tooltip 已含）；`usageErrorBoundary.tsx`（ScopedErrorBoundary 最小替代，resetKeys 变化自动重试）；`useAppUsageStats.ts`（ZCode 走 service→RPC，我们直接 invoke `usage_snapshot`，保留版本号防竞态）。
- **快照契约**：Rust `usage_query` 重写为 ZCode `AppUsageSnapshot` 同形（summary 全字段含 streak/peak/longestSession/favoriteModel、heatmap 52 周自然周（周日起）+ level 分级（>75%→4/>50%→3/>25%→2）、dailyModelUsage 按日分模型、models 带 share；无 tools 数据 v1 空）。旧 usage_refresh 命令/自绘 UsageStatsSection 已删。
- **依赖**：`recharts@3.10.1`（ZCode 同款图表库；chart.tsx 复制版带 initialDimension 扩展）。图表 lazy + LoadBoundary（ZCode 因 decimal.js-light 在 Electron Linux 容器崩才 lazy——我们沿用同一防护）。
- **CSS**：global.css 追加 usage 色板（--color-usage-chart-1..6 / --color-usage-heatmap-0..4，sky 系 + color-mix surface，明暗两套 data-theme）；Tailwind 六共享色（foreground/surface/muted 等）此前已对齐 ZCode 语义，移植组件类名几乎直接可用。⚠️ Tabs pill 的 `data-active:` 变体要改成 `data-[state=active]:`（Radix 形态）。
- **⚠️ Rust 坑**：聚合 SQL 带 `?2` 占位就必须传两个参数（day/tool 每日查询改 `?1`）；`findLast` 需 es2023 lib（改 `[...arr].reverse().find`）。
- **实测**：驱动设置页→用量统计，汇总条 5 指标/热力图（13 个月份标签）/每日每周累计/时间范围 pill/双 Recharts 图全部渲染；截图存 /tmp 比对用户提供的 ZCode 截图，布局样式一致。数字：总 10.7 万/峰值 9.1 万/最长聊天 1 小时 8 分/连续 1 天。
- 验证：Rust 153/153（快照形状测试重写）+ `tsc` 0 + 前端 310/310。

- **8.11.1 追加修复（用户实测反馈）**：① 热力图空格不可见——level0 色原样照抄 ZCode（sky 0% + surface = 纯 surface），但我们的 --surface 是实色 #1e2028 与卡片背景完全同色（ZCode 的 surface 是 3% neutral-950 **半透明**叠色才可见）；修复：明/dark 两套 data-theme 分别用暗/亮白低混色。② hover 迟迟不出提示——每格自带 lw Tooltip 的 Provider 且未设 delayDuration（Radix 默认 700ms）；修复：usageTooltip 重写为 Radix 直用 + **共享 UsageTooltipProvider（delayDuration=0）**包 UsageHeatmap 顶层。CDP 验证：364 格 backgroundColor 与卡片背景 distinct、hover 即时出「2026年9月29日\n0 tokens · 0 轮消息」。
- **8.11.1 追加修复②（列/格 hover 高亮不可辨）**：行为代码本就在（weekly/cumulative 列 `group/usage-heatmap-column` 整列高亮、daily 单格 hover），真正根因是 **`@theme inline` 把 --color-border-hover 的值内联进工具类**，[data-theme="dark"] 的覆盖恒不生效，实际用的 fallback --border 与格子背景几乎同亮度。修复：usage 色板移出 inline 块用标准 `@theme`（工具类输出 var 引用，主题覆盖生效），border-hover 对齐 ZCode dark 值 = 30% 亮白 / 明 = 20% 暗色。CDP 实测：weekly hover 整列 7 格 borderTopColor 统一变 30% 白（hover 前透明）、daily hover 仅单格变、邻格不变，tooltip 均即时。

### 8.11 P1-7 用量统计图表（2026-09-28，Tauri 实测闭环）
- **架构（对齐 ZCode usage-observability，但零写入链路改动）**：不建新写入点——`usage_stats.rs` 的 `usage_backfill_sync` **幂等回填**既有 `part` 表（`api_message` assistant 原件 → main_turn 行；`tool_result` 中 agent 工具的 `details.usage` → subagent 行，model 列存 subagentType），`INSERT OR IGNORE`（id=`task:msg`）；打开面板时 `usage_refresh` 先回填再 SQL 聚合，数据即时最新。
- **事实表**：`model_usage`（conversation_store 迁移幂等追加，字段对齐 ZCode migration 0010 精简版：query_source/provider/model/started_at/input/output/cache_read/cache_write/total）。**口径**：total = input + output（cache 是 breakdown 不叠加，对齐 ZCode）；缓存命中率 = cacheRead/(input+cacheRead)（pi-ai input 不含缓存）。30 天滚动 prune。
- **⚠️ 实测抓出**：pi-ai AssistantMessage 的模型名字段是 **`model`**（不是 modelId）——首版回填 77 条 model=''；修复为 model→modelId→modelName 链 + 回填时 UPDATE 纠正历史空名行（IGNORE 不会自愈）。
- **聚合**：`usage_query` SQL 层完成 totals / 按模型分组（降序）/ 日归桶（`dayIndex=(started_at+tzOffsetMs)/86400000`，tz 由前端传）。无 cost 维度（对齐 ZCode）。
- **UI**：设置页新增「用量统计」分区（`UsageStatsSection.tsx`）：范围 Tabs（7d/30d/all）+ 汇总条（总 tokens/请求/命中率/输出）+ **热力图**（CSS Grid 14 周，level 0-4 按 max 归一）+ **日趋势**（自绘 SVG 折线近 30 天）+ **模型分布**（自绘 SVG 环形 + 图例份额）。**零新依赖**（不引 Recharts——ZCode 被 decimal.js-light 容器坑过才 lazy，我们直接自绘更稳）。子代理行显示「子代理 · <type>」。
- **测试**：`usage_stats_tests.rs` 3 例（回填幂等+字段提取、聚合口径+日桶、范围过滤）；⚠️ 测试时间必须贴近 now——回填内含 30 天 prune，1970 年代测试数据会被当场清掉（首个失败即此因）。
- **Tauri 实测**：真实回填 77 条历史记录；模型名纠正后三个模型正确分列（deepseek-v4.1-flash 73.1% / glm-5.3-flash 26.9% / deepseek-chat 0%）；设置页导航 → 汇总条/热力图/趋势/环形全部渲染；范围切换正常。
- 验证：Rust 153/153（+3）+ `tsc` 0 + 前端 310/310。
- **8.11.1 追加修复③（趋势图只显示有数据的天）**：dailyModelUsage 原 SQL GROUP BY 只返回有用量行的天（两天数据 = 两个点连线）；ZCode 的 30d/7d 协议结果是**连续每日序列**（其源码注释专门记过这个回归）。修复：usage_query 按 range 补齐——7d/30d 从范围起点到今天每天一行（无数据 models 空），all 从最早数据日补。测试断言同步（7d=7 天、all=4 天连续）。

## 十五、P1-8 记忆 Extraction 接线（2026-09-28，Tauri 实测闭环）
- **调研定论**：LA 有完整 Organizer（聚类+合并决策+风控闸+确认队列）与 Extraction（每轮后隐藏回合+SubmitMemoryPlan+事务 batch）；ZCode 只有 Extraction（受限子代理直写 memory 目录）。我们接 **LA 形态**。
- **已移植件**（记忆 Hub 移植时随行）：Rust organize.rs 全套命令、memory_apply_batch、schema（confidence/evidence 契约）、MemorySettingsDrawer/OrganizerHistoryModal、config.ts 常量、memoryManagerTool。
- **本批新增（Extraction 管线）**：
  - `prompts/extraction.ts` + `extraction/gating.ts` + `extraction/planTool.ts` + `extraction/context.ts`：LA 源码直移（仅 import 适配；tsc 全过后零逻辑改动）。
  - `extraction/extractionEngine.ts`（自写，对齐 LA 流程）：隐藏 runTurn 嵌套回合（同子代理模式）——system=抽取提示词、user=自包含块序（指令→拒绝→候选→本轮已写→工作区变更→对话窗口，稳定前缀吃缓存）、工具=只读 MemoryManager+SubmitMemoryPlan；提交→validateSubmittedPlan→planToApplyBatchArgs→一次 memoryApplyBatch；45s 超时；候选加载失败退化空块继续（如实）。
  - `chat/memory/extractionController.ts`：每会话至多一个在飞 run、新请求 coalesce、30s 节流、同一用户消息不重抽、LRU 128、短确认词 defer 到引擎裁决、fire-and-forget 绝不阻塞。
  - **钩子**：pool.refreshStreamingSet 终态 done（非 awaitingDecision）→ maybeExtractMemory——复用当轮 sendOptions 的 provider 配置构建模型（faux 跳过），runAgentTurn 导出 getStreamFnForApi。
- **⚠️ 坑**：validateSubmittedPlan 签名收整个 submission（非 items 数组）；记忆的 greeting/ack 门控在长度门控**之后**（2 字素「你好」报 too-short 而非 greeting——skip 等价）；⚠️ cat >> PROJECT_CONTEXT.md 时 cwd 漂移会把文件写到 src-tauri/ 下（已修正并 amend）。
- **Tauri 实测**：发「commit message 用英文祈使句」→ 回合完成自动抽取 → memory_list 出现 `commit-message-style`（type=user/conf=high）。
- **待做（Organizer 编排批）**：organizer service（scan→cluster→plan→gate→apply）+ prompts/organizer + useMemoryOrganizer 调度挂载 + Run Now 接线；MemorySettingsDrawer 的 organizer 模型选择。
- 验证：前端 314/314（+4 门控）+ `tsc` 0。

## 十六、P1-8 Organizer 编排批（2026-09-28，编排全链路实测）
- **移植**：`prompts/organizer.ts` + `organizer/pipeline.ts`（LA 直移，import 适配）+ `organizer/service.ts`（**适配重写**：LA runAssistantWithTools → 我们 runTurn 嵌套；provider 解析注入 `resolveModelDeps`（App 层实现：organizerModel→providers 列表，缺失回落主对话模型）；debug logger 去）。`lib/shared/value.ts` 随 pipeline 引入。
- **挂载**：App.tsx effect 装 `createMemoryOrganizerService`（deps：getSettings/advanceSchedule/resolveModelDeps/getWorkspaceRoot），providers/workspace 变化重建；`window.__memoryOrganizerPoke` 调试入口。**Run Now**：Drawer handleRunNow 先 `memoryOrganizeRunCreate({trigger:"manual"})`（pending）再 poke 领取（⚠️ 只 poke 不创建——organizerEnabled=false 时 due_claim 不建 run，实测踩过）。
- **编排语义（对齐 LA）**：scan（分页列全+scope 过滤+逐条读 body）→ cluster（≤8 条结构分簇，>8 条 LLM 主题聚类失败回退结构）→ plan（每簇一轮隐藏 LLM：ORGANIZER_PLAN_TOOL 捕获 + 只读 MemoryManager）→ gate（buildDecisions 风控）→ apply（manual=全进待确认队列；scheduled=仅 low-risk 自动 batch）→ run 记录全 phase 落库 + advanceSchedule。
- **实测**：Run Now → run 创建 → scan(input=1)→cluster→plan 全链路真实执行；plan 阶段主模型未提交整理工具（弱模型工具遵循问题，LA 同有 parseFailures 跳过路径）→ 失败如实落 run 记录（phase=plan、错误 summary）。⚠️ 已知缺口：~~① report.reviewItems 未随 organize_due_complete 持久化~~（**2026-09-29 复核为已修**：DB 实证同日 14:02 的 failed run 报告含 2 条 reviewItems 完整落库可读，读写链 due_complete→trimmed_protocol_json→row_to_organize_run 全通；13:55 的空 report run 是修复前遗留）；② 裸调 due_claim 置 running 后无人执行会卡 6h（stale 回收窗口，正常路径无此形态——调试残留）。
- 验证：前端 314/314 + `tsc` 0（service/pipeline/prompts 全编译）。
- **A2 回顶按钮 + dock 分离感 ✅**：`useChatScrollState(scrollEl)`（离底>120px 判定）；回顶圆钮（aria 回到顶部）+ 输入区 `data-dock-away` 顶部边框阴影。⚠️ 两个实测坑：① hook 必须依赖 **scrollEl state**（ref 时序晚于 effect 会静默跳过且永不重挂）；② 内容水合/流式增长**不触发 scroll 事件**——必须 ResizeObserver 监听容器与首子元素（否则初始空内容判定 false 后永不更新）。
- **A3 草稿持久化 ✅**：LexicalComposer 内部 draftKey（任务态 `reinagent-draft:<taskId>` / 新任务页 `reinagent-draft:__new__`），text 防抖 400ms 落 kv、归属切换恢复、发送清空。⚠️ CDP 测试注意：`Input.dispatchKeyEvent type:char` 与 `insertText` 都**不触发 React onChange**（DOM 值变但受控 state 不更新）——必须用「原型 setter + input 事件」。
- **A4 快照字段提示 ✅**：`buildTextToolResult` 的 `details.truncated/originalLength` 真值已有；ToolCallCard 通用兜底卡截断时显示「输出超过字节上限已截断（原始约 X KB）」诚实提示（完整内容未持久化，不提供假加载）。
- **E2E**：A1 查找/计数/导航/分页链 ✓；A2 贴底隐藏 ✓（滚离出现受 MessageList 贴底状态机与程序化滚动交互限制，真实滚轮可用）；A3 reload 恢复 ✓；A4 逻辑+tsc ✓。
- **批次 B 完成（2026-09-29）**：
  - **B1 错误归因徽标**：`errors.js errorCategory()` 六类分类（auth/balance/rate-limit/server/network/timeout，正则与 diagnoseError 同序）+ MessageItem 错误行分类徽标（unknown 不显示）+ errors.test.mjs 3 例 + errors.d.ts 声明。
  - **B2 多任务批量审批**：`PendingApprovalBatchBar.tsx`（≥2 任务挂起时聊天区顶部「{N} 个任务等待审批」+ 全部允许/全部拒绝，循环 pool.resolveApproval）；signature 字符串比对保证快照稳定。
  - **B3 命令安全模式选择器：已存在确认**——LexicalComposer 的 Approval Mode Dropdown（四档 plan/ask/edit/full 输入框工具栏下拉）即 ZCode V4ComposerModeSwitch / LA CommandSafetyModeSelector 的对应物，无需新做。

## 十七、P2 批次 A 进行中（2026-09-28）
- **A1a 会话内查找 ✅**：`useConversationFind.ts`（消息正文/思考/工具结果大小写不敏感子串匹配，按消息聚合计数）+ `FindBar.tsx`（fixed 顶部浮条：输入/「n / m」计数/Enter+Shift+Enter 导航/Esc 关闭）；命中跳转复用 MessageList 既有 scrollTargetMessageId 机制（滚动定位+消息高亮）；Ctrl+F/Cmd+F 呼出（输入框聚焦时不劫持）。⚠️ 实测坑：reload 后 composer 自动聚焦，Ctrl+F 被「输入框不劫持」逻辑正确跳过——CDP 测试须先点消息区让 composer 失焦；FindBar 必须 **fixed**（absolute 会随容器滚出视口）。
- **A1b 加载更早消息 ✅**：Rust `conversation_load_page(task_id, limit, before_seq)`——取 seq<before 的最新 limit 条（升序）+total+has_more+first_seq；pool hydration 默认拉最新 **500 条**（普通会话行为不变），超长会话顶部「加载更早消息（剩 N 条）」按钮增量 prepend；loadOlder 锚点用 entry.oldestSeq（TimelineEntry 无 seq 字段，hydration 时从 rows[0].seq 记录）。⚠️ 快照结构体漏 `rename_all="camelCase"` 时 JS 读 firstSeq=undefined——本验证脚本踩过，pool 代码读 snake_case（has_more）反而正确。
- **E2E**：588 行灌入验证分页链（page1 500+hasMore=true/firstSeq=88 → page2 88+hasMore=false，去重 588）✓；普通会话（38 行）fullyLoaded 无按钮（行为不变）✓；测试数据已清理恢复 38 行。
- **批次 C 进行中（2026-09-29）**：
  - **C1 选区引用菜单（代码完成，待真实拖选验证）**：`lib/chat/selectionReference.ts`（按任务内存 Map + 限额 8000/8条/16000 + (taskId,text) 去重 + userselect 尾块协议 `# userselect:` + ```userselect JSON```）+ `useTextSelection.ts`（mouseup/touchend 主触发、selectionchange 折叠即关、滚动 capture/Escape/resize 关）+ `SelectionActionMenu.tsx`（Portal fixed 浮层：添加到当前任务/复制）；composer 引用 chips（×移除）；发送即消费（buildPromptWithSelections 拼 userselect 尾块后清引用）。
  - ⚠️ C1 实测坑：① useTextSelection 的 root 必须走 **chatScrollEl state**（自行查询 mount 时 null 且永不重挂，与 useChatScrollState 同坑）；② **hook 调用必须在使用它的 state 声明之后**（chatScrollEl TDZ）；③ CDP 验证选区浮层受阻：`Input.dispatchKeyEvent type:char` 与 `insertText` 都不触发 React onChange（DOM 变受控 state 不变）；程序化 setRange + mouseReleased 会被水合重挂/贴底状态机清选区——**真实拖选待用户手测**。
  - **C2 代码评论卡：未开始**（`::code-comment` 行内指令协议解析 + 折叠卡 + 点击定位，ZCode assistantCodeComment.ts/assistantDirectiveParser.ts 可直移）。
- **C2 代码评论卡 ✅（2026-09-29）**：ZCode `assistantCodeComment.ts` + `assistantDirectiveParser.ts` 直移（`::code-comment{title body file start end priority}` 行内指令；手写 name="value" 扫描器；代码围栏内忽略；流式未闭合尾部隐藏；解析后原文从可见正文抹除——`projectAssistantCodeComments().visibleText`）。文件解析 shim 内联（resolveWorkspacePath，http/file:/~ 失败关闭）。卡片挂 TurnGroupView（终态 lastAssistant）：正文渲染走 visibleText、卡片列表渲染其后、点击开文件预览。**提示词侧**：模型要产出评论需在系统提示词声明协议（暂未声明——待 PROMPTS.md 增补），故当前模型不会自发输出该指令。
- **解析单测**：assistantCodeComment.test.mjs 5 例（完整指令/围栏内忽略+缺字段/投影抹除/流式防闪现/50 张上限+非法 priority 丢弃）。
- **批次 D 核心完成（2026-09-29）**：
  - **Rust `git_panel.rs`**：git_status（porcelain v1 -b 解析+分支提取）/git_branch_list/git_checkout（分支名白名单防注入）/git_log（%H%an%ct%s 分隔协议）；非 git 仓库返回 isGitRepo=false 空态而非错误；spawn git CLI 不引 git2。git_panel_tests.rs 2 例（分支名注入校验含命令包装层/真仓库拒绝原文上抛）。
  - **`fs_tree.rs` fs_tree_dir**：单层目录（名称+is_dir+size，目录优先排序）——文件树懒加载的后端。
  - **前端**：`lib/git/api.ts` 封装；`GitPanel.tsx`（分支切换 select+变更列表【?? 绿/D 红/其他 amber】+提交历史，手动刷新）；`FilesPanel.tsx`（懒加载目录树，目录点击逐层展开、文件点击回调开预览）；右侧面板 codeViewerSource 加 "git"/"files" 两类型 + CodeViewerPaneHost 分支渲染 + 面板头部互切按钮（Git↔文件树）；侧栏底栏 Git 入口按钮（onOpenGitPanel）。
  - **实测**：git_status/branch_list/log 裸调真实数据（dev/main 分支、11 条变更、真实提交历史）；Git 面板渲染 PI-Desktop 工作区（变更 2 条+提交历史）；文件树渲染完整层级（目录优先+根文件）。
  - **D 尾巴（2026-09-29 已清两欠）**：~~提交图谱可视化~~ ✅（见十八）／~~Git 面板刷新自动轮询~~ ✅（见十八）；**未做：代码审查 tab（code-review 预览模式）**。
- **批次 E 完成（2026-09-29）**：
  - **PDF/PPTX 引擎已存在确认**：PreviewPane 已含 pdf.js range 加载（小 PDF 全量 <2MB）与 PPTX 解析（≤64MB），file 类型按扩展名自动分发——非缺口。
  - **Office 真引擎替换 stub ✅**：装 docx-preview + xlsx；`previewPaneOfficeContent.tsx` 重写——docx 走 renderAsync 分页 HTML、excel 走 SheetJS 逐 sheet 转 HTML（多 sheet 切换 tab）、legacy .doc 如实不支持提示；CSS 加 docx 分页阴影与 xlsx 表格样式。
  - **⚠️ 实测抓出真正缺口**：`useFileService.readBinaryPreview` 是阶段 1 留下的 throw stub——Office/PPTX 预览拿到的一直是错误！补 Rust `fs_base64.rs fs_read_base64_file`（64MB 上限）+ 实现 readBinaryPreview/readFileRange（base64 切段兜底）/stat 三方法。
  - **E2E**：文件树点 xlsx → 面包屑/表格数据完整渲染（名称/数量/价格）✓；测试文件已清理。
- **批次 F 完成（2026-09-29）**：
  - **F1 steering 运行中引导消息 ✅**：controller.send 流式中不再拒绝——入队 `ChatState.steerQueue`（返回 true 供 Composer 清空输入）；轮收敛后仅「自然完成」才取一条复用 send 续跑（停止/错误停下，队列保留）；`SteerQueuePanel`（composer 上方排队列表 + × 撤回，pool 级 removeSteerMessage）。⚠️ 语义变更：3 个旧断言（流式 send 返回 false）按新语义更新。
  - **F2 ClarifyPanel 评估：不立项**——ZCode 的 ClarifyPanel 依赖 ExitPlanMode elicitation 挂起（P1-3 提问卡已覆盖同类交互：ask_user_question 挂起 + 选项卡），且我们的 Plan 模式当前是纯提示词拦截（无 ExitPlanMode 工具）。待 Plan 模式工具化（P1-3 尾巴）后随批评估。
- **批次 G 进行中（2026-09-29）**：
  - **G1 快捷键集中管理 ✅（部分）**：App 全局 keydown 集中 handler——Ctrl/Cmd+F 会话内查找、Ctrl/Cmd+T 新任务（编辑框聚焦放行）、Ctrl/Cmd+Shift+A 聚焦 composer；handleNewTask 经 ref 转发（effect 依赖 [] 而函数后声明）。⚠️ CDP 实测 Ctrl+T 视图未切（探针 __newTask 直调同样）——handleNewTask→setActiveTaskId(null) 链路在 CDP 下疑似被恢复逻辑回写，真实键盘待用户手测；Ctrl+F 已实测有效。
  - **G2 Hooks/插件系统、G1 命令面板、托盘/自动更新：未开始**（大基建，单独批次）。
- **P2 追加：输入框 ↑ 历史召回 ✅（2026-09-29，CDP 全链路实测）**：对齐 ZCode promptHistory 体系（纯逻辑直移 + textarea 化改造）。
  - **`lib/chat/promptHistory.ts`**：`appendPromptHistoryEntry`（trim 空不入库；**仅连续重复去重**——A/B/A 保留；30 条限额）+ `navigatePromptHistory`（↑ 从末条往前、到顶 clamp 停住；↓ 走回末条后再按一次 → **回空输入退出浏览态**；未浏览时 ↓/↑ 都从末条进入）。
  - **`lib/chat/promptHistoryStorage.ts`**：per-workspace kv 持久化（键 `reinagent-chat-prompt-history:<workspacePath>`，JSON 数组读时消毒 slice(-30)）——重启历史保留、跨项目不串。
  - **LexicalComposer 接线**：`historyIndexRef` 浏览游标（ref 非 state，不驱动渲染）；handleKeyDown 在菜单导航/Enter 之后处理 ↑/↓——**仅「输入框为空或已处于浏览态」接管**，Shift/Ctrl/Meta/Alt/isComposing 不接管（多行编辑光标移动不受影响）；handleInputChange 手动编辑且与当前历史条目不一致 → 退出浏览态；发送 accepted 后 **读-增-写**（readPromptHistoryEntries→append→persist，防多实例覆盖）并重置游标；草稿切换/workspacePath 切换重置游标。App 两处渲染传 `workspacePath={workspaceProject}`（活动任务 project 优先、草稿态用 selectedProject——与上下文根同源）。与 ZCode 的差异：纯 textarea 无需 Lexical 的 HISTORY_NAVIGATION_UPDATE_TAG 防斜杠菜单机制（setText 不触发 parseSlashQuery 的 / 前缀态）。
  - **CDP 实测（WebView2 :9333）**：SQLite 直种 3 条历史→reload→composer 选 PI-Desktop（workspacePath effect 从 kvCache 拉到种子）→↑γ/↑β/↑α/↑clamp/↓β/↓γ/↓空/↓再入γ 全链路 8 断言过；手动编辑退出浏览态、非空 ↑ 不劫持（prevented=false）过；种子→reload 读回即**跨重启持久性**实证。发送入史路径由单测覆盖（避免实测造任务污染）。测试种子已清理、active-task-id 已还原。
  - ⚠️ 坑：**MSYS bash 会吞 `bun -e` 内联 JS 中的反斜杠**（种子键写成 `E:DevCodeReinAgentPI-Desktop` 静默错键）——含路径/反斜杠的脚本一律写 .cjs 文件执行；CDP 断言 React 受控值须在 keydown 后 `await setTimeout(60)`（dispatch 非 React 事件，更新微任务批处理，同步读 DOM 还是旧值）。
  - **用户实测抓出两连 bug（2026-09-29 修复）**：① **project 为 null 的任务历史全废**——最初用 `workspaceProject`（任务 project 字段）做历史键，无项目任务传 undefined → 读写全跳过（↑ 无反应根因）。修复：删 `workspacePath` prop，**历史作用域直接用 `workspaceRoot`**（resolveWorkspaceRoot 已归一化为正斜杠、活动任务与草稿态恒有值：有项目=项目路径，无项目=`<home>/.ReinAgent/DefaultProject`）。② **会话中 composer 漏传 taskId**（P2-A3 遗留，第二处渲染没有）→ 会话草稿全写进 `reinagent-draft:__new__` 全局键（↑ 召回文本也会被防抖写成草稿 → 重挂后预填 → 输入框非空 ↑ 正确不接管，看似「失灵」且污染新任务页）。修复：第二处补 `taskId={activeTaskId}`。修复后 CDP 真发送链路实测：A 任务会话输入→Enter 真发送→↑ 召回刚发消息→↓ 回空，DB 落键 `<home>/.ReinAgent/DefaultProject` ✓。
- **P2 追加：刷新丢消息（压缩后会话持久化全废）✅（2026-09-29，CDP 真发送+刷新闭环实测）**：用户报「发送的消息和回复，一刷新页面就没有了」。根因链：`restoreState` 把 `nextMessageSeq` 按 **`messages.length`** 恢复——被压缩过的会话 hydration 后 id 是 `compact-0`+`m10..m17`（length=9，max(id)+1=18），新轮次从 m9/m10 起重生成 → 与 hydrated 条目撞 `UNIQUE(task_id, msg_id)` → `conversation_sync` 的「事务内全删全插」整体被拒（DELETE+INSERT 原子回滚），**该任务从此一条都落不了库**，且界面无感知（仅 console.error）。触发条件=压缩(或编辑重发截断)过会话 + 重启后继续聊；未压缩会话 length 与计数器一致故从未暴露。修复：① `restoreState` 按 **max(/^m(\d+)$/)+1 与 length 取大**恢复计数器；② `loadOlderMessages` 前置更早历史时同样抬升计数器（防同类撞车）；③ conversationModel.test.mjs 回归 1 例（压缩形状 hydration→append 得 m18/m19、非数字 id 回退 length）。CDP 实测：修后压缩会话发消息→0 sync 错误→DB 落 m18/m19→reload 后消息仍在 ✓。⚠️ 教训：全量替换式同步（delete-all+insert-all）对重复 id 是整批全败，凡「从持久层恢复状态机」的字段必须按数据真实形状重算而非按数组长度猜。
- **P2 尾巴批 1：#2 Git 面板自动轮询 / #3 提交图谱 / #5 ::code-comment 提示词声明 ✅（2026-09-29）**：
  - **#2 自动轮询**：ZCode 用文件监听+60s 防抖（useGitAutoRefresh），我们无监听服务 → 面板挂载期 `setInterval` 10s 静默刷新（`refresh({silent})`：不转 loading、失败仅 console.warn 保留上次好数据；手动链路仍大字报错）+ visibilitychange 可见即刷；**单飞护栏 refreshingRef**（上轮未完成不叠加，对齐 ZCode「agent 批量写文件避免密集 git I/O」）；switching 中跳过。非仓库态也轮询（自愈：git init 后 10s 内面板自动恢复，成本一次 fail-fast git_status 可忽略）。⚠️ 实测坑：**CDP 里 patch `__TAURI_INTERNALS__.invoke` 计数不可靠（0 次误报）、1s 采样抓不到毫秒级 git.exe**——最终靠组件内临时埋点（`window.__gpTick/__gpRefresh`）拿到真相：14s 内 tick=1/refresh=2（挂载+1 tick）✓。
  - **#3 提交图谱**：Rust `git_log` format 追加 `%x1f%P`（parents 空格分隔，根提交空数组，serde default）→ `lib/git/graphLayout.ts` 移植 ZCode git-graph 的 layoutAlgorithm+layout（裁 refs/选中态；泳道分配=分支着色核心；四色轮转 `--git-lane-0..3` 语义 token，dark #e6e8ee/#38bdf8/#2dd4bf/#fbbf24、light 深色版）→ GitPanel 提交历史区：绝对定位 SVG（连线层 paths + 节点 circles r4 stroke=var(--bg)）+ 右侧行块 rowHeight=42 对齐。graphLayout.test.mjs 5 例（线性单泳道/合并双泳道/窗口截断/空历史/**倒序拓扑护栏**）。⚠️ **算法铁律：输入必须 git log 最新在前（parent 恒在更高下标）**——倒序输入 determineNormalPath 够不到 parent 永不注册 → while 死循环（测试初版写反顺序即挂死，已加 `iterations > vertices.length*4+8` 护栏）。CDP 实测 PI-Desktop 真仓库：50 节点/227 连线/6 泳道/`--git-lane-*` 生效 ✓。
  - **#5 提示词声明**：`::code-comment{...}` 指令协议逐字采纳 ZCode desktop.ts 的 Inline Code Comments 小节进 DEFAULT_SYSTEM_PROMPT（# Code style 之后）——P2-C2 评论卡此前不触发的根因即协议未声明；PROMPTS.md 同步。
- **P2 尾巴批 2：#8 Plan 模式工具化 + ExitPlanMode ✅（2026-09-29，真模型 E2E 闭环）**：
  - **工具**：`lib/agent/exitPlanModeTool.ts`（对齐 ZCode contracts/tools/plan-mode.ts 契约：input={plan≤20000 字 trim 非空, allowedPrompts?=[{tool:"Bash",prompt}]}；execute 经 approval.request 挂起 args.kind="plan" → UI PlanModeCard → resolve {approved, feedback?}；拒绝/跳过都提示模型仍处计划模式调整重提）。
  - **审批门**：`createApprovalGate` 顶部加 exit_plan_mode 专用分支（**模式门优先于工具级策略**，对齐 ZCode mode.plan.exitOnly）：仅 plan 模式放行（放行后由工具自身挂起），其余模式 block 并提示无需提交计划。`resolveToolPermissionKind` 登记 exit_plan_mode + **顺带补登记 ask_user_question（同类遗留坑：一直按默认 write 处理——计划模式下提问卡被拦、ask 模式双重审批）**。
  - **提示词**：PLAN_MODE_PROMPT 重写——只读工具白名单扩到 glob/grep/webfetch/websearch，明确「调研完成必须调 exit_plan_mode 提交计划，不要纯文本输出计划后停住」。
  - **UI**：`PlanModeCard`（计划正文走 MarkdownText 渲染 + allowedPrompts 清单 + 拒绝反馈 textarea +「批准并开始执行」）；App 分发 kind==="plan"（ApprovalCard fallback 同时排除 question/plan）。**批准 = App 层先 `updateTaskApprovalMode(taskId,"ask")` 再 resolve（顺序保证工具收敛后模型的写/执行走新模式门）**；拒绝 resolve {approved:false, feedback}。
  - **E2E（真模型）**：composer 切计划模式→发调研指令→模型 12.5s 后调 exit_plan_mode → 计划卡渲染（markdown 正文+批准/拒绝）→点批准→卡消失+任务模式按钮变「变更前确认」+模型继续流式 ✓。测试后已停回合并把任务模式还原 完全访问。
  - i18n 新键 planCard*（中英）。
- **P2 尾巴批 3：#4 代码审查预览模式 ✅（2026-09-29，真模型 E2E）**：
  - **现状盘点**：C2 已移植全部机器（`preview/lib/codeViewer.ts` 的 code-review 源类型 + `previewPaneCodeReview.ts` 投影 + PreviewPane/previewPaneContent 消费链），**唯一缺口是没有任何构造方**——评论卡点击开的是普通 file 预览。
  - **接线三处**：useAppStore `codeViewerSource`/`openCodeViewer` 联合类型加 code-review 变体（{requestId,title,body,priority?,startLine?,endLine?}）；CodeViewerPaneHost Extract 联合 + buildSource 透传分支（path 按工作区根解析）；TurnGroupView 评论卡点击改开 `type:"code-review"`（requestId=card.id）。
  - **实测抓出两连真问题并修**：① **弯引号指令整卡丢失**——真模型（GLM）输出 `title=“演示评论”`（成对智能引号），解析器 `allowSmartQuotes` 是 citation 专属 opt-in，code-comment 未开 → 指令静默丢弃无卡。修复：code-comment 解析开 `{allowSmartQuotes:true}`（指令体是自然语言，容忍成对智能引号属解析真实输出；+1 回归单测）。② **C2 漏发 5 个 i18n 键**（codeCommentsOne/Many、codeCommentCardsExpand/Collapse/OpenReview 一直显示原始键名）——补齐中英（文案取 ZCode locales 原文）。
  - **E2E**：真模型按 #5 声明输出指令 → 卡渲染（"1 条代码评论"）→ 展开点击 → 预览面板 code-review 模式：package.json 加载（data-language=json）+ 评论覆盖层渲染 body + 无越界警告（range 可见）✓。⚠️ 机制备忘：评论卡列表默认**折叠**（头部按钮展开后才有点卡行）。
- **P2 尾巴批 4：#6 记忆管线独立模型统一解析 ✅（2026-09-29，4 单测）**：
  - **真实缺口**：Organizer 编排批早已支持 `MemorySettings.organizerModel`（App resolveModelDeps），但**聊天后 Extraction 抽取（pool.maybeExtractMemory）无条件用主对话模型**，独立模型配置被无视；`summaryModel` 则是死设置（有选择器无消费方——LA 语义为对话总结模型，我们压缩摘要走 compaction 引擎，暂维持死设置待压缩批接线）。
  - **修复**：收编 App 内联解析为 `lib/memory/modelResolution.ts resolveIndependentMemoryModelDeps(memory, providers)`（organizerModel→供应商→buildModel；未配置/供应商不存在→null 回落主模型；Key 为空→抛错 No-Fallback）；**App resolveModelDeps 与 pool.maybeExtractMemory 同源复用**——extraction 现在优先独立模型（解析失败 warn 后回落主模型，不打断聊天终态流；organizer 路径失败仍直接抛）。
  - **⚠️ i18n 误判教训**：抽屉 28 个「缺失」键实际全在 `i18n/hub/zh.ts`/`en.ts`（LA hub 移植批自带，`...hubZh` 展开进语言对象）——**查键缺失必须扫 hub 目录**，只 grep index.ts 会误判（本次据此误加 26 个重复键触发 TS2783 已撤销，真正缺的仅 settings.close / settings.memoryOrganizerPhase2 两个，已补进 hub 文件）。
  - modelResolution.test.mjs 4 例（未配置 null/供应商不存在 null/Key 空 No-Fallback 抛错/完整配置构建 deps）。
- **P2 尾巴批 5：#7 子会话持久化 + 完整回放 ✅（2026-09-29，真模型 E2E 跨重启闭环）**：
  - **落库**：`subagentRunner.persistSubagentTranscript(runId, messages)`——runTurn 收束后把转录写入 conversations.db 既有 message/part 两表（**task_id = `subagent:<runId>`**，不写 task 表 → 不进会话列表/水合），复用 conversation_sync 全量替换；每条 pi-ai 消息一行 + 单个 `transcript_message` part（整条 JSON 忠实原样，含 system/思考/工具调用与结果）。失败仅 warn（回放是增强，不影响子代理结果收敛）。
  - **回放 UI**：`SubagentReplay.tsx`——conversation_load_page 读回 → 逐条按角色渲染（user 提示词 / assistant 正文 + thinking 折叠 + `tool: <名>` 参数折叠 / toolResult 结果），加载失败/无记录如实空态（诚实标注「早于持久化上线或落库失败」）。
  - **入口与跨重启语义**：子代理面板（ToolCallCard 摘要行「在右侧打开子代理面板」→ focusId）；**registry（内存）有记录 → 详情视图 + 「完整回放对话」按钮（面板底部二级视图，可返回）**；**registry 无记录（重启后）→ 面板直接整体渲染持久化回放**（DB 是跨重启唯一可靠源——初版把回放按钮挂在 registry 详情里，reload 后不可达，E2E 抓出后改为双路径）。i18n subagentReplay* 四键。
  - **⚠️ E2E 坑**：① ToolLayout 的 summaryAction 渲染的是 `div[role=button][aria-label]` **不是 `<button>`**——CDP 按 button 标签找会扑空；② 完成回合的工具卡折叠进回合体，虚拟化+折叠下卡不可点——用后台子代理（run_in_background=true，卡片在 live 尾即时挂载）或先展开回合头。
  - **E2E**：真模型派 Explore 子代理（前台+后台各一）→ 转录落库（subagent:sub-… 5 条消息含 system）→ reload 清空 registry 后从卡片点开 → 完整回放渲染全转录 ✓。346/346 + tsc 0。
- **P2 尾巴批 6：#9-Hooks 系统（G2 第一块）✅（2026-09-29，真模型 E2E 全决策路径）**：
  - **Rust `hooks.rs hook_execute`**：spawn shell（win cmd /C + CREATE_NO_WINDOW、unix sh -c）+ stdin 写事件 JSON + 限时轮询（默认 30s 上限 120s，超时 kill）→ {exitCode, stdout, stderr, timedOut}。
  - **TS `lib/hooks/hooksRuntime.ts`**：发现（`<root>/.ReinAgent/config.json` 的 hooks 数组：event/matcher?/command/timeoutMs?）+ 信任评审（kv `reinagent-hooks-trust:<root>` = 配置原文指纹，变更即重新待审）+ 运行器（宽松输出协议：stdout JSON {decision: block|approve, reason, additionalContext} 或 **exit 2 = block**；首条 block 短路；发现缓存 5s TTL——full 模式每工具调用都过 PreToolUse 不能每次读盘）。
  - **接线**：① PreToolUse 挂 createApprovalGate 最前部（exit_plan_mode 模式门之后、工具级策略之前）：block 短路、approve 跳过审批矩阵、无裁决走原流程；**gate 安装条件放宽为 `approval` 恒装**（原 full 且无策略不装门 → hooks 永不执行，E2E 抓出；门内 read/full 早退保留 full 零审批语义）；② UserPromptSubmit 在 App.handleSend 入口（blocked → toast 不发送；**乐观受理取舍：输入已清空**）；③ Stop 经 subscribeTaskTerminal 终态 fire-and-forget。PostToolUse/PermissionRequest/SessionStart 本批未做（需 runtime 级挂点，见下批）。
  - **UI**：聊天区顶部信任横幅（条目清单 + 批准/拒绝；拒绝 = kv 写空串）。
  - **E2E**：echo hook_execute ✓；信任横幅批准 ✓；UserPromptSubmit exit-2 拦截（DB 实证：前 3 次未拦截的消息落库 seq 59-65，修复后第 4 次无新消息）✓；PreToolUse JSON block 于 **完全访问模式** 拦截 exec_command（[Hook:PreToolUse] 理由 + gate 探针 ran/blocked）✓。测试配置已清理。
  - **⚠️ 坑**：① **MSYS bun -e 反斜杠吞噬再踩**（hook 命令 `C:\Windows\...` 被吃成 `C:Windows...` → findstr 永不命中）——老老实实写 .cjs 种子；② Windows `find` 被 Git 的 UNIX find 抢占——hook 命令务必用显式 `%SystemRoot%\System32\` 路径；③ 完成回合的工具卡折叠且 summaryAction 是 `div[role=button]` 非 `<button>`——CDP 定位面板入口用 aria-label 全局查。
- **P2 尾巴批 7：#9-命令面板 ✅（2026-09-29，CDP E2E）**：`CommandPalette.tsx`（Portal 顶部居中浮层；大小写不敏感子串过滤 label+keywords；↑↓ 循环移动/Enter 执行/Esc 关闭/backdrop 点击关闭；高亮 scrollIntoView）。触发 = G1 集中键盘 handler 加 **Ctrl/Cmd+K**（编辑框聚焦也放行——全局命令入口）。命令注册表在 App（paletteCommands useMemo + ref 随渲染刷新）：新建任务/设置/工作台/自动化/Skills/MCP/记忆/Git 面板/文件树/子代理/清空会话/压缩上下文/切主题/切侧栏/聚焦输入/会话内查找 共 16 条。⚠️ 坑：注册表的 useMemo/useRef **必须放 currentView 条件早退之前**（hooks 顺序不能条件化——初版放早退后，切设置页即 hooks 顺序崩）。E2E：Ctrl+K 呼出 → 过滤 "git" 仅剩「打开 Git 面板」→ Enter 执行 → Git 面板打开 ✓。i18n palette* 键（中英）。
- **P2 尾巴批 8：#9-托盘 + 自动更新器 ✅（2026-09-29，E2E 诚实路径）**：
  - **托盘**：Cargo tauri 加 `tray-icon` 特性；`app_tray.rs setup_tray`——图标（打包默认）+ 菜单（显示主窗口/退出）+ **左键单击切换主窗口显隐**；setup 失败仅打日志不阻断启动。conf 加 `app.trayIcon`。
  - **自动更新器**：`tauri-plugin-updater` + `tauri-plugin-process`；`updater.rs update_check/update_install`——**更新源不写死构建期**，由前端 kv（`reinagent-update-endpoint`）传入（静态 latest.json 每端点）；未配置 → configured:false 诚实态；URL 无效/网络失败/签名失败全部如实上抛。安装 = 重检→download_and_install→成功即 restart。插件要求 conf `plugins.updater`（含 **pubkey 必填**）——已生成正式 minisign 密钥对（`C:/Users/bytes/.tauri/reinagent.key[.pub]`，**私钥勿入库**，发布签名用），pubkey 入 conf。
  - **设置 UI**：`AppUpdaterCard`（关于 tab）——更新源输入 + 检查更新 + 可用时「下载并安装」；未配置/错误全部如实渲染。
  - **E2E**：空端点 → 「未配置更新源」✓；不可达端点 → 「检查更新失败：error sending request…」如实错误 ✓；**hasUpdate 真实路径需发布服务器+签名产物，本批无法端到端**（诚实边界，已记录）。托盘 CDP 不可见——应用无 panic 启动即托盘构建成功（代码级验证）。
  - **⚠️ 坑**：updater 插件 conf 缺 `plugins.updater.pubkey` 启动即 panic（PluginInitialization）；`update.check()` 是 async（不能进 spawn_blocking）；Update 字段是 `body`/`date`（非 notes/pub_date）。
- **P2 尾巴批 9：#9-单实例锁 + 插件系统 v1 ✅（2026-09-29，E2E 闭环）**：
  - **单实例锁**：`tauri-plugin-single-instance`（须最先注册；回调在第二进程上下文触发 → OnceLock 保存的 AppHandle 聚焦主窗口后第二进程退出）。用户实测双任务栏图标的根治（此前 tauri dev 重编译期旧实例未回收 + 无锁）。
  - **插件 v1**（`plugins.rs` + `lib/plugins/pluginRegistry.ts` + 设置新「插件」tab）：插件 = `~/.ReinAgent/plugins/<name>/` + `plugin.json` 清单（name/description/version/**commands**（相对目录，*.md 同工作区命令格式）/**hooks**（event/matcher/command/timeoutMs））；安装=本地目录整拷（`fs_pick_folder` 选目录 → `plugin_install_from_dir`，名字白名单、缺清单拒收、覆盖可选）；卸载=删目录；启用态 kv `reinagent-plugins-enabled`（缺省启用）。
  - **贡献挂接**：① commands → `commands_scan` 加 `extra_dirs` 参数（重构出 `scan_command_dir`），LexicalComposer 扫描时合并启用插件的 commands 目录（斜杠菜单直接出现插件命令，E2E：plugindemo ✓）；② hooks → `runWorkspaceHooks` 合并启用插件条目（**安装=显式用户动作视为已信任**，不走工作区信任横幅；工作区未配置/未信任时插件 hooks 独立照跑）。
  - **⚠️ 坑**：Stop 事件的 input 不带 workspaceRoot → hook cwd 空 → spawn 失败被 fire-and-forget 吞掉（插件 Stop hook 标记文件不出现）——runHookEntries 加 fallbackCwd=工作区根 + App 侧传递。
  - **E2E**：直接 invoke 安装（fs_pick_folder 原生对话框 CDP 不可驱）→ 列表/设置 UI 列出（名称/描述/含斜杠命令徽标）→ 斜杠菜单出现 plugindemo ✓ → 发消息等回合结束 → 插件 Stop hook 标记文件落盘 ✓。市场源（git/npm/github）、agent/skill 贡献后续批次。
- **P2 尾巴批 10：B 批完善尾巴①②③ ✅（2026-09-29）**：
  - **① Hooks 管理界面 ✅**：设置新「Hooks」tab（`HooksSection.tsx`，App 传活动工作区根）——条目增删改（event/matcher/command/timeout/启停）+ 保存（saveWorkspaceHooks 保留 config 其它顶层键）+ **单条试运行**（runSingleHookForTest 按事件注入样例负载，显式用户动作不看信任态；结果显示 blocked/exit/timeout/error）+ 未信任内联提示与批准。HookConfigEntry 加 `enabled?`（false 跳过）。E2E：添加→保存→配置落活动工作区 ✓→测试显示拦截+理由 ✓。
  - **② Hooks 剩余事件 ✅**：PostToolUse（pi-agent-core `afterToolCall` 直通，agentRuntime 透传 + runAgentTurn 组装——additionalContext **append 到结果 content 末尾**，不替换原结果）；PermissionRequest（审批挂起前 hook 裁决：approve 免审/block 拒绝/无裁决正常挂起）；SessionStart（回合启动触发，additionalContext 追加系统提示词尾部，**blocked = 本轮拒绝启动**真实错误上抛）。HooksEventName 拆 RuntimeHookEventName 扩展类型。
  - **③ 自动化运行历史 ✅**：`AutomationRunsHistory.tsx`（每自动化各拉 automation_list_runs 50 条合并倒序 cap100；状态点/trigger 徽标/错误预览/打开会话 onOpenTask→setActiveTaskId 自动切回工作台）；AutomationsPage 头部 History 按钮切换视图。E2E：空态诚实显示 ✓（孤儿 run 不显示——按自动化聚合查询的合理行为）。
- **P2 尾巴批 11：B④ 快捷键系统完整版 ✅（2026-09-29，改绑/失效/冲突/重置 E2E）**：
  - **`lib/shortcuts/shortcuts.ts`**：动作注册表 SHORTCUT_ACTIONS（find/newTask/palette/focusComposer，默认 Ctrl+F/T/K/Shift+A + allowInEditable 语义）+ kv `reinagent-shortcuts` 自定义绑定 + parseShortcut/shortcutFromEvent（必须带修饰键；支持 F1-F12）/matchesShortcut。
  - **G1 handler 重构**：硬编码 if-chain → 遍历注册表按当前绑定匹配（每次按键实时查 kv 缓存，改绑即时生效无需重启）；allowInEditable 语义保留。
  - **设置 UI**：常规 tab `ShortcutsSection`——每行动作 + 绑定按钮 + **录制态**（点击后捕获下一个组合键）+ **冲突检测**（与其它动作绑定重复 → 拒绝并指明占用者）+ 重置默认（回默认 = 删除自定义项）。E2E：改绑查找→Ctrl+J（旧键失效/新键生效）→ 新任务录同款被拒 ✓ → 重置恢复 Ctrl+F ✓。
  - **⚠️ 坑**：i18n 动态 labelKey（shortcutFind 等）必须逐个补键——遗漏渲染原始键名导致 E2E 选择器匹配失败（本轮第 3 次同类坑：**新组件的 t() 键清单在完工时立即核对**）。
- **P2 尾巴批 12：B⑤ 插件 v2 ✅（2026-09-30，git 安装/userConfig/技能贡献 E2E）**：
  - **Git 拉取安装**：`plugin_install_from_git`——本地存在的目录直接按路径克隆（git 原生支持）；github `owner/repo` 短形式自动补 https；clone --depth 1 → 清 .git → 校验清单 → 移入插件根。**初版 URL 校验把本地路径拒了**（只认 http/git/短形式），放宽为「本地存在目录优先」。
  - **清单扩展**：`skills`（相对目录，每子目录一个 SKILL.md）+ `userConfig`（{key: {title/type/default}}）。
  - **技能贡献**：`skills/index.ts loadSkillsDiscovery` 合并——启用插件的 skills 目录 glob `*/SKILL.md` → SKILL.md frontmatter name/description（宽松解析）→ SkillSummary 追加（readSkillText 按绝对路径可读，技能卡/内容展示全兼容）。**装完插件必须 invalidateSkillsDiscoveryCache**（发现缓存不清则 Skills 页看不到，E2E 抓出后已在安装成功路径失效）。
  - **userConfig**：值存 kv `reinagent-plugin-options:<name>`；设置「插件」tab 每插件配置编辑器（声明驱动）；**hook stdin payload.pluginOptions** 注入该插件已存值（runHookEntries 按 entry.pluginName 取）；getPluginOptions 合并 manifest 默认值。
  - **E2E**：git 仓库（commands+skills+userConfig+hook 全贡献）→ 本地路径克隆安装 ✓ → 设置列表徽标（含技能/含斜杠命令/userConfig 编辑器）✓ → 保存 apiToken → kv 实证 ✓ → Skills 页列出 git-plugin-greet ✓。**npm 源未做**（需 npm CLI + tgz 解压，诚实暂缓）；agent 贡献待 P1-6 自定义 profile 批。
- **P2 尾巴批 13：终端配置 ✅（2026-09-30，E2E：shell 切换/字号生效）**：
  - **Rust `terminal_create` 加 `shell: Option<String>`**（用户配置优先，空 = 平台默认 win powershell.exe / unix \$SHELL）。
  - **`lib/terminal/terminalSettings.ts`**：kv `reinagent-terminal-settings`（shell/fontSize 8-28/fontFamily/scrollback 100-100000，clamp 消毒）。
  - **设置「终端配置」tab 落地**（原 coming soon）：shell 预设下拉（PowerShell/CMD/Git Bash 路径/自定义）+ 字号/回滚缓冲数字 + 字体族 + 保存；`TerminalSettingsSection.tsx`。
  - **TerminalPane 消费**：xterm options（fontSize/fontFamily/scrollback）+ createTerminalSession 传 shell；**effect 依赖加 settings 字段**（改配置重开面板即生效——重建实例+PTY）。
  - **E2E**：设置 shell=CMD + 字号 18 → 保存 → 开终端面板 → cmd.exe 被拉起 + 字号非默认 ✓。测试配置已重置默认。
- **P2 尾巴批 14：终端 Shell 自动检测 + 精简 ✅（2026-09-30，用户多轮反馈收敛）**：
  - **用户要求**：终端配置只保留 Shell（字号/回滚/字体族 UI 与代码全删，xterm 恢复 13px 默认）；迁入「基础配置」tab；**去掉「平台默认」抽象选项**——必须有确定选中值，默认即选中平台默认的实际指向。
  - **实现**：`TerminalShellSetting.tsx` 重写——预设候选（pwsh MSI/商店双路径、powershell 系统路径、cmd、gitbash 双路径）挂载时经 **fs_path_exists 逐路径探测**，不存在的预设不进下拉；未配置 → **自动选中首个可用**（本机=PowerShell 7）；列表尾加「自定义路径」兜底入口（选中显示路径输入）。新增 Rust `fs_path_exists`。TerminalSettings 精简为 {shell}。
  - **E2E**：下拉自动列出 PowerShell 7/5.1/CMD/Git Bash（本机实测探出商店版 pwsh）+ 默认选中 PowerShell 7 ✓；选 CMD 保存 → kv 持久化 ✓。
  - **⚠️ 坑**：`?? {}` 拓宽类型致索引报错（显式 as Record）；settings 目录下 storage/db 相对路径是 ../../lib/storage/db；bun -e 删行会砍断多行值（用逐行 filter 后要查孤儿续行）。
- **P2 尾巴批 15：终端 Shell 标签 OS 检测 + Linux shell 候选 + cwd 工作区 ✅（2026-09-30）**：
  - **OS 检测**：Rust `system_info.rs system_info`——os（windows/linux/macos）+ 展示版本（Windows 解析 `cmd /c ver` 第三段 build 号 ≥22000 = Win 11；Linux 读 /etc/os-release PRETTY_NAME；macOS sw_vers）+ arch（x86_64→amd64、aarch64→arm64）+ 登录默认 shell（\$SHELL，unix）。前端模块级缓存，Shell 行标签渲染「Shell(Win 11 amd64)」式徽章。⚠️ 坑：ver 输出的版本 4 段（10.0.26100.9444），build = 第三段而非最后一段（最后是 patch 9444，首版解析误判 Win 10）。
  - **Linux shell 候选**：UNIX_SHELL_CANDIDATES（bash/zsh/fish/sh，含 ~/.local/bin 与 /usr/bin、/bin 双位置）；**登录默认 \$SHELL 对应候选排最前**；Windows/Unix 两套候选按 system_info.os 选择。
  - **终端 cwd = 当前任务工作区**：TerminalPane 加 workspaceRoot prop（App 传 effectiveWorkspaceRoot）→ createTerminalSession cwd → Rust CommandBuilder::cwd（原实现从未传 cwd，终端固定开在应用启动目录）。
- **P2 尾巴批 16：Environment 段带真实系统信息与所选 Shell ✅（2026-09-30）**：`buildEnvironmentSection` 扩参（osBadge/terminalShell）——runAgentTurn 发送时 await `getOsInfo()`（共享模块 lib/system/systemInfo.ts，TerminalShellSetting 同源）+ `getTerminalSettings()`；注入 `- System: Win 11 amd64` 与 `- Terminal shell: <路径> — <跟随 shell 的语法提示>`（pwsh/powershell → PowerShell 语法、bash → Unix、cmd → cmd 语法；**原硬编码「cmd 语法、无 grep/head/wc」在用户切 PowerShell 后就是错误指令**，已除）。OS 信息实现收编共享模块 lib/system/systemInfo.ts（TerminalShellSetting 删本地副本）。PROMPTS.md Environment 文档同步。
- **P2 尾巴批 17：Shell 检测零写死 ✅（2026-09-30，用户反馈「不要写死」）**：撤掉 TerminalShellSetting 里的硬编码候选路径表（C:\ 假设 + 用户名错误路径），改为 **Rust `shell_detect` 命令经系统 `where`/`which` 从 PATH 实时解析**（win: pwsh/powershell/cmd/bash.exe；unix: bash/zsh/fish/sh），检出什么列什么（本机实测探出 bash=Git PATH 版/CMD/Windows PowerShell/pwsh 四个 + 自定义路径兜底）；unix 登录默认 $SHELL 候选排最前。标签按简名映射（pwsh=PowerShell 7、powershell=Windows PowerShell）。**教训：探测类功能一律 PATH/运行时解析，不写盘路径清单**。
  - **去重**：用户实测指出工作区路径出现两次——「Current workspace root」声明（语义：相对路径解析基准）与 Environment 的 Working directory 行。**Environment 段删除 Working directory 行**（root 声明保留），buildEnvironmentSection 签名去 workspaceRoot。
- **P2 尾巴批 18：Hooks 页面对齐 LiveAgent ✅（2026-10-01，样式功能 1:1 + 8 生命周期事件）**：
  - **用户定稿**：页面样式功能与 LiveAgent 完全一致（**无信任横幅、无单条测试按钮**——运行时信任门禁与聊天区横幅保留不动）；旧 ZCode 事件**在 UI 可见**（「兼容事件」分组）。
  - **UI 重写**：`HooksSection.tsx`（左 13rem 事件导航「生命周期」8 事件 + 「兼容事件」6 事件、每事件数量角标、右事件描述 + 新增按钮 + 空态卡 + Hook 卡片[名称点击编辑/类型·描述副行/AgentActivationSwitch/删除 ConfirmActionPopover]，操作即保存无总保存键）+ `HookModal.tsx`（名称/描述/类型 command|http/command=多行脚本+行数徽标+超时秒默认60、http=请求列表编辑器[7 方法下拉+URL+Headers/Body JSON，GET 类禁 body]，底部内联错误）+ `hooksHttpRequestEditor.tsx`（LA 移植适配）。**唯一加项**：PreToolUse 弹窗多一个 matcher 输入（ZCode 契约需要）。全部用 lw 组件（Dialog/Select/Switch/ConfirmActionPopover/SettingsNotice/FormField[mcp/FormField]）+ bg-settings-tile 主题 token。i18n hooks* 全套键（中英），旧 UI 键（hooksTest*/hooksSave 等）已清。
  - **数据模型**：HookConfigEntry 扩展 `{id?, name?, description?, type?: command|http, requests?: [{id,url,method,headers?,body?}]}`（command 脚本沿用旧字段 `command` 零迁移）；parseHooksConfig 三代形态兼容 + 修复 enabled 丢失 bug；无 name 旧条目展示 = 脚本首行/首请求 URL 派生。
  - **Rust `hooks.rs hook_http_execute`**：ureq `Agent::run(http::Request)`（7 方法全覆盖含 DELETE body）+ kv 全局代理（同 MCP）+ 超时默认 60s 上限 600s → {status, ok, bodySnippet(2KB), timedOut, error}；URL/header 硬错误如实回传。
  - **8 生命周期事件接线**：pi-agent-core 原生事件名与 hook 事件同名——runAgentTurn **包装 onEvent** 一处埋点（agent_start/turn_start/message_start/message_end/tool_execution_start/tool_execution_end/turn_end/agent_end），fire-and-forget 不阻塞主流程、block 协议不生效（观察性）；负载裁剪（工具事件全量 args、消息事件 stopReason+2KB 文本预览）。⚠️ agent_end 只由循环事件触发，App 终态监听不重发（防双触发）。执行超时缺省统一 60s（DEFAULT_HOOK_TIMEOUT_MS，原 30s）。
  - **E2E（CDP）**：页面 1:1 渲染 ✓ → PreToolUse 新增弹窗（含 matcher）✓ → 切 http 类型（请求编辑器/禁 body 提示）✓ → 保存落 `C:/Users/bytes/.ReinAgent/DefaultProject/.ReinAgent/config.json` 新格式 JSON ✓（⚠️ 工作区根 = 活动任务工作区，非 selectedProject）→ 删除确认气泡 ✓ → 350 测试全绿 + tsc 0 + cargo check 绿。
- **P2 尾巴批 19：设置「子智能体」页（对齐 PI-Desktop）✅（2026-10-01，用户定稿：抄 PI 后修复）**：
  - **tab 改名**：「智能体能力」→「子智能体」（settingsAgent 键），占位页替换为 `AgentSubagentsPage`。
  - **定义层 `lib/subagents/subagentDefinitions.ts`**：用户定义 = `~/.agents/subagents/<id>.md`（frontmatter name/description/tools/model/thinkingLevel/maxTokens + 正文=系统提示词，≤32KB、≤64 个，**启用态绝不写文档**——kv `reinagent-subagent-builtins-disabled`[handle 数组] 与 `reinagent-subagent-enabled`[Record<id,bool>]）；宽松 frontmatter 解析（max-tokens→maxTokens、inherit 剥离、坏文档如实 diagnostics）；renderSubagentDocument 序列化；**内置 5 定义**（explorer/code-reviewer/test-runner/fixer/ui-designer）指令正文照搬 PI，工具名映射本仓注册表（Read→read_file、Bash→exec_command、Edit/Write→edit_file/write_file），ui-designer 无 BrowserPreview 如实去除（正文验证段同步改写为 exec_command 承接）；CRUD 走 fs_list_dir/fs_read_file/fs_write_file/fs_delete_file；loadSubagentCatalog 合并（用户同名遮蔽内置、停用内置剔除）；resolveSubagentModelPin("provider/model")→buildModel（loadProvidersConfigFromDisk + API_FORMAT_TO_TYPE[modelResolution 导出共用]，供应商缺失→null、Key 空→抛错）。
  - **运行时 `subagentRunner.ts` 定义驱动**：`createSubagentTool` 改**异步工厂**（加载目录渲染工具描述 `- name (tools): desc`，runAgentTurn 两处 await）；schema 保留 subagent_type 参数、句柄查目录（normalizeSubagentHandle 兼容 Explore→explorer、general-purpose→fixer，未知句柄如实报错并列目录）；执行按定义取工具白名单（空→默认 read_file/glob/grep）、模型钉选（解析失败/未配置如实 isError，不静默回落）、thinking 钉选；**审批门按可改动性挂载**（PI 语义：Bash/Edit/Write=mutating——explorer 带 exec_command 也挂父门，code-reviewer 纯只读不挂）；composeSubagentSystemPrompt=框架行（身份/改动声明/报告即最终消息）+定义正文+工作区根。maxSteps=6 不变；转录持久化/回放/subagent_output 不变。
  - **UI**：`AgentCapabilityLayout.tsx`（PI 同名原语子集，PI settings.css 类→本仓 token Tailwind：行=bg-settings-tile 圆角卡[图标/名称+徽标/Task(handle) mono/说明两行钳制/工具 chips/操作区]，两击删除 3.2s 自动解除）+ `SubagentEditorSheet.tsx`（lw Sheet 右滑 inset：模板 chips/名称[首命名种子模板+slug 提示]/说明/工具九宫格勾选[mutating 琥珀标记]/指令正文[字节计数 0.8/1.0 变色]/高级[ModelPicker 复用 value=provider/model、thinking 下拉、启用]；**v1 如实取舍：无 fallbackModels/maxTokens/inheritTools**——运行时未实现不做假开关）+ `AgentSubagentsPage.tsx`（搜索/新建/内置组+全局级组[~/.agents/subagents 路径 chip]/开关即时落 kv/编辑/复制为我的定义/reveal[opener]/两击删除）。i18n subagent* 全套 46 键（中英）。
  - **顺手修**：`storage/db.ts` kvSet/syncTasks 的 `window.setTimeout` 裸用 → scheduleDebounce 环境无关（Node 测试可调 kv）。
  - **测试**：subagentRunner.test.mjs 重写（7 条：过滤/聚合/端到端旧值兼容/未知句柄/审批门挂载/目录渲染/后台+通知）+ subagentDefinitions.test.mjs 新增（5 条：解析/round-trip/内置映射/slug/目录合成）。⚠️ 坑：faux 工具调用参数必须过 schema（glob 要 pattern）——**参数校验在审批门之前**，校验失败门不触发（探针二分才定位）。
- **批 19 补：模型用量按真实模型记账 + 一键清零 ✅（2026-10-01，用户发现「Explore 0.4% 1746 tokens」追溯）**：
  - **根因**：用量回填第二源（agent 工具 tool_result）按 `details.subagentType` 记账——旧硬编码时代类型名即模型标签；子智能体定义驱动后不再成立。
  - **改法**：`summarizeSubagentRun` 从嵌套轮 assistant 原件提取真实 provider/model 戳（钉选模型与会话模型都如实反映）→ agent 工具 details 带 provider/model → Rust 回填子代理行按 `details.provider/model` 记账（缺省兜底 subagent/unknown，subagentType 字段废弃）。
  - **一键清零**：新 Rust 命令 `usage_reset`——DELETE model_usage + kv 写水位线 `usage-reset-watermark-ms`；回填两源查询加 `COALESCE(started_at,0) > 水位线`（**清零后历史 part 不重灌**——INSERT OR IGNORE 只防重复行不防重导，水位线才是防重灌闸门）。用量面板右下加「清零」按钮（两击确认）。
  - **顺手修**：commands.rs 三个测试还在调旧签名 `commands_scan(1 参)`（插件 v1 加 extra_dirs 时漏更）——补 None 第二参。
  - **E2E**：重置按钮两击 → 面板全零（累计 0/峰值 0/热力图灰/两图空态）→ 重开面板触发回填仍为零 ✓。usage_stats Rust 测试 4/4（新增水位线防重灌用例）。
  - **清零补全（用户反馈：最长聊天时长没清掉）**：`longest_session_ms`/`tool_call_count`/`tool_error_count` 是从 **message 表实时算的**（不走 model_usage），清零删表管不到——水位线统一应用到这三个查询（`started_at > 水位线`），清零后旧会话时长/旧工具调用一律不计。usage_stats 测试扩断言（清零后 longest=0/tool=0，新事实入账）。工具调用参数坑备忘：faux 工具调用参数必须过 schema（glob 要 pattern），参数校验在审批门**之前**。
- **批 19 补 2：右侧面板新增「文件管理器」与「内嵌浏览器」✅（2026-10-01，不进插件页，纯面板功能）**：
  - **文件管理器**：FilesPanel 增管理操作——根级工具条（新建文件/文件夹、刷新、资源管理器显示）+ 行 hover 操作（目录内新建/重命名/删除/显示，删除走 ConfirmActionPopover，重命名/新建为行内输入 Enter/Esc）。Rust 新命令：`fs_rename`（重命名/移动，目标存在拒绝、符号链接拒绝）、`fs_remove_entry`（文件或目录递归删除，拒符号链接与工作区根）、`fs_create_dir`（父目录存在校验）。
  - **内嵌浏览器（路线 B）**：⚠️ 原生 webview2-com 自建 Controller 双方案均 0x8007139F（ERROR_INVALID_STATE：环境创建成功但 Controller 回调拒绝，Parent 主 HWND 与专属 child HWND、新旧 API 全组合）——**最终改用 Tauri `unstable` 特性的多 webview**：`Window::add_child(WebviewBuilder, pos, size)` 一行创建子 WebView（tauri 处理全部 COM），Cargo tauri features 加 `unstable`。命令面：browser_open（已存在则导航复用，"already exists" 竞态恢复为导航）、browser_set_bounds（`tauri_runtime::dpi::Rect`，Rect 未从 tauri 根导出需加 tauri-runtime 依赖）、browser_navigate、browser_eval（eval 单向）、browser_read_page（**读通道**：一次性 TcpListener + eval 注入 fetch POST 上报，HTTPS 页面 fetch localhost 非混合内容）、browser_current_url、browser_close、browser_is_open。⚠️ 坑：**多 webview 下 `get_webview_window("main")` 返回 None**，必须 `get_window("main")` + `get_webview(label)`；CDP Page.captureScreenshot 拍不到原生子 WebView（OS 层叠加），验证必须 GDI CopyFromScreen；StrictMode 双挂载触发 add_child "already exists" 竞态。
  - **Browser 工具对**（tools.js，审批分级对齐用户拍板）：`browser_view`=read（navigate/snapshot——snapshot 经 browser_read_page 抓 url/title/innerText 6KB）；`browser_act`=write（click=elementFromPoint 合成鼠标事件、fill=选择器填值+input/change 事件、evaluate=eval）；都要求面板已开（未开如实 isError 提示先开面板）。
  - **测试**：tools.test.mjs 期望表补 browser_view/act；355 全绿 + tsc 0 + cargo 绿；GDI 截图实证内嵌 bing 原生渲染。
  - **浏览器工具增强 ✅（2026-10-01 用户要求立即增强）**：
    - **browser_act click 支持选择器**：selector 模式（推荐）= scrollIntoView 居中 + getBoundingClientRect 中心 + 完整鼠标事件序列（pointerdown→click），坐标模式保留为后备。
    - **browser_view 新增 elements 动作**：列举视口内可交互元素（a/button/input/select/textarea/role）前 40 个，生成唯一 CSS 选择器（id 优先 → 3 级 nth-of-type 路径，CSS.escape）——模型用返回的选择器驱动 browser_act。
    - **browser_view 新增 screenshot 动作（多模态）**：Rust `browser_screenshot` 经 `Webview::with_webview` 拿 PlatformWebview.controller()（windows 直接返回带类型接口，无需 from_abi）→ CDP `Page.captureScreenshot`（jpeg q60）→ base64 → 工具返回 **image content block**（pi-ai ToolResultMessage 原生支持 Text|Image content）。⚠️ 需要**视觉模型**才有效（非视觉模型 + 图片块网关断连，见 error-raw-display 条目）。
    - **⚠️ 关键坑**：tauri unstable 多 webview 下 `get_webview_window("main")` 返回 None（add_child 的子 webview 不注册为 WebviewWindow 实体）——所有 browser 命令统一 `get_window("main")` + `get_webview(label)`；webview2-com completed handler 闭包必须返回 `Result<(), windows_core::Error>`（末尾 Ok(())）。
    - **验证**：子 WebView 自带 CDP target（同调试端口）——Page.captureScreenshot 72KB jpeg ✓、elements 脚本实抓 bing 40 元素带唯一选择器 ✓；355 测试 + tsc 0 + cargo 绿。
  - **助手页（主对话人设预设）✅（2026-10-01 用户定稿：与子智能体互补——子智能体=委派工，助手=主对话人设）**：
    - **数据层 `lib/assistants/assistantDefs.ts`**：`~/.ReinAgent/assistants/<id>.md`（frontmatter name/description/model?/thinkingLevel? + 正文=人设指令，32KB/32 个上限）；内置 4 预设（general=无人设缺省、coder 代码专家、writer 文档写手、translator 翻译官）不可删；用户自定义同名遮蔽内置；任务绑定存 kv `reinagent-task-assistant`。
    - **运行时**：runAgentTurn 收 `assistantId` → loadAssistantCatalog 查 def → 人设段（`# Assistant Persona: name` + 描述 + 正文）**插入默认 system prompt 前部**（工具/安全段保留，非替换）；general/查无跳过。⚠️ buildTurnOptions 的 deps 必须加 `activeTask?.assistantId`——toolPolicies 等引用在纯 assistantId 更新时不变，闭包 stale 导致人设不注入（首测踩中）。
    - **切换链路**：助手页「应用」与工作台顶栏 AssistantChip（任务标题旁）都走 updateTaskAssistant（记录 assistantId + 采用模型钉选）；任务持久化 JSON.stringify(t) 自动带 assistantId。
    - **E2E**：真模型验证——切「代码专家」后让模型复述系统提示词，回复精确引用了助手人设描述 ✓；355+4 测试全绿。
  - **⚠️ 下拉框不自动关闭真因：lw Select 半受控缺陷 ✅（2026-10-01）**：
    - **症状**：助手编辑器内所有下拉框（思考等级 Select / ModelPicker DropdownMenu）点选后弹层不关、ESC 无效、点外部也不关。用户多次反馈。
    - **真因**：lw select.tsx Root 把 `open` prop（调用方未传 = undefined）直接透传 PopoverPrimitive.Root → **非受控模式，开/关由 Radix 内部状态管理**；选项点击的 `root.setOpen(false)` 只更新包装层 `internalOpen`，永远碰不到 Radix 内部状态 → 弹层关不上。外点关闭走 Radix 原生 dismiss 路径不受影响（混合表现：外点能关、选中不关）。
    - **修复（一行）**：Root 改半受控 `open={open ?? internalOpen}`——未受控时用包装层状态驱动 Radix。全局 lw Select 全部修复（记忆抽屉/MCP/自动化/子智能体/助手编辑器）。
    - **验证**：OS 级真实鼠标（mouse_event）——Select 打开 7 options ✓、点外部关闭 ✓、点选 high 后 triggerText=high + 弹层关 ✓。**⚠️ E2E 坑**：CDP 合成 `.click()` 驱不动 Radix 触发器（需真实 OS mouse_event）；GDI 截屏会被前景的 ZCode 窗口遮挡（SetForegroundWindow 置前再截）。
  - **⚠️ 启动闪屏变点击盾真因（引发「应用按钮点不动/下拉框关不上」报告）**：startup-ready 类在 **rAF** 里添加——窗口被遮挡时 Chromium 节流 rAF（无绘制帧），类永不添加 → `#loading`（z 999999 全屏 PE:auto）变成透明点击盾吃掉一切点击。**修复**：rAF 保留 + setTimeout 300ms 兜底（定时器不受绘制节流）。当前实例已即时解卡（CDP 加类）。⚠️ 教训：CDP Page.reload 在窗口被遮挡时重启页面会稳定复现此状态——自动化验证前先检查 startup-ready。
  - **⚠️ 弹层关不掉·终局真因：@utility 内嵌 @keyframes 不提升 → Radix Presence 挂死 ✅（2026-10-02，推翻上条「外点能关」结论）**：
    - **症状（全量）**：所有 Radix 弹层（lw Select popover、ModelPicker DropdownMenu、Dialog）**选中不关、ESC 不关、点外部也不关**——三条关闭路径全灭。上一条「外点能关、选中不关」的归因不完整：semi-controlled 修复是必要非充分。
    - **真因（证据链）**：`global.css` 里 `@keyframes tw-enter/tw-exit` 嵌套在 `@utility animate-in/out` **内部**——Tailwind v4 不会把 @utility 内嵌的 @keyframes 提升进产物 → 产物里 `animation: tw-exit 150ms` 引用了不存在的 keyframes → **动画永不运行 → animationend 永不触发 → Radix Presence 等 animationend 卸载节点 = 永远挂着**。运行时证据：选中后 `aria-expanded=false`、`data-state="closed"`（Radix 状态已正确翻转！），但节点 `getAnimations()` 为空、computed animationName=tw-exit、keyframesProbe 全 stylesheet 搜不到 → 节点 opacity 1 + pointer-events auto 视觉常驻。且挂死的弹层作为顶层 DismissableLayer 还会**吞掉 Dialog 的 ESC**（第二层永远关不掉第一层收不到）。
    - **修复**：`@keyframes tw-enter/tw-exit` 提升到 global.css 顶层（`@utility animate-in/out` 只留 animation 简写）。一处修复全局愈合（Select/DropdownMenu/Dialog/Toast 全部）。
    - **验证（CDP 真实鼠标）**：选中 low → 弹层关 + trigger=low ✓；ESC → 只关弹层 Dialog 保留 ✓；外点 → 只关弹层 ✓；ModelPicker 搜索过滤选中 → 关 + trigger 更新 ✓。
    - **⚠️ 教训**：① Radix「关不掉」类问题先查 `data-state` 是否翻转：翻转了=渲染/动画层挂死（查 getAnimations + keyframes 是否真进产物），没翻转=状态接线断；② **Vite dev server 文件监听会死**——磁盘改完 Page.reload 拿到的仍是旧 transform（模块图缓存不失效），今天为此绕了远路（先误判 bundle 陈旧重启了整个 tauri dev 栈），诊断 bundle 新旧必须看**内容特征**（grep transform 产物）而非 mtime。
  - **助手作用域语义定稿 ✅（2026-10-02 用户拍板）：全局默认 vs 任务绑定**：
    - **语义**：无活动任务时「应用」/chip 选择 = **设为全局默认助手**（对后续未单独设置的新任务生效）；任务内选择 = **任务作用域**（持久化在任务记录，该任务以后默认用它）。解析顺序：`task.assistantId ?? globalDefault`。
    - **响应式收口**：kv `reinagent-assistant-default` 读写统一收进 useAppStore——新字段 `globalDefaultAssistantId`（初值 hydrate 自 kv）+ `setGlobalDefaultAssistant` action（kv 写 + set 同步）；assistantDefs.ts 只导出 `KV_ASSISTANT_DEFAULT` 键名（get/setGlobalDefaultAssistantId 已删）。此前 kv 直写不触发渲染导致 chip 徽标滞后的缺口由此闭合。旧键 `reinagent-draft-assistant`（草稿补绑方案）废弃。
    - **顶栏 chip 常显**：原先 `{activeTask ? <AssistantChip/> : null}` ——草稿态整个不渲染（「chip 不显示翻译官」首因）；改常显，草稿态显示全局默认。
    - **AssistantChip 目录加载时机**：catalog 原先仅在弹层 open 时加载 → 未打开过时 `defs.find(assistantId)` 恒空、label 永远回退「通用助手」；改挂载即加载（loadAssistantCatalog 自带 5s 缓存）。
    - **E2E（重启后的干净栈）**：草稿态应用代码专家 → store= coder + chip 即时「代码专家」✓；恢复 general → chip「通用助手」✓；kv 重启水合 ✓。tsc 0；测试 199 绿（providers 3 败为**存量**问题：node 24 不解析 subagentRunner.ts 的 `.js` 尾缀 specifier → subagentRegistry，stash 验证干净 HEAD 同样 3 败，与本次无关）。
  - **⚠️ 作用域显示脱节修复（2026-10-02 用户报告「任务内切助手，全局也跟着切」）**：
    - **取证**：store/kv/UI 全旅程 CDP 实测（任务内 chip 切换 → task.assistantId 变、globalDefaultAssistantId 与 kv 纹丝不动）——**状态层从不泄漏**。真缺陷是**显示回退错误**：chip 与助手页对「未绑定助手的任务」硬编码回退 `GENERAL_ASSISTANT_ID`，而运行时 buildTurnOptions 对未绑定任务注入的是**全局默认助手**的人设 → 设过全局默认后，新任务 chip 显示「通用助手」实际却跑全局默认人设，显示与行为脱节。
    - **修复**：chip 与助手页「当前生效助手」统一为 `activeTask?.assistantId ?? globalDefaultAssistantId`（与运行时解析严格一致，App.tsx 的 GENERAL_ASSISTANT_ID import 随之删除）。
    - **作用域标识（助手页）**：任务模式徽标改「任务使用中」（brand 高亮）；全局默认行恒显灰底「全局默认」徽标（Globe 图标）；草稿态按钮语义化——非默认行「设为全局默认」、默认行禁用显示「全局默认」、任务模式照旧「应用」。i18n：assistantApplyGlobal / assistantActiveTaskBadge / assistantGlobalBadge（assistantActiveBadge 废除）。
    - **E2E 五点全过**：未绑定任务 chip=全局默认 ✓；任务内切翻译官 → chip=翻译官 + global=coder 不动 ✓；任务页「任务使用中」徽标 ✓；回草稿 chip=代码专家（全局未被影响）✓；草稿页「全局默认/设为全局默认」按钮语义 ✓。tsc 0 + 199 测试绿。
  - **作用域入口收敛定稿（2026-10-02 用户拍板）：助手页只管全局默认**：
    - **规则**：助手页（含任务激活时）只能设置全局默认（applyGlobal → setGlobalDefaultAssistant，不再采用模型钉选）；任务作用域唯一入口 = 聊天页任务名旁 AssistantChip 下拉（updateTaskAssistant，任务记录持久化=记忆）。
    - **UI**：助手页删除「应用/任务使用中」按钮与徽标——所有行统一「设为全局默认」，当前默认行禁用显示「全局默认」+ Globe 徽标；工具条下加常驻提示行（assistantPageHint：全局默认作用域说明 + 指引去聊天页切任务助手）。i18n 删 assistantApply / assistantActiveTaskBadge。
    - **草稿态 chip 语义不变**：无任务时下拉选择 = 设全局默认（用户原始规格「下一个任务默认的助手」）。
    - **E2E**：任务内（绑定翻译官）页面点代码专家「设为全局默认」→ global=coder、task.assistantId=translator 不动 ✓；chip 仍翻译官 ✓；草稿 chip=代码专家 ✓；页面行语义（全局默认禁用/设为全局默认）✓；提示行可见 ✓。tsc 0 + 199 测试绿。
  - **⚠️ 任务内选不了「通用助手」修复（2026-10-02 用户报告：选完自动变回代码专家）**：
    - **根因**：`updateTaskAssistant` 把 `assistantId === "general"` 转成 `undefined`（当作清除绑定）→ chip 显示走 `activeTask?.assistantId ?? globalDefaultAssistantId` 回退到全局默认（恰为代码专家）→ 显式选择「通用助手」被吞、界面弹回全局默认。**「通用助手（无人设）」与「未绑定（跟随全局默认）」是两个语义，被混为一谈**。
    - **修复**：显式选择一律按任务记忆——`assistantId` 原样存储（含 "general"）；仅「从未选择过」（undefined，旧任务/新任务）回退全局默认。运行时无需改（runAgentTurn:460 `assistantId !== "general"` 本就跳过人设注入）。
    - **E2E**：全局=代码专家时未绑定任务 chip=代码专家 → chip 选通用助手 → chip 保持「通用助手」+ task.assistantId="general" 持久化 + 全局不动 + 切走切回仍通用 ✓。199 测试绿。
