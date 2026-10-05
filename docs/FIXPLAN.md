# ReinAgent 修复计划表 —— 写死数据与装饰性功能审计（2026-10-05）

> **文档定位**：2026-10-05 全库审计（三路并行扫描 + 人工逐条复核）产出的修复计划。
> 审计范围：装饰性设置（UI 有、运行时零消费）、写死数据（违反 No-Fallback 铁律）、失效开关（操作后不改变运行时行为）。
> **状态**：待确认（D1/D2/D3 三个决策点 + 批次整体确认后开工）。
> **维护纪律**：完成任务后勾选 `[x]`、写完成日期与提交号，并同步 `PROJECT_CONTEXT.md`。

---

## 一、决策点（需先拍板）

| # | 决策 | 推荐方案 | 备选方案 | 备注 |
|---|---|---|---|---|
| **D1** | max_tokens：模型元数据未知时发不发 32000 请求级兜底 | **发（已按参照源码定稿）**——LiveAgent 同场景实测设计：未知时注入 `model.maxTokens` 兜底值随请求发出（deepseek 兜底就是 32K，生产环境验证过）；ZCode 的 maxOutputTokens 为模型配置一等 option（完整 schema `max` 必填正值），每请求经 option-map 注入，「声明即注入」无静默省略路径。本方 32000 兜底 + 注释意图正是照此模式写的，只差注入最后一步 | 不发（未知不捏造）——但会被 LiveAgent/ZCode 双参照的设计否决 | F1 依赖此项；已定稿：**发** |
| **D2** | 记忆设置「会话摘要模型」（summaryModel） | **删除 UI 与字段**（本应用无摘要功能消费它，属 LiveAgent 移植残留；kv 旧数据保留兼容读取） | 接线到记忆整理管线 | F8 依赖此项 |
| **D3** | MCP 服务器策略（allow/ask/deny） | **删除 UI 与字段**（接线需另立「MCP 工具执行审批门」项目，工作量大） | 接线：工具执行前按策略拦截 | F9 依赖此项 |

---

## 二、批次 1：数据安全（高危）

### F1 · max_tokens 防截断意图从未接线 ✅已完成（2026-10-05，未提交）

- **问题**：`modelFactory.ts` 2026-10-05 定档注释声称 openai 协议未知时「必须发送」max_tokens（防网关默认上限 ~3072 半途截断），但实际链路 `pi-agent-core/dist/agent-loop.js:235` 调 stream 时透传的 options 里没有 maxTokens（runAgentTurn → streamFnAdapter → pi-agent-core 全链不传）；pi-ai openai 适配器 `params.max_tokens = options.maxTokens`（undefined → 不发），responses 适配器同。**只有 anthropic 适配器 `?? model.maxTokens` 兜底发 32000**。`model.maxTokens` 在 openai/responses 协议下仅作 reasoning budget 钳制（openai-completions.js:761）。
- **修复**：
  1. `src/lib/providers/runAgentTurn.ts` `wrapStreamWithProxiedFetch`：调用原 stream 前注入 `maxTokens: resolveMaxTokens(options.maxTokens, model.maxTokens)`——**照抄 LiveAgent `runtime/common.ts:7` 的同名函数**：`requested > 0 ? Math.min(requested, modelMax) : modelMax`，即未知时发 `model.maxTokens`（32000 兜底或真实元数据值），已知时取两者较小值；不覆盖调用方显式传入的值；anthropic 适配器读到同值，语义不变；
  2. D1 已定稿：**未知也发 32000 兜底**（LiveAgent 生产验证 + ZCode「声明即注入」哲学双参照）；
  3. 同步改写 `modelFactory.ts` 注释块（见 F15），并注明与 LiveAgent 的差异：LiveAgent 按供应商差异化兜底（claude 32K/codex 142K/gemini 65K/xai 142K/deepseek 32K，见其 `PROVIDER_FALLBACK_LIMITS`），本方暂一刀切 32000，后续可按供应商差异化。
- **验证**：① A2 测试新增「已知发真实值 / 未知不发」断言；② CDP 实测：未知元数据模型请求体无 max_tokens，已知元数据模型带真实值。
- **风险**：低。已知元数据模型从「从不发」变「发真实值」，属元数据本义；官方 API 均接受 ≤ 上限的值。

### F2 · buildModel 兜底链静默发 DeepSeek ✅已完成（2026-10-05，未提交；含 titleGenerator 与 App 调用点）

- **问题**：`src/lib/providers/modelFactory.ts:92-95` —— custom 服务商（catalog 外 id）配了 Key 但 modelId/baseUrl 留空时，`config.modelId || meta.defaultModelId` + `getProviderMeta || PROVIDERS[0]` 把请求静默发往 `api.deepseek.com` + `"deepseek-chat"`，用用户自己的 Key。
- **修复**：
  1. `buildModel`：modelId 为空 → 抛错「未选择模型」；
  2. provider 在 catalog 外（`custom-*`）且 baseUrl 空 → 抛错；
  3. App 层发送入口（composer 守卫）提前拦截给友好提示 + 「未配置默认模型」引导。
- **验证**：① 新增单测：空 modelId 抛错、custom 空 baseUrl 抛错、preset 空 baseUrl 走 catalog 默认（合法）不抛；② CDP：无模型新任务发送 → 明确错误行。
- **风险**：中——全新安装从「能跑（打 deepseek-chat）」变「必须先选模型」，属行为收紧（fail-fast 本义）。

### F3 · titleGenerator 协议误判 + 用 legacy settings ✅待修

- **问题**：`src/lib/chat/titleGenerator.ts:89-105` —— custom id 恒落 deepseek meta，anthropic 格式供应商的标题请求误走 `/v1/chat/completions`；调用点 `App.tsx:1336` 传 legacy 全局 settings 而非活动任务配置。
- **修复**：① 协议判定改由调用方传入的 `apiFormat` 驱动；② 调用点改传活动任务的 ProviderItem；③ modelId 为空直接本地降级标题（不发请求）。
- **验证**：单测——anthropic 格式 custom 供应商标题请求打到 `/v1/messages`；空 modelId → 本地标题。
- **风险**：低。

---

## 三、批次 2：开关语义（让开关名副其实）

### F4 · 禁用服务商/模型后系统默认照发 ✅待修

- **问题**：enabled 只过滤聊天切换菜单（`LexicalComposer.tsx:1210/1228`）；`buildTurnOptions` 主链路无 enabled 检查——禁用系统默认服务商/模型后请求照发；删除默认模型则 `settings.modelId` 悬空照发已删 id 且元数据静默归零；「设为默认」对禁用项无守卫。
- **修复**：
  1. buildTurnOptions 链路检查 enabled，禁用 → 发送时报错「当前服务商/模型已禁用」，composer 模型 chip 显示警告态；
  2. `handleSetAsDefault` 加守卫：禁用的服务商/模型不允许设为默认（按钮置灰）；
  3. 禁用默认模型（且它是 settings.modelId）→ 提示并自动迁移到该服务商下一个启用模型；
  4. 删除默认模型 → 同步迁移 settings.modelId（现在只迁移 provider.defaultModelId）。
- **验证**：CDP——禁用默认服务商后发送得到明确报错；设为默认按钮对禁用项置灰；删除默认模型后设置自动切到下一个启用模型。
- **风险**：中——行为收紧（禁用从「照常能用」变「明确报错」，正是开关本义）。

### F5 · Ollama 免 Key 陷阱：绿点亮但实际走 faux 本地假流 ✅待修

- **问题**：UI 提示「本地 Ollama 无需填写 API Key」（ProviderDetailCard:429）、导航绿点豁免 ollama（ProviderNavigation:53），但 `App.tsx:333` `isDemo = 无Key` → faux 演示假流，真实请求一个字节不发。custom 本地网关（LM Studio 类免 Key）同理。
- **修复**：`isDemo` 判定改为——无 Key 且（id==="ollama" 或 custom 且有 baseUrl）仍走真实请求（网关要鉴权则如实 401）；只有「完全未配置」才进 demo。
- **验证**：CDP——免 Key 网关发送 → 真实请求（401 如实显示而非假回复）。
- **风险**：低——免 Key 网关从假流变真流；配错网关从假流变 401 报错，都更诚实。

### F6 · UI 显示 Default 实发 Max ✅待修

- **问题**：未声明 effort 元数据的模型跳过档位对齐 effect（`App.tsx` 守卫 `currentModel?.effort`），任务档位残留 xhigh/max 时实际请求发 Max，按钮回落显示"Default"（LexicalComposer currentOpt 兜底链）。
- **修复**：① 对齐 effect：未声明 effort 时用隐式档位集（default/low/medium/high）同样收敛残留 xhigh/max；② currentOpt 显示实际生效档位。
- **验证**：单测对齐逻辑；CDP——任务档位 xhigh → 切无 effort 元数据模型 → 按钮与请求一致。
- **风险**：低。

### F7 · 记忆/子代理 enabled 运行时不复查 + 候选列表不过滤 ✅待修

- **问题**：`modelResolution.ts:31-44`、`subagentDefinitions.ts:597-613` 运行时只查存在性+apiKey；`AgentSubagentsPage.tsx:64-80` 候选列表不过滤 enabled。
- **修复**：运行时加 enabled 检查（禁用 → 抛错/回落，与「apiKey 为空抛错」同风格）；候选列表过滤禁用项。
- **验证**：单测 + CDP——禁用已钉选的记忆模型 → 整理任务明确报错。
- **风险**：低。

---

## 四、批次 3：装饰性清理（含 D2/D3 决策执行）

| 编号 | 项 | 位置 | 处置 | 验证 |
|---|---|---|---|---|
| F8 | summaryModel 会话摘要选择器 | hubSettingsStore.ts:35 / MemorySettingsDrawer.tsx:125,249 | 按 D2：删 UI+字段（kv 旧数据兼容读取） | tsc + 设置页无该项 |
| F9 | serverPolicy allow/ask/deny | mcpTypes.ts:50 / McpServersForm.tsx:102 | 按 D3：删 UI+字段+normalize 清理 | tsc + MCP 页无该项 |
| F10 | McpSettings.selected 恒空字段 | mcpTypes.ts:48 | 删字段（normalize/hydrate 同步清理） | tsc |
| F11 | MemoryScheduleSettings.timezone | hubSettingsStore.ts:30 | 删字段 | tsc |
| F12 | reinagent-update-endpoint 仅回显 | AppUpdaterCard.tsx:15,35,43 | 接线为「检查更新」默认端点预填值（真消费），或保持现状（待选） | 手动 |
| F13 | hideToTray UI 写死 useState(true) | SettingsPage.tsx:66 | Rust 加 `get_hide_to_tray` 命令，UI 初始化回读 | CDP：关闭→重启→开关显示关 |
| F14 | reinagent-preview-theme 死键 | preview/useTheme.ts（hook 无调用方） | 删除死文件 | tsc |
| F15 | modelFactory 93-99 陈旧注释块 | modelFactory.ts | ✅已完成（2026-10-05，随 F1 一并改写，与实际行为一致） | 人工 |
| F16 | isReasoningSupported=true 死分支 + THINKING_OPTIONS 无 off | App.tsx:288 / LexicalComposer.tsx:1311 | 可选：加 off 档（真可关推理）或删死分支（待选） | 单测 |

---

## 五、暂不修（记录在案）

| 项 | 理由 |
|---|---|
| 连通性测试与真实链路结构性分歧（非流式 vs Rust 流式反代、google key query vs header 形态、探测 max_tokens=1 vs 真实大值） | 根治需流式探测，成本高收益低；探测横幅已能暴露多数问题（anthropic 双 /v1 案例已修） |
| ModelEditModal 上下文快捷预设按钮（32K~2M） | 用户主动点选的填充辅助，非自动猜测 |
| fauxSource 演示模式合成流 | 文案逐字标注「[演示模式 · 合成数据]」，符合诚实原则（F5 只修误入场景） |
| 状态绿点判定粗粒度 | 随 F5 对齐 isDemo 语义后，绿点=「会发真实请求」基本成立 |

---

## 六、批次 4：第二轮审计 · 静默设计专项（2026-10-05 复扫新发现，待确认）

> 背景：F2 修复后按「全库不留静默设计」指令复查。已跳过批次 2/3 已立案项。新发现按危险级别排列；标注「✅已亲验」的经过人工代码复核。

### 高危

| 编号 | 问题 | 位置 | 修复方案 | 验证 |
|---|---|---|---|---|
| **F17** | **草稿首轮审批门被绕过**✅已亲验：新建任务首条消息 createTask 落库了草稿所选 approvalMode，但 buildTurnOptions 闭包里 activeTask 仍为 null → `?? "full"` 冻结进首轮（无审批直接执行工具 + maxSteps 0 无上限）；UI 徽标显示 ask 实跑 full。`App.tsx:120` 注释「缺省回退全局默认」与实现矛盾（thinkingLevel 走全局，唯独 approvalMode 硬编码 full） | App.tsx:120 + sendNow 1313-1363 | ① `?? "full"` 改 `?? 全局默认 approvalMode`；② buildTurnOptions 改为发送时从 store 实时读任务记录（或 sendNow 显式传新建任务的 approvalMode/thinkingLevel 覆盖），消除闭包冻结 | 单测：草稿提升轮的 turn options 断言任务 approvalMode；CDP：草稿选 ask → 首轮写文件必须挂审批 |
| **F18** | **provider_config.json 读取失败 → 空白预设立即写盘覆盖用户全部配置（含 Key）**✅已亲验：loadProvidersConfigFromDisk catch → `list=[]` → 初始化分支 `saveProvidersConfigToDisk` 持久化覆盖，不可恢复 | types.ts:149-176 | 读失败（invoke 异常/JSON 解析失败）≠ 文件不存在：区分两者——解析失败时抛错并在设置页横幅明示，**禁止自动写盘**；仅确认文件不存在时才初始化预设 | 单测：损坏 JSON → 不写盘 + 报错态；CDP：手改坏文件 → 重启见横幅而非空配置 |
| **F19** | **mcp_servers.json 损坏 → 空表静默回写覆盖用户 MCP 配置**（与 F18 同构，Rust `load_servers` 失败静默返回空 + 前端任意设置变更整表回写） | src-tauri/mcp.rs:103-109 + hubSettingsStore.ts:144-154 | Rust load 失败返回结构化错误（非空 Vec）；前端 hydrate 失败时置 degraded 态并禁止后续整表回写 | 单测 + 手动：损坏文件 → 启动报错横幅 |
| **F20** | **自动化派发凭证错投**：providerId 与 modelId 独立回退可拼出「A 家供应商+B 家模型」；供应商 Key 为空时把 legacy settings 的 Key 发往该供应商 baseUrl | App.tsx:839-868 | 供应商与模型必须同源解析（provider 存在 → 模型必须属于它，否则该次运行 failed 并注明原因）；Key/baseUrl 只取所配供应商，缺则 failed，禁止跨源拼接 | 单测 + 手动：构造缺 model 的 automation → run failed 带明确错误 |

### 中危

| 编号 | 问题 | 位置 | 修复方案 |
|---|---|---|---|
| F21 | classic hook 执行失败被完全吞掉（连 console 都无）——防护型 hook 失效时工具照常执行 | hooksRuntime.ts:324-330（消费方只读 blocked，从不看 runs[].error） | hook 执行错误 → toast/审批区红点（对齐既有审批反馈通道）；错误进 runs 已有，补消费端 |
| F22 | 助手人设查不到时静默不注入（连 warn 都无）——整轮以通用助手运行 | runAgentTurn.ts:535-546 | 「查不到」分支补 warn；回合事件里带一条人设降级提示（模型/用户可见） |
| F23 | 会话/kv 持久化失败仅 console——重启丢数据无感知（settingsStore 有 degraded 通道，db.ts/conversationPool 没有） | conversationPool.ts:248-250 / storage/db.ts | 复用 settingsStore 的 degraded/warning UI 通道：持久化失败 → 顶栏持久化警示 |
| F24 | 服务商配置写盘失败静默（设置页假成功） | types.ts:231-233（Promise 照常 resolve） | saveProvidersConfigToDisk 返回成功/失败；失败时设置页 toast 如实报错 |
| F25 | automation schedule_rule 损坏 → 静默改写为每天 09:00 真实触发 | src-tauri/automation.rs:189-196 | 解析失败 → 该自动化标记 error 状态 + last_error，**不猜默认计划**；next_run 置 NULL 且不参与 claim（区别于「立即触发」） |
| F26 | 记忆抽取独立模型解析失败静默回落主模型（organizer 同错误却是显式抛错，双路径语义分叉） | conversationPool.ts:651-663 | 统一为可见失败（错误进抽取状态并跳过本轮，注明原因），或统一回落+双路径声明一致（待选） |

### 低危（列出，随批顺带或接受）

L1 `automation_run_finished` 空 catch 补 warn（App.tsx:877-879）；L2 `getInitialTasks` 单行损坏静默丢任务补 console.error（useAppStore.ts:165-172）；L3 `updateModelEffortDefaultLevel` 找不到目标静默 return 补提示（types.ts:246-261）；L4 `API_FORMAT_TO_TYPE ?? "openai"`（下游已兜住，改注释）；L9 checkpoint_list 失败空列表与「无回退点」区分（checkpointRewind.tsx:180-181）；L12 conversationPool `getOptions` 不可达兜底改断言抛错（:300-310）。**ProviderForm.tsx 为死组件**（无引用方），建议删除（内含写死 catalog 默认模型的 onChange）。

---

## 七、执行顺序与验收（批次 1-4 原有编号顺延；每批完成后同标准验收）

1. **顺序**：批次 1 → 批次 2 → 批次 3。F1 与 F15 同改一处必须同批；每批完成后跑全量验收再进下一批。
2. **每批验收**：
   - `bunx tsc --noEmit` 0 错误；
   - `bun run test:providers / test:chat / test:settings / test:agent / test:hub`（及其余全部测试脚本）全绿；
   - 涉及 Rust 的（F13）加 `cargo check`；
   - Tauri 桌面端 CDP 实测各修复项的「验证」列场景；
   - 同步更新 `PROJECT_CONTEXT.md` 对应章节。
3. **涉及文件预估**：批次 1 约 5 个文件；批次 2 约 6 个文件；批次 3 视 D2/D3 决策 4~8 个文件。
