# ReinAgent 功能路线图（vs LiveAgent / ZCode 差距分析）

> **文档定位**：本轮（2026-09-28）对 LiveAgent / ZCode 两个参考实现做全量功能面穷举后，与 ReinAgent 现状逐项比对得出的差距清单与优先级路线图。
> **参考源码**（严禁反编译，直接查源码）：LiveAgent `E:\DevCode\ReinAgent\LiveAgent`、ZCode `E:\DevCode\ReinAgent\ZCode`。
> **路径**：`docs/ROADMAP.md`。配套任务清单见 **[TASKS.md](./TASKS.md)**（P0 起的分步开发计划：批次 A~E、13 个任务，每步带验收命令与进度表）。
> **维护纪律**：完成任一条目后，在此表标记 ✅ 并同步 `PROJECT_CONTEXT.md` 对应章节与 `docs/TASKS.md` 任务清单状态。

## 〇、总览

聊天核心链路（会话池 / 流式渲染 / 编辑重发 / 重试 / 分支 / checkpoint 回退 / 审批四档 / 任务级隔离）已与两家对齐；Skills / MCP / Memory 三 Hub 已全量移植。**最大差距集中在三块**：

1. **工具系统**：我们仅 5 个工具（read/write/edit/list_dir/exec），两家 25~30 个（搜索/后台任务/待办/子代理/联网/问答…）；
2. **上下文工程**：无历史压缩（长会话会撑爆窗口）、无 microcompact、@提及与斜杠命令只有空壳、无 AGENTS.md/gitStatus 注入；
3. **子代理 / Git 面板群 / 桌面集成**（托盘、通知、快捷键、更新器）整体缺失。

---

## 一、工具系统（差距最大）

| 功能 | LiveAgent | ZCode | ReinAgent | 参考定位（LA / ZCode） |
|---|---|---|---|---|
| read / write / edit / list_dir | ✅ | ✅ | ✅ | — |
| **Glob / Grep（模式与内容搜索）** | ✅ | ✅ | ✅ 2026-09-28 | LA `lib/tools/fsTools.ts`；ZCode `tool/handlers/glob.ts`、`grep.ts` |
| **Todo 清单工具 + 进度 UI** | ✅ Task* | ✅ | ✅ 2026-09-28 | LA `lib/tools/taskTools.ts` + TaskProgressBar；ZCode `handlers/todo.ts` |
| **后台 Bash（驻留进程 / TaskOutput / TaskStop / 输出侧栏）** | ✅ ManagedProcess | ✅ | ❌（exec 为同步 120s 阻塞） | LA `lib/tools/processTools.ts`；ZCode `handlers/bash-background-*.ts`、`ui/app-shell/BackgroundBashOutputSidePane.tsx` |
| **WebFetch / WebSearch** | ✅ hosted search | ✅ | ❌（零联网） | LA `lib/tools/nativeWebSearch.ts`；ZCode `handlers/webfetch*.ts`、`websearch*.ts` |
| Node REPL 沙箱 | — | ✅ | ❌ | ZCode `handlers/node-repl.ts`、`core/repl/` |
| 图片 / PDF / 视频读取 | ✅ Image | ✅ | ❌（read_file 仅文本） | ZCode `handlers/read-image.ts`、`read-pdf.ts`、`read-video.ts` |
| 文件删除 Delete | ✅ | — | ✅ 2026-09-28 | LA `fsTools.ts` |
| Skill 工具（按需加载技能全文） | ✅ | ✅ | ❌（现靠 read_file 读 skill://） | LA `lib/tools/skillTools.ts`；ZCode `handlers/skill.ts` |
| **子代理系统**（Agent/SendMessage/Explore/自定义 profile/持久记忆/运行目录侧栏） | ✅ | ✅ | ❌ | LA `lib/subagents/`、`workspace/subagent_worktree.rs`；ZCode `core/subagent/`、`ui/app-shell/SubagentDirectorySidePane.tsx` |
| **AskUserQuestion / Clarify 追问卡** | ✅ | ✅ | ❌（模型无法向用户提问） | LA `components/chat/AskUserQuestionCard.tsx`、`clarifyRunner.ts`；ZCode `handlers/ask-user-question.ts`、`V4UserInputDialog.tsx` |
| **ExitPlanMode / 计划侧栏 / escalate** | ✅ ExitPlanMode | ✅ | ❌（计划模式仅提示词约束） | LA `planModeTools.ts`；ZCode `handlers/plan-mode.ts`、`escalate.ts`、`app-shell/PlanDetailSidePane.tsx` |
| Cron 管理工具（模型自主管理定时任务） | ✅ | ✅ | ❌（自动化仅 UI 入口） | LA `cronTools.ts`；ZCode `handlers/cron.ts` |
| ReadConversation / ReadSessionContext（读历史会话） | ✅ | ✅ | ❌ | LA `conversationTools.ts`；ZCode `handlers/read-session-context.ts` |
| ToolSearch（工具目录检索） | ✅ | — | ❌ | LA `toolSearchTools.ts` |
| 动态工作流（创建/修订/评估/运行可视化/保存） | — | ✅ | ❌ | ZCode `core/workflow/`、`ui/app-shell/WorkflowRunSidePane*` |
| 浏览器驱动 / Computer Use | ✅ Browser | ✅ CUA | ❌ | LA `browserTools.ts`、`services/browser/`；ZCode `packages/zcode-cua/` |

---

## 二、上下文工程

| 功能 | LiveAgent | ZCode | ReinAgent | 参考定位 |
|---|---|---|---|---|
| **历史压缩 compact**（阈值/策略/摘要模型/手动触发/压缩带 UI） | ✅ 双层检查点 | ✅ | ✅ 2026-09-28（批次 D） | LA `lib/chat/compaction/`（policy/engine/summarizer/tokenLedger）+ `CompactionBand.tsx`；ZCode `core/compact/`（policy/manual/prompt） |
| **microcompact（工具结果裁剪）** | — | ✅ | ✅ 2026-09-28（批次 D） | ZCode `runtime/methods/microcompact.ts` |
| system-reminder 包装 / meta_user 通道 | ✅ | ✅ | ✅（2026-09-28 已对齐） | 本项目 `runAgentTurn.ts buildMetaUserBlock`，见 PROMPTS.md 2.1 |
| **@提及系统**（文件提及 + 注入） | ✅ | ✅ | ✅ 2026-09-28（文件提及；技能/agent 提及待技能工具后） | LA `MentionComposer*`、`mentionInjection.ts`；ZCode `ui/mentions/` |
| **斜杠命令**（自定义命令文件 + 内置命令） | ✅ | ✅ | ✅ 2026-09-28（/clear 实义、/compact 占位；插件命令二期） | LA `skillTools`；ZCode `ui/slashCommandHelpers.ts`、`svc/commands/` |
| AGENTS.md 注入（OVERRIDE + 免责） | ✅ | ✅ | ❌（落位已备：meta_user 块） | ZCode `context/sections/request-user-context.ts` |
| gitStatus 快照注入 | — | ✅ | ❌（落位已备：meta_user 块） | ZCode `context/sections/env-info.ts` |
| 会话指引动态段（按可用工具变化） | — | ✅ | ❌ | ZCode `context/dynamic-sections.ts buildSessionGuidanceSection` |
| 记忆 Organizer 引擎 + Extraction 自动抽取 | ✅ | ✅ | ⚠️ Rust 表/命令与 UI 已备，二期接线（已定档） | LA `lib/memory/organizer/service.ts`；ZCode `core/memory/` |
| 跨会话上下文读取 | — | ✅ | ❌ | ZCode `core/session-context/` |

---

## 三、权限与安全

| 功能 | LiveAgent | ZCode | ReinAgent | 参考定位 |
|---|---|---|---|---|
| 审批四档 + 挂起审批 | ✅ | ✅ | ✅ | — |
| **工具级策略**（每工具 allow/ask/deny，Hub 内切换） | ✅ ToolPolicyToggle | ✅ broker+rule-matching | ❌ 一期裁剪（UI 组件 `lw/hub/ToolPolicyToggle.tsx` 已备，缺设置切片） | LA `toolPolicy.ts`、`WorkbenchToolPolicySection`；ZCode `core/permission/broker.ts` |
| 审批恢复（重启后待审横幅） | — | ✅ | ❌ | ZCode `runtime/permission-grant-recovery.ts`、`PendingCommandRecoveryBanner.tsx` |
| 沙箱能力探测 / 工作区根授权 | ✅ | ✅(部分) | ❌ | LA `sandboxPolicy`、`root_grants.rs` |
| MCP Elicitation 弹窗 | — | ✅ | ❌ | ZCode `ui/ElicitationDialog.tsx` |

---

## 四、Git 与工作区面板

| 功能 | LiveAgent | ZCode | ReinAgent | 参考定位 |
|---|---|---|---|---|
| 变更摘要卡 / 文件回退 | ✅ | ✅ | ✅（摘要卡 + checkpoint/rewind） | — |
| **Git 面板群**（分支切换器 / 提交图谱 / 变更卡 / 代码审查 tab） | ✅ | ✅ | ❌ | LA `commands/workspace/git.rs`、`RightDock*`；ZCode `ui/GitPane*.tsx`、`git-graph/`、`previewPaneCodeReview.ts` |
| **工作区文件树**（git 状态着色 / 监视刷新 / 拖拽） | ✅ | ✅ | ❌（预览面板内文件树未接） | ZCode `ui/workspace-file-tree/` |
| 工作区文件搜索（索引 / worker） | — | ✅ | ❌ | ZCode `ui/workspace-file-search/` |
| 多终端标签 + 租约管理 | ✅ | ✅ | ⚠️ 单终端 Pane | LA `TerminalPaneHost`、`terminalPaneLeaseStore` |

---

## 五、聊天 UX 与通知

| 功能 | LiveAgent | ZCode | ReinAgent | 参考定位 |
|---|---|---|---|---|
| **回合队列**（忙时排队发送 + 队列面板） | ✅ | ✅ | ❌ | LA `chat/queue/chatTurnQueue.ts`；ZCode `v4/` 排队消息面板 |
| **后台任务完成系统通知 + 提示音 + 未读角标 + 审批红点** | ✅ | ✅ | ❌（多任务并行的体验缺口） | LA `useNotifyToasts.ts`；ZCode `lib/taskNotificationOrchestrator.ts` |
| 草稿持久化 / 提示词历史翻页 | ✅ | ✅ | ❌ | LA `chat/composer/`；ZCode `chatComposerDraftStorage.ts` |
| 滚动位置记忆 | — | ✅ | ❌ | ZCode `lib/chatSessionScrollMemory.ts` |
| 命令面板（全局快捷命令 + 历史） | — | ✅ | ❌ | ZCode `ui/command-center/` |
| 选区侧聊（选中代码侧边提问） | — | ✅ | ❌ | ZCode `app-shell/SelectionSideChatPane.tsx` |
| 错误归因横幅（分类 + 证据） | ⚠️ | ✅ | ⚠️ 有错误行 + hint | ZCode `ChatErrorBanner.tsx`、`lib/chatErrorAttribution.ts` |
| 任务归档 / 批量删除 | ⚠️ | ✅ | ❌ | ZCode `lib/archivedTaskDeletion.ts` |
| 办公 / 新手双模式 UI | — | ✅ | ❌ | ZCode `ui/onboarding/` |

---

## 六、预览与可视化

| 功能 | LiveAgent | ZCode | ReinAgent | 参考定位 |
|---|---|---|---|---|
| 代码 / Markdown / 图片 / patch 预览 | ✅ | ✅ | ✅ | — |
| **PDF / Office（docx/xlsx/pptx）渲染引擎** | ✅ | ✅ | ❌（诚实降级 stub，见 PROJECT_CONTEXT 十一） | ZCode `ui/previewPane*Content.tsx`、`presentation/` |
| 演示文稿渲染 + PDF 导出 | — | ✅ | ❌ | ZCode `ui/presentation/` |
| 白板（画笔/导出/加入聊天） | — | ✅ | ❌ | ZCode `ui/WhiteboardPane.tsx` |
| Treemapping 回合文件活动图 | — | ✅ | ❌ | ZCode `ui/TreemappingPane.tsx` |
| 助手产物预览卡（HTML/PPTX 自动打开） | — | ✅ | ❌ | ZCode `ui/AssistantPreviewCards.tsx` |

---

## 七、模型与用量

| 功能 | LiveAgent | ZCode | ReinAgent | 参考定位 |
|---|---|---|---|---|
| 多协议多模型 / 自定义 BaseURL / 元数据编辑 | ✅ | ✅ | ✅ | — |
| **模型元数据真实解析（弃写死 128K/8192）** | ✅ | ✅ | ✅ 2026-09-28（批次 A2） | 见 PROJECT_CONTEXT 十.4 |
| Provider 故障转移 | ✅ | ✅(部分) | ❌（仅重试） | LA `providerFailover`、`model_failover.rs` |
| 原生联网搜索 | ✅ | — | ❌ | LA `nativeWebSearch` |
| **用量统计图表**（日趋势 / 模型饼图 / 热力图 / 配额） | ✅ | ✅ | ⚠️ 仅会话统计行 | ZCode `ui/settings/usage-stats/` |
| 缓存前缀调试 / 模型轨迹调试面板 | ✅ | ✅ | ❌ | LA `lib/debug/agentDebug`；ZCode `ui/ModelTrajectory*` |
| 推理等级与步数联动 | ✅ thinkingLevels | ✅ | ✅ | — |

---

## 八、桌面集成与杂项

| 功能 | LiveAgent | ZCode | ReinAgent | 参考定位 |
|---|---|---|---|---|
| 系统托盘 / 全局快捷键（录制/冲突检测） | ✅ | ✅ | ❌ | LA `trayMenu`、`globalShortcuts`；ZCode `ui/shortcuts/` |
| 自动更新器 + 发布公告 | ✅ | ✅ | ❌ | LA `update.rs`、`appUpdates.ts` |
| Hooks 生命周期钩子（脚本/HTTP + 信任评审） | ✅ | ✅ | ❌ | LA `hookLifecycle.ts`、`HookModal`；ZCode `core/hooks/workspace-hook-*.ts` |
| 插件系统（商店/市场源/创建器） | — | ✅ | ❌（侧栏入口已删） | ZCode `ui/settings/PluginStore*.tsx`、`svc/plugins/` |
| STT 语音输入（5 家供应商） | ✅ | — | ❌ | LA `services/stt/`、`useComposerStt` |
| WebDAV 备份同步 / Cherry Studio 导入 | ✅ | — | ❌ | LA `webdav_auto_sync.rs`、`cherry_import.rs` |
| 轨迹回放（时间线/小地图/子代理泳道） | ✅ | — | ❌ | LA `lib/trajectory/`、`components/trajectory/` |
| 资源管理器（存储扫描 / 清理 / 重算） | — | ✅ | ⚠️ 仅 temp 目录清理按钮 | ZCode `ui/resource-manager/` |
| Onboarding（模式引导 / 外部代理导入 / Claude 会话迁移） | — | ✅ | ❌ | ZCode `ui/onboarding/`、`ExternalAgentImportDialog.tsx` |
| 电源活动（阻止休眠）/ 字体管理 / 深链 | ✅ | ✅ | ❌ | LA `power_activity.rs`、`fonts.rs` |
| 桌面单机可缓的远程协作面 | ✅ gateway/WebUI/设备/隧道/SSH | ✅ SSH/Bots/分享/同步/订阅 | ❌（不实现） | LA `crates/agent-gateway`；ZCode `svc/bots/`、`packages/server/`、Coding Plan |

---

## 九、优先级路线图

### P0 —— 补核心能力（"家底"级，建议优先）
1. ~~**工具扩军第一批**~~ ✅ 2026-09-28（批次 B：glob/grep/delete_file/todo_write + Todo 卡 + 进度条；工具总数 5→9）
2. ~~**历史压缩 compact + microcompact**~~ ✅ 2026-09-28（批次 D：阈值 80% 自动压缩 + /compact 手动 + 压缩带 UI + microcompact 裁工具结果）
3. ~~**模型元数据真实解析**~~ ✅ 2026-09-28（批次 A2：`buildModel` 按真实元数据，未知走「不钳制/不发送/不声明多模态」语义）
4. ~~**后台任务完成通知 + 审批红点**（系统通知 + 提示音 + 侧栏未读角标）~~ ✅ 2026-09-28（批次 E，2f02b19）。
5. ~~**@提及与斜杠命令实义化**~~ ✅ 2026-09-28（批次 C：真菜单 + 命令文件扫描 + 提及内容注入；/compact 占位待批次 D）
6. ~~**回合状态条 attention 强制展开**（「等待你的决定」时强制展开 + 隐藏窗口停表）~~ ✅ 2026-09-28（批次 A1）

### P1 —— 差异化能力
7. **子代理系统**（**两批完成** ✅ 2026-09-28：引擎（嵌套 runTurn / Explore+general-purpose / 结构性禁递归 / 审批门继承）+ 回合内子代理卡 + **后台子代理（run_in_background / subagent_output / 完成通知）+ 目录面板（Running/Ended/Stop/详情）**；**未做增量**：「在右侧打开」完整对话回放（依赖子会话持久化）、自定义 agents/\*.md profile、子代理私有上下文持久化与 resume）：ZCode `core/subagent/`、LA `lib/subagents/`。
8. **AskUserQuestion + ExitPlanMode 交互闭环**（**部分** ✅ 2026-09-28，05ecc98：工具 + 回合内提问卡已做；ExitPlanMode elicitation / 独立提问弹窗 / PlanModeCard / Plan 开关标记待做）：**UI 同批做**：回合内提问卡（逐题/推荐标/1-N 翻页/其他输入/倒计时自动选，§11.2）+ 提问弹窗（分页/自定义/snooze/来源角标）+ PlanModeCard（三态脊 + 批准并开始执行，§11.3）+ Plan 模式开关标记（灯泡/✕）。
9. ~~**后台 Bash**（驻留进程 + TaskOutput/TaskStop）~~ ✅ 2026-09-28（Rust `bg_process.rs` 四命令 + `background_bash`/`task_output`/`task_stop` 三工具 + 回合内 turnActivity 标签；Tauri 实测闭环）。§11.5 增量未做：输出侧栏、输入框「后台工作」按钮/耗时标签。
10. ~~**WebFetch / WebSearch**（含域名白名单与结果缓存）~~ ✅ 2026-09-28（Rust `web_tools.rs`：DDG 无 Key 搜索 + ureq 抓取 + 15min 缓存 + SSRF 防护 + 代理设置；UI 联网搜索聚合行「已搜索 N 次·N 个来源」）。§11.8 增量未做：来源行点击外链打开。
11. ~~**工具级策略**（allow/ask/deny 三态 + Hub 内切换）~~ ✅ 2026-09-28（ee7fb11：任务级 toolPolicies + MCP Hub 卡 serverPolicy 切换）。
12. ~~**AGENTS.md + gitStatus 注入**（落位 meta_user 块）~~ **主体** ✅ 2026-09-28（3d49fc7：agents_md.rs 四级回退扫描 + meta_user 注入）；gitStatus 快照未纳入（需异步 git + 缓存，见 PROMPTS.md 待办）。
13. ~~**用量统计图表**（日趋势 / 模型分布 / 热力图）~~ ✅ 2026-09-28（**复刻 ZCode 一致**：源码直移 settings/usage-stats + Recharts + 52 周热力图每日/每周/累计 + 汇总条五指标 streak/peak/最长聊天 + 每日分模型趋势 + donut 份额；Rust 快照同形 AppUsageSnapshot）。未做增量：Coding Plan 远端配额面板、工具用量榜。
14. **记忆 Organizer 接线 + Extraction 管线**（**Extraction 批** ✅ 2026-09-28：LA 形态管线全链路——聊天后隐藏回合 + SubmitMemoryPlan 校验 + memory_apply_batch 事务落库 + 门控/coalesce 控制器 + pool 终态钩子，实测落库；**待做**：Organizer 编排批——聚类/合并/风控闸/调度挂载/Run Now）。
15. **排队消息面板 + 任务通知**：忙时排队（表头/上移/编辑撤回/打断并执行/删除，§11.5）+ 完成系统通知/提示音/侧栏交互角标（倒计时填充、hover snooze，§11.7）。

### P2 —— 完善与打磨
16. Git 面板群（分支切换器 / 变更卡 / 提交图谱 / 代码审查 tab）与工作区文件树。
17. PDF / Office（docx/xlsx/pptx）预览引擎（替换诚实降级 stub）；助手产物预览卡（PPTX 自动打开，§11.8）。
18. 快捷键系统（录制/冲突检测）、命令面板、托盘、自动更新器。
19. Hooks（脚本/HTTP + 信任评审）、插件系统；hook 待审横幅（§11.7）。
20. STT 语音、轨迹回放、白板、Treemapping、Markdown 演示导出。
21. 草稿持久化与滚动记忆、错误归因横幅（分类 + 证据链，§11.7）、审批卡倒计时与批量动作（§11.9）。
22. steering（运行中引导消息展示，§11.5）、ClarifyPanel（提示词澄清面板，§11.2）、命令安全模式选择器（§11.8）。
23. 代码评论卡、选区引用菜单与侧聊、Node REPL 多图网格（§11.8）。
24. ConversationStatusPanel 分区分组面板、回顶按钮/底部 dock 动画、加载更早消息与会话内查找、快照字段提示（§11.8）。
25. 工作流卡族、goal 卡与校验分隔线（依赖动态工作流立项，§11.8）。

### 暂缓（单机场景价值低 / 基建重）
远程网关与 WebUI、设备管理、隧道、SSH 远程工作区、会话分享、Bots 渠道、设置/技能/MCP 远程同步、Coding Plan 订阅类、遥测上报。

---

## 十一、会话内交互卡片（转写区 UI 细节清单）

> 2026-09-28 二次调研：把两家**出现在对话流内的**交互/状态 UI 逐项穷举后补齐。ReinAgent 已有项不再重复列 P0/P1（仅列增量细节）；标 **【新】** 的为完全缺失。

### 11.1 子智能体（重点）

| 项 | LA | ZCode | 我们 | 说明与参考 |
|---|---|---|---|---|
| **子代理卡片（回合内）** | ✅ 每子代理一张卡：MetaTags（`agent 2/3`/status/`mode=worktree`/apply/cleanup）+ 代理名/role/task/worktree 分支/diffStat/untracked/错误；批量被拒另有 `subagent_batch` 卡 | ✅ `AgentToolCallBlock`：Bot 图标 + 类型标签 + 主文案（活动/输出）+ 子工具列表嵌入 + 后台 Agent 过程（启动中/已启动/失败、活动流、输出近 N 行）+ **「在右侧打开」** → SubagentSessionSidePane | ❌ 【新】 | LA `components/chat/assistant-bubble/ToolResultDisplay.tsx`(L966-1130)、`agent-gui/src/lib/subagents/cards.ts`；ZCode `ToolCallBlocks/renderers/agent.tsx`、`agentHelpers.ts`、`v4/ConversationRowView.tsx`(SubagentRowView L2074) |
| **子代理目录侧栏** | — | ✅ Running/Ended 两段 + 每行状态图标（running 转圈/waiting·blocked 暂停/success 对勾/failed 感叹/cancelled 禁止/lost 虚线圈）+ 标题/状态词/summary/相对时间，点击进会话；Ended 分页 | ❌ 【新】 | ZCode `app-shell/SubagentDirectorySidePane.tsx`、`SubagentSessionSidePane.tsx`、`hooks/useSessionSubagents.ts` |
| **运行中子代理行 + 停止** | — | ✅ 状态面板 Agents 分区，可折叠（折叠显最长运行时长·N 个运行中）+ 独立 Stop 按钮 | ❌ 【新】 | ZCode `v4/ConversationStatusPanel.tsx`(SubagentStatusSection) |

### 11.2 提问 / 澄清（重点）

| 项 | LA | ZCode | 我们 | 说明与参考 |
|---|---|---|---|---|
| **AskUserQuestion 卡（回合内）** | ✅ 逐题单选、推荐项绿标「推荐」+ 描述、底部 `1 / N` + 上下箭头切题（滑动动画）、「跳过/继续/提交回答」、「其他（自行输入）」内嵌框（Enter 提交）、倒计时「m:ss 后自动选择推荐项」（到点按推荐锁定）；落定后只读三态：已提交/应答超时按推荐继续/已取消；提交失败红字 | ✅ 工具卡只读态：运行中 `asking`，结束显示 asked +「N 个问题」/「未提供回答」/「已自动继续」+ 逐题问答对；交互全走弹窗 | ❌ 【新】 | LA `components/chat/AskUserQuestionCard.tsx`、`lib/chat/askUserQuestion.ts`、`ToolCallItem.tsx`；ZCode `ToolCallBlocks/renderers/ask-question.tsx` |
| **ElicitationDialog（分页问答/表单）** | —(ClarifyPanel 近似) | ✅ 题目分页（上一题/下一题/`N/M`）+ 选项 + 自定义回答 + 提交/继续/忽略 + 倒计时（最后 60s 显示秒）+ 悬停 snooze + Plan 审批特化（主按钮强制 approve）+ 来源角标（子代理发起） | ❌ 【新】 | ZCode `ElicitationDialog.tsx`、`InteractionRequestOriginBadge.tsx`、`v4/V4InteractionDialogs.tsx` |
| **V4UserInputDialog（最小问答弹窗）** | — | ✅ prompt + 选项（点即答）+ 可选自由输入（sensitive 密码框）+ 提交 | ❌ 【新】 | ZCode `v4/V4UserInputDialog.tsx` |
| **ClarifyPanel（提示词澄清面板）** | ✅ 输入框上方：多轮澄清、单选/多选 + 「其他」自由输入、已答轮折叠只读、「直接生成提示词」（可带部分答案）、重试/关闭、列表吸底 | — | ❌ 【新】 | LA `components/chat/clarify/ClarifyPanel.tsx`、`useClarifySession.ts`、`clarifyRunner.ts` |

### 11.3 计划模式

| 项 | LA | ZCode | 我们 | 说明与参考 |
|---|---|---|---|---|
| **PlanModeCard（ExitPlanMode 卡）** | ✅ 左脊三态色（approved 绿/pending 天蓝+光晕/inactive 灰）+ 状态词（已批准/等待你的批准/不再待决）+ 卡体 markdown 计划 + pending 时「批准并开始执行」（spinner→批准中）；对话式批准（输入"同意/开始"亦可） | ✅ `SwitchModeToolCallBlock` 整卡可点（role=button，Enter/Space）→ PlanDetailSidePane 渲染实时计划；卡内内联预览 + 复制 | ❌ 【新】（我们只提示词约束，无卡/无批准按钮） | LA `components/chat/PlanModeCard.tsx`、`lib/chat/planMode.ts`、`planModeTools.ts`；ZCode `ToolCallBlocks/renderers/switch-mode.tsx`、`app-shell/PlanDetailSidePane.tsx` |
| **Plan 模式开关标记（输入框）** | — | ✅ 模式下拉 checkbox「Plan」+ 选中后工具栏灯泡标记（hover 变 ✕ 移除）；工具结果自动同步开关 | ❌ 【新】 | ZCode `v4/composer/V4ComposerModeControls.tsx`、`composerPlanTransition.ts` |

### 11.4 Todo 清单

| 项 | LA | ZCode | 我们 | 说明与参考 |
|---|---|---|---|---|
| **Todo 工具卡** | —(仅任务工具) | ✅ 表头 kindLabel「任务清单」+ 当前项 + `已完成/总数`；展开列表每项状态图标 | ✅ 2026-09-28（批次 B4） | ZCode `ToolCallBlocks/renderers/todo.tsx` |
| **Todo/Plan/Goal 状态面板分区** | — | ✅ 侧栏状态面板分区：逐项状态图标、Todo 预览弹层、折叠胶囊显当前 in-progress 项 | ❌ 【新】 | ZCode `v4/ConversationStatusPanel.tsx`(L584-910) |

### 11.5 后台任务与队列

| 项 | LA | ZCode | 我们 | 说明与参考 |
|---|---|---|---|---|
| **后台任务卡 + 输出侧栏** | ✅ BackgroundTasksPanel（托管进程列表：刷新/停止/清空/日志对话框/右键菜单） | ✅ `TaskOutput`/`TaskStop` 卡 + `BackgroundBashOutputSidePane`（运行中转圈、「完整输出文件」链接、跟随吸底）+ 输入框「后台工作」按钮（badge 计 bash/workflow/subagent）+ 耗时标签 | ❌ 【新】 | LA `project-tools/BackgroundTasksPanel.tsx`、`lib/managed-process/store.ts`；ZCode `renderers/task-output.tsx`、`task-stop.tsx`、`app-shell/BackgroundBashOutputSidePane.tsx`、`v4/composer/ConversationBackgroundWorkTrigger.tsx` |
| **排队消息面板** | ✅ 输入框上方：表头「等待队列 N」+ 折叠、每行序号+预览+「N 个文件」、上移/编辑撤回/打断并执行(RunNow)/删除 | ✅ 可拖拽排序（dnd-kit）、「立即发送/编辑撤回/删除」、队列暂停横幅+恢复、发送前确认弹窗 | ❌ 【新】 | LA `pages/chat/ChatComposerBar.tsx`(L1162-1300)、`queue/chatTurnQueue.ts`；ZCode `v4/ConversationQueuePanel.tsx` |
| **转向消息（steering/guide）** | — | ✅ 运行中插入的消息以真实用户行渲染，副行「等待引导当前任务…」；投递策略 startNow/queue/guide；状态词「正在引导对话/已引导对话」 | ❌ 【新】 | ZCode `v4/ConversationPendingGuideList.tsx`、`v4/pendingGuideProjection.ts` |

### 11.6 压缩标记

| 项 | LA | ZCode | 我们 | 说明与参考 |
|---|---|---|---|---|
| **压缩带 / seam（回合内）** | ✅ 紫罗兰 band：运行中 shimmer + 进度条，落定可展开（chips「覆盖 N 条消息」+ 展开挂摘要 markdown） | ✅ compact 分隔线 | ✅ 2026-09-28（批次 D2；chips「覆盖 N 条消息」+ 展开） | LA `components/chat/CompactionBand.tsx`、`CompactionSeamRow.tsx`；ZCode `v4/ConversationRowView.tsx`(L1666-1890) |
| **ContextCheckpointCard（压缩分隔卡）** | ✅ 回合之间居中卡：标题 +「N 条消息/已压缩」+ 点击展开摘要 + 显示生成来源 provider/model | — | ❌ 【新】 | LA `components/chat/ContextCheckpointCard.tsx` |

### 11.7 通知与恢复

| 项 | LA | ZCode | 我们 | 说明与参考 |
|---|---|---|---|---|
| **系统任务通知 + 提示音** | ✅ 后台完成/需要审批时系统通知 + toast | ✅ 任务终态（completed/failed）+ 待交互通知（含 AskUserQuestion 挂起）+ 提示音（设置开关，偏好持久化） | ❌ 【新】 | LA `useNotifyToasts.ts`；ZCode `lib/taskNotificationOrchestrator.ts`、`lib/taskNotificationSound.ts`、`hooks/useTaskNotifications.ts` |
| **任务列表交互角标** | — | ✅ `TaskInteractionBadge`（权限类/问答类，带倒计时填充，hover 变 snooze，点击进任务）；任务行「标为未读」+ 未读点 | ❌ 【新】 | ZCode `TaskInteractionBadge.tsx`、`TaskListItem.tsx` |
| **错误归因横幅** | ⚠️ usage 类特判 | ✅ 输入框上方：错误文案 + traceId + 展开详情 + 复制 + 反馈 + 去设置模型 + 重试 + 关闭；归因按 code/正则证据分类（provider/runtime/network/tool × rate_limit/balance/context/auth/timeout/overload…） | ⚠️ 我们有错误行+hint，无归因分类/横幅 | ZCode `ChatErrorBanner.tsx`、`lib/chatErrorAttribution.ts` |
| **审批恢复横幅** | — | ✅ 「检测到未完成的待审批命令」+ 重新发送（有 replay payload 时）/忽略，不自动重放 | ❌ 【新】 | ZCode `v4/PendingCommandRecoveryBanner.tsx` |
| **Hook 待审横幅** | — | ✅ 待审 hook 数 + 去审核 + dismiss（bundleDigest 幂等） | ❌ 【新】（依赖 Hooks） | ZCode `v4/WorkspaceHookPendingBanner.tsx` |
| **会话订阅错误面板** | — | ✅ 转写区整块替换：错误 + 重新订阅 + 上报 | ❌ 【新】（单机可简化） | ZCode `v4/SessionSubscriptionErrorPanel.tsx` |
| **MCP 不可用提示** | — | ✅ 输入框上方 notice（额度耗尽类） | ❌ 【新】（单机可简化） | ZCode `v4/mcpUnavailableBannerNotice.ts` |
| **重试历史可展开** | ✅ RetryDetailsBlock「N 次重试」→ 每次尝试序号+错误 | ✅ 仅副行 `chat.apiRetryStatus` | ⚠️ 我们此前按用户决策删除了 RetryDetailsBlock（副行已带原因） | 用户定档不复加 |

### 11.8 产物与其他卡

| 项 | LA | ZCode | 我们 | 说明与参考 |
|---|---|---|---|---|
| **助手产物预览卡** | — | ✅ markdown/file 预览卡（stat 校验）+ PPTX 自动打开 + HTML 走浏览器 + OpenSplitButton | ❌ 【新】 | ZCode `AssistantPreviewCards.tsx`、`v4/assistantPreviewPptxAutoOpen.ts` |
| **代码评论卡** | — | ✅ 折叠区每条评论（P0-P2 优先级着色）+ 点击跳代码查看器定位 | ❌ 【新】 | ZCode `AssistantCodeCommentCards.tsx`、`lib/assistantCodeComment.js` |
| **选区引用菜单 + 选区侧聊** | — | ✅ 选中文本浮层两项「加入当前任务」「在侧聊中提问」+ 侧聊 pane + 引用 chip | ❌ 【新】 | ZCode `v4/ConversationSelectionTooltip.tsx`、`app-shell/SelectionSideChatPane.tsx` |
| **Node REPL 图片网格** | ✅ ToolImages 灯箱（缩放/平移/复制/系统打开） | ✅ 多图缩略图网格（≥2 张分组）+ 点击开预览对话框（左右切换/缩放/下载） | ⚠️ 单图灯箱已有，多图网格待加（依赖 Node REPL 工具） | ZCode `renderers/nodeReplImageGrid.tsx`、`ai-elements/image-preview-dialog.tsx` |
| **工作流运行卡族** | — | ✅ run 卡（整卡可点开侧栏）/后台通知行/完成收据卡（时长·tokens·子代理数·阶段数四格+产物索引）/轮尾摘要/只读问答行 | ❌ 【新】（依赖动态工作流） | ZCode `v4/ConversationWorkflowCompletion.tsx`、`WorkflowNotificationToolRow.tsx`、`workflow-timeline/` |
| **goal 卡与目标校验分隔线** | — | ✅ Goal 工具卡 + goalVerify 分隔线（第 N 次迭代·校验中/已完成）+ 状态面板分区（暂停/恢复） | ❌ 【新】 | ZCode `renderers/goal.tsx`、`v4/ConversationRowView.tsx`(L1826) |
| **任务进度条（composer 上方）** | ✅ 圆环/对勾 + 「任务进行中」+ 第 X/Y 步 + 已完成 N/M；hover PreviewCard 展开步骤清单 | — | ❌ 【新】（依赖 Todo/Task 工具） | LA `components/chat/TaskProgressBar.tsx`、`lib/chat/taskProgress.ts` |
| **命令安全模式选择器** | ✅ 输入框工具栏下拉四档：询问/自动/沙箱/断网沙箱（含平台能力差异文案） | — | ❌ 【新】 | LA `components/chat/CommandSafetyModeSelector.tsx`、`sandboxPolicy.ts` |
| **工具卡聚合组** | ✅ ToolTraceGroup（思考+工具折叠分组，显 running/failed/completed/waiting 计数） | ✅ changes-group / execute-group / cua-group（多文件、多 bash、CUA 分别聚合） | ⚠️ 我们按独立卡渲染（2026-09-27 已删除查阅聚合） | ZCode `renderers/changes-group.tsx`、`execute-group.tsx` |
| **联网搜索聚合行** | ✅ HostedSearchGroupView「已搜索 N 次·N 个来源」+ 展开来源 + 失败文案 | — | ❌ 【新】（依赖 WebSearch） | LA `HostedSearchGroupView.tsx` |
| **ConversationStatusPanel（分区分组面板）** | — | ✅ 六分区：Git/Goal/Plan/Session Plans/Todo/Terminals/Agents/Workflows，每区可 Stop + 目录入口；折叠胶囊显摘要 metric | ⚠️ 我们有会话统计行，无分区面板 | ZCode `v4/ConversationStatusPanel.tsx`、`conversationStatusPanelModel.ts` |
| **回到底部按钮 / 底部 dock 动画 / 配额横幅** | — | ✅ 回顶圆钮（吸底时隐藏）、dock 入场退场动画、配额/并发/MCP 额度横幅（可 dismiss，含去设置入口） | ⚠️ 我们靠贴底跟随，无回顶按钮 | ZCode `v4/ConversationTimeline.tsx`(L128/L1930)、`ConversationQuotaBanner.tsx` |
| **加载更早消息 / 会话内查找** | ✅ ChatTranscript load-earlier 阈值 + 搜索对话框 | ✅ 顶部「加载更早消息」+ 会话内 find 高亮索引 + TaskFindDialog | ❌ 【新】（历史分页 hydration 已在 PROJECT_CONTEXT 十一 Gap） | ZCode `v4/ConversationTimeline.tsx`、`useConversationTimelineFind.ts` |
| **白板 / 内嵌浏览器 / Office 预览 pane** | — | ✅ WhiteboardPane（画笔/橡皮/撤销/加入对话）、EmbeddedBrowserPane、PreviewPane 系列（含 PPTX 元素引用 chip） | ❌ 【新】 | ZCode `WhiteboardPane.tsx`、`EmbeddedBrowserPane`、`previewPanePptxContent.tsx` |
| **快照字段提示** | — | ✅ 工具卡字段被快照截断时给「加载完整字段」可点提示 | ❌ 【新】 | ZCode `ToolCallBlocks/ToolSnapshotFieldNotice.tsx` |

### 11.9 已有但可对照打磨（细节差异）

| 项 | 两家细节 | 我们的现状 |
|---|---|---|
| 回合状态条 | LA：像素格动画 + 隐藏窗口停表 + **attentionRequired 强制展开（等待你的决定）**；ZCode：整段历史可折叠 + 尊重用户交互的 autoCollapseKey | 我们有状态条/思考折叠；缺 attention 强制展开与停表细节 |
| 文件更改摘要卡 | LA：+A−B Odometer 数字动画、每行三动作（编辑器/文件树/diff）；ZCode：「撤销/重新应用」+ 行内 OpenSplitButton | 我们已有审查/打开/清理 temp；缺逐行三动作与数字动画 |
| 审批卡 | LA ToolApprovalBar：**批量动作下拉（全部允许/全部拒绝）+ 最早 deadline 倒计时 + 超时按拒绝落定**；ZCode PermissionDialog：模态 + 多档作用域（始终允许此命令/本会话/本项目）+ 拒绝可填反馈 + 键盘提示 | 我们是输入框上方卡（允许/总是允许/拒绝），缺倒计时/批量/作用域档位 |
| checkpoint 回退 | ZCode `ConversationFileRewindDialog`：safe/unsafe/ignored 三段 + 原因（bash_ignored/checkpoint_missing/external_modified…）+ 「仅回退对话」分支 | 我们已有 preview→确认→执行链路；缺分段原因明细 |

### 11.10 本章优先级建议（插入总路线图）

- **P0 追加**：Todo 工具卡（随 Todo 工具同批）；压缩带/分隔线（随 compact 同批）；回合状态条 attention 强制展开（小成本高体验）。
- **P1 追加**：子代理卡片与目录侧栏（随子代理系统同批）；AskUserQuestion 卡 + 提问弹窗（随工具同批）；PlanModeCard + 批准按钮 + Plan 模式开关标记；后台任务面板；排队消息面板；任务通知 + 角标。
- **P2 追加**：steering、ClarifyPanel、错误归因横幅、审批恢复/待审横幅、产物预览卡、代码评论卡、选区侧聊、工作流卡族、goal 卡、ConversationStatusPanel 分区、回顶按钮、加载更早消息、白板/浏览器 pane、快照字段提示。
- **细节打磨**：审批卡倒计时与批量、摘要卡逐行动作与数字动画、文件回退分段原因。

---

## 十、执行纪律

- 每一项开工前：先读对应参考源码（上表「参考定位」），按本项目 `AGENTS.md` 铁律（需求前置确认 / No-Fallback / 主题语义变量 / Bun / 双模兼容）落地；
- 完成后：本表标 ✅ + 同步 `PROJECT_CONTEXT.md`（涉及提示词改动同步 `PROMPTS.md`）；
- 每批完成后跑全量验证：`tsc`、`bun run build`、`test:chat/agent/providers/settings/markdown/hub`、`cargo test --lib`。
