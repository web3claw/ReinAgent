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
- **折叠体内容**：思考块（ThinkingBlock）+ 工具调用卡（ToolCallCard）+ 中间叙述文本（非末条 assistant 的正文，暗色渲染）；**最终回复正文（轮内最后一条 assistant）始终外显**；
- **思考块（ThinkingBlock）**：header「思考 · 持续了 N 秒」（整秒向上取整；无打点如实显示「持续了几秒」）+ 流式「正在思考」；默认收起；正文最暗文字层（`--text-dim` + 透明度）+ 左导线缩进 + 限高 240px 滚动 + `whitespace-pre-wrap` 纯文本；
- **「查阅」聚合卡（对齐 ZCode ExploreToolCallBlock）**：轮内**连续**的查阅族工具（`list_dir` 列表 / `read_file` 文件读取，`EXPLORE_TOOL_NAMES`）聚合为一张卡——header = 搜索图标 + 「查阅」+ 分类计数徽标（`N 列表 · N 文件`，仅非零项）+ 状态词 + 折叠箭头；**列表调用不渲染文件数组输出**，展开体只保留单行摘要（列表 → 目录路径；读文件 → 文件名 chip + 目录暗色路径），信息取舍与 ZCode 一致；`buildActivityItems` 把轮内活动切分为普通条目与连续查阅组；
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
- **有指定项目**：若当前任务选中了项目（或会话绑定了 Project），则工作区根目录 `workspaceRoot` 为该项目所指定的文件夹路径。
- **无指定项目（默认回退）**：若任务未指定项目（或点击“不在项目中工作”），工作区根目录自动回退到用户主目录下的：
  👉 `~/.ReinAgent/DefaultProject`（如 Windows 下 `C:\Users\<user>\.ReinAgent\DefaultProject`）。
  - 若该目录不存在，首次文件写入或命令执行时由系统自动创建（`mkdir -p`）。
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
| 6 | 「查阅」聚合卡 | 轮内连续 list_dir/read_file 聚合；header 分类计数徽标（N 列表 · N 文件）；**列表不渲染数组输出**，展开仅单行摘要 | `TurnGroupView.tsx` |
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


