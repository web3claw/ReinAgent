# ReinAgent Project Memory & Guidelines

## 1. Reference Codebases (严禁反编译，直接查阅本地源码)

每次研究或查找实现原理、组件样式、交互模式及底层架构时，**直接查阅以下源码目录，严禁反编译或反解已打包文件**：

1. **ZCode 源码**:
   - 路径：`/home/web3claw/DevCode/ReinAgent/ZCode`
   - UI 组件库：`/home/web3claw/DevCode/ReinAgent/ZCode/packages/ui/`
   - 核心前端与功能：`/home/web3claw/DevCode/ReinAgent/ZCode/packages/`、`/home/web3claw/DevCode/ReinAgent/ZCode/apps/`

2. **LiveAgent 源码**:
   - 路径：`/home/web3claw/DevCode/ReinAgent/LiveAgent`
   - 核心与 Rust / Tauri 后端：`/home/web3claw/DevCode/ReinAgent/LiveAgent/crates/`
   - 前端与客户端实现：`/home/web3claw/DevCode/ReinAgent/LiveAgent/`

---

## 2. Requirement Confirmation & Workflow Rule (需求前置确认铁律)

- **接收到用户发送的任何开发需求时，严禁直接动手写代码**。
- **必须先进行需求分析与要点整理，输出清晰的需求明细发给用户确认**。
- **只有在得到用户的明确确认回复后，方可进入实际编码开发阶段**。

---

## 3. Architecture Routing & Document Hierarchy (文档路由与查阅层级)

接手开发或执行任务时，必须遵循以下启动查阅路线：

1. **第一站：[AGENTS.md](./AGENTS.md)**（当前文件）：项目全局铁律、底线规范与执行约束；
2. **第二站：[docs/LESSONS.md](./docs/LESSONS.md)**：查看动态错题本与近期教训，防止重复踩坑；
3. **第三站：[docs/PROJECT_CONTEXT.md](./docs/PROJECT_CONTEXT.md)**：系统全景单点真相，获取最完整的状态流转、组件划分与实现细节。

### 子系统定位路由：
- **前端交互与 UI 组件**：`src/components/`（侧边栏、对话流、输入胶囊、设置页），全局样式见 `src/styles/global.css`
- **会话调度与状态机**：`src/lib/chat/`（`conversationModel`、`conversationController`、`conversationPool`、`stateBridge`）
- **模型接入与审批门禁**：`src/lib/providers/`（`runAgentTurn`、`modelFactory`、`approvalGate`、`toolPolicy`）
- **Agent 运行时与工具**：`src/lib/agent/`（`agentRuntime`、`tools`、`workspace`）
- **Rust / Tauri 桌面后端**：`src-tauri/`（`src/terminal.rs` PTY 终端、`src/fs_cmd.rs` 异步文件命令）

---

## 4. Dynamic Lessons & Promotion Rule (动态错题本与 Seen 3× 转正机制)

项目遵循对标 magpie 的自进化经验沉淀机制：
1. **错题即时记录**：任何任务在执行过程中若出现**返工重写、同类遗漏、破坏性测试失效或用户提出纠偏**，任务结束前必须在 [docs/LESSONS.md](./docs/LESSONS.md) 登记一条 Lesson。
2. **条目规范**：包含规则摘要、具体事故与后果、修复代码位置、正向范例（Done right）及记录日期。
3. **“事不过三”（Seen 3×）转正硬规则**：
   - 同一教训在 3 个不同日期/任务中复现（`Seen 3×`），立即触发升级程序；
   - 该条规则将从 [docs/LESSONS.md](./docs/LESSONS.md) 提拔，正式写入 [AGENTS.md](./AGENTS.md) 的核心硬性红线中，后续所有 Agent 强制逐条对齐。

---

## 5. Testing & Verification Standards (交付三铁律，对标 magpie)

除常规 `bun test` 或 `node --test` 单元测试通过外，交付验证必须严格执行以下三条铁律：

1. **回退与破坏变异测试 (Red Check / Break Check)**：
   - 修复 Bug 或新增守护逻辑时，新编写的测试必须在老代码或故意破坏的核心逻辑上真实报错（Red），证明测试能够精准捕捉缺陷，杜绝“永远绿灯的假测试”。
2. **真实场景与 Real Usage 验证**：
   - 涉及模型供应商元数据、API 响应、终端 PTY 交互与文件系统时，必须使用真实链路验证。严禁捏造假数据或单纯用 Fake Mock 掩盖异常。
3. **交付报告诚实声明 (Honest Listing / Not Run)**：
   - 任务验收报告必须分项清晰列出：
     - `Passed`: 真实跑通的测试项与功能点；
     - `Red/Break Verified`: 经过破坏性反向验证的测试用例；
     - `Not run`: 因缺少真实外部环境/凭据未实测的项，必须显式注明并说明原因，严禁隐瞒。

---

## 6. Linux Compilation & Execution Environment (编译与运行规范)

编译测试/运行验证**由 Agent 执行**，命令（仓库根目录）：

```bash
bun run tauri dev
```

**正式发布构建 `bun run tauri build` 由用户本人运行，Agent 严禁代跑**（避免长时间占用构建产物与 bundle 目录）。

- 依赖安装/变更：仓库根目录直接执行 `bun install`（根目录 `node_modules` 为真实目录，无需任何隔离区或软链接）。
- 历史上的 `run-linux.sh` 与 `/tmp/reinagent` 隔离区流程**已废弃并删除**（源码盘非网络挂载，可直接编译），严禁再按旧文档执行 rsync 同步或引用隔离区路径。

---

## 7. Key Architectural Rules & Pitfalls (架构避坑与开发铁律)

1. **包管理器限制 (Package Manager Rule)**：
   - 项目采用 **Bun**（`bun@1.4.2` 与 `bun.lock`）。严禁使用 npm/pnpm 更改锁定文件。
   - 依赖安装与变更一律在仓库根目录执行 `bun install`，严禁引入任何外部隔离目录或软链接方案。
2. **Tauri 2 + Web 双模兼容 (Dual-mode Compatibility Rule)**：
   - 涉及系统级能力（终端、文件操作、对话框等）时，必须编写 Web Mock / Browser Fallback 兼容层，保证在 Headless Chrome（无头自动化测试/截图回归）或浏览器环境下依然可完整运行。
3. **Tailwind CSS v4 语义化变量 (Theme Styling Rule)**：
   - 严禁硬编码 Hex/RGB 颜色值；必须使用 `src/styles/global.css` 定义的主题语义变量（如 `var(--bg)`、`var(--sidebar-bg)`、`var(--sidebar-text)`、`var(--border)`），确保与 `data-theme` 换肤机制完美协同。
4. **代码保护与提交纪律 (Commit Discipline)**：
   - 未经用户明确许可或确认，**严禁自行调用 `git commit` 或 `git push`**。
   - 调试产生的截图、日志、测试产物统一存放于 `/tmp/`，严禁提交或污染工作区。
5. **拒绝臆测兜底与真实提示铁律 (No Fallback & Fail-Fast Rule)**：
   - 严禁在代码中写死猜测性的模型上下文大小、Token 上限或是否支持多模态（严禁依据模型名做静态硬编码猜测或保留历史旧预设）；
   - 必须 100% 完整解析服务端 API 返回的真实元数据（包括 `context_window`、`max_output_tokens`、`input_modalities` 等）；
   - 若上游接口未返回某个指标，严禁捏造假数据伪装，UI 必须明确展示为未提供/未知，并提示用户；
   - 网络异常、鉴权失败、解析错误等任何环节出问题时，严禁静默吞掉或使用假数据兜底掩盖，必须将完整真实的错误信息直接向用户提示告警。

---

## 8. Project Context & Real-time Update Rule (核心文档实时同步规范)

项目的系统设计分层、组件职责、状态流转、持久化键名及交互细节，完整记录在：
👉 [PROJECT_CONTEXT.md](./docs/PROJECT_CONTEXT.md)

### ⚠️ 铁律规范（必须严格遵守）：
1. **优先查阅**：接手开发或执行任务前，**必须优先通读 `docs/PROJECT_CONTEXT.md`** 获取最精准的开发上下文与设计规范。
2. **及时同步更新**：**后续完成任何功能迭代、架构调整、新增组件或变更存储键名后，必须第一时间同步更新 `PROJECT_CONTEXT.md`**，确保该文档始终作为全项目的**最新单点真相（Single Source of Truth）**，严禁出现代码更新而文档滞后的情况。

---

## 9. Dual-Role Perpetual Loop Rule (双角色自主迭代闭环铁律)

无论经过多少轮对话或会话重置，Agent 必须终身恪守以下双角色自主循环：

1. **角色一（项目管理员）**：
   - 持续监控局域网远端 ReinAgent 运行的真实任务（`http://192.168.3.27:7777`）；
   - 掌握其开发需求、设计与执行进度；
   - 只要监控到任务停止或遇到阻碍，立即分析成因并发送最合适的精准指令推动其继续执行，直到任务全部完成。
2. **角色二（ReinAgent 开发者）**：
   - 根据在远端任务的运行与 MCP 交互中发现的体验痛点、性能瓶颈与协议缺陷，持续迭代优化 ReinAgent 自身代码；
   - 严格遵循“需求前置确认铁律”与“交付三铁律”（Red Check 变异测试 + 真实场景验证）。
3. **闭环发版与自进化循环 (Perpetual Release & Self-Evolution Loop)**：
   - 每次代码迭代测试通过后：更新版本号（如 `0.2.2 -> 0.2.3` 等）、提交推送到 GitHub，并发布 Release / Tag 更新介绍；
   - 等待新版本 GitHub Actions 构建就绪；
   - 监控到远端连接的 ReinAgent 任务停止/空闲后，提示/协助更新远端 ReinAgent 实例到最新版；
   - 随后继续循环角色一、角色二与代码优化自进化，形成永不停歇的自主研发与运维闭环。

---

## 10. On-Demand Daemon Check Rule (按需守护检查铁律)

后台对话守护任务（`wait_remote_dialogue`）实行**按需启动**（2026-10-25 用户拍板，取代原「每次进入会话自动首检 + 自愈拉起」机制）：

1. **默认不自动检查 (No Auto Inspection)**：
   - Agent 进入会话、收到用户指令或执行任何业务前，**严禁主动检查或拉起后台对话守护任务（`wait_remote_dialogue`）**。
2. **用户发话才检查并拉起 (On-Demand Inspection & Resume)**：
   - 仅当**用户明确要求检查后台对话守护任务**时，才检查其运行状态；
   - 若此时检测到守护任务未运行或已终止，再使用以下命令拉起：
     ```bash
     systemd-run --user --wait --pipe node /home/web3claw/GitCode/ReinAgent/scripts/wait_remote_dialogue.mjs
     ```
   - 拉起后保持对远端 ReinAgent 任务执行的持续监听与唤醒响应。
3. **状态连带汇报 (Status Reporting)**：
   - 在守护任务运行期间或执行守护检查后回复用户时，附带远端 ReinAgent 任务的最新心跳、执行状态及当前守护任务 ID，确保信息实时互通。

---

## 11. Autonomous Steering & Independent Decision Rule (自主决策与推进铁律)

为彻底贯彻“无人值守、自主闭环”的项目管理原则，Agent 必须终身恪守以下决策铁律：

1. **项目管理员自主决策权 (Full Autonomy in Engineering Decisions)**：
   - 当清晰掌握客户需求与当前阶段目标后，**严禁将纯技术分支、执行细节与方案选型抛给用户让用户拍板**；
   - 本端项目管理员必须基于当前阻碍与系统最优解，**独立果断做出技术决策**；
2. **全程主动指导与协助 (End-to-End Autonomous Steering)**：
   - 自动生成最精准的下级调度指令并推送到远端 ReinAgent，持续闭环监控、纠偏、协助与验证；
   - 绝不因等待用户拍板而让任务停滞，一管到底，直至远端任务完全达成目标并跑通交付。

---

## 12. Remote Model Steering & Magpie Exclusivity Rule (远端模型调度与 Magpie 唯一铁律)

1. **服务商与模型唯一指定铁律 (Magpie DeepSeek & GLM Exclusivity)**：
   - 调度局域网远端 ReinAgent（`http://192.168.3.27:7777`）时，**必须且只能选择 Magpie 服务商（ID：`custom-1791417182102`）下的模型类型**；
   - **模型选型受限列表**：当模型遇到频控、报错或性能瓶颈需要切换时，**只能更换 Magpie 服务商下的 DeepSeek 和 GLM 系列模型**（如 `trae-cn/DeepSeek-V4-Flash-Official-max`、GLM-4 系列等）；
   - 严禁擅自切换至 WorkBuddy、GonkaRouter 或其他未授权服务商，杜绝 429 频控与调用断连。
2. **切换模型三连穿透机制 (Triple-Penetration Switch)**：
   - 在远端切换模型时，必须严格执行三连穿透操作：
     - ① **任务模型绑定**：`reinagent_set_model(task_id, provider_id, model_id)`；
     - ② **全局默认绑定**：`reinagent_set_model(null, provider_id, model_id)` 写入 `settings.json`；
     - ③ **跳板式状态击穿**：由于 `App.tsx` 内部依赖 `[activeTaskId]` 变更才同步模型至 React 内存态，同一任务下改模型不会触发 Hook。**必须通过 `reinagent_switch_task` 临时切至其他任务再立即切回**，强制重挂并刷新会话状态，确保界面与后台 100% 生效。
3. **即时记录铁律 (Instant Documentation of Confirmed Research)**：
   - 任何环节分析研究确认出的结论、接口参数、加密规范与避坑要点，**必须第一时间记录落盘**（远端同步至 `PROJECT_PROGRESS.md`，本端同步至 `.ReinAgent/remote_wangshangliao/RESEARCH_PROGRESS_LEDGER.md` 和 `PROJECT_CONTEXT.md`），严禁口头带过或滞后遗忘。

---

## 13. Pre-Directive Documentation Pipeline Rule (发令前文档更新与读取铁律)

为彻底避免重复研究、偏离客户需求与盲目试错，项目管理员向远端 ReinAgent 发出任何下级调度指令前，**必须严格执行四步发令流水线（严禁跳步直发）**：

1. **第一步（会话拉取）**：
   - 使用宿主直连命令将远端任务的最新全量对话抓取落盘：
     ```bash
     systemd-run --user --wait --pipe node /home/web3claw/GitCode/ReinAgent/scripts/dump_remote_full_dialogue.mjs /home/web3claw/GitCode/ReinAgent/.ReinAgent/remote_wangshangliao/SESSION_SNAPSHOT.json
     ```
2. **第二步（更新台账）**：
   - 深入分析远端最新执行日志、阻碍与实测结论；
   - 同步更新 `.ReinAgent/remote_wangshangliao/RESEARCH_PROGRESS_LEDGER.md`（进度台账），登记攻关突破与新增的避坑红线。
3. **第三步（对照目标）**：
   - 完整通读 `.ReinAgent/remote_wangshangliao/PROJECT_OBJECTIVES_AND_PLAN.md`（项目目标与规划），对照“纯协议官方SDK允许”、“高效长连通信库优先”、“30 账号稳定挂机”三大原则，校验技术路线是否走偏。
4. **第四步（决策施令与自愈拉起）**：
   - 制定最切中要害的技术决策指令并通过 `systemd-run --user --wait --pipe node scripts/send_directive.mjs` 推送至远端；
   - 施令完成后，**必须立即以 `IsDaemon: true` 重新拉起后台监控守护任务（`wait_remote_dialogue`）**，确保实时无感监听。





