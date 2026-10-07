# ReinAgent 修复计划表 —— 写死数据与装饰性功能审计（2026-10-05）

> **文档定位**：2026-10-05 全库审计（三路并行扫描 + 人工逐条复核）产出的修复计划。
> 审计范围：装饰性设置（UI 有、运行时零消费）、写死数据（违反 No-Fallback 铁律）、失效开关（操作后不改变运行时行为）。
> **状态**：批次 0（F17/F18/F19，1d0e563）、批次 1（F1/F2/F3，f5a47cf / f003127）、批次 2（F4-F7，b1e3b8a）**已完成**；批次 3 中 D2/D3 已定稿并完成清理（F8/F9，2026-10-07）；批次 4 其余（F20-F26、L1-L12）待确认。
> **维护纪律**：完成任务后勾选 `[x]`、写完成日期与提交号，并同步 `PROJECT_CONTEXT.md`。
>
> **⚠️ 复核修订（2026-10-05 晚，逐条对照当前工作区亲验）**：审计初稿成文于修复提交 `f5a47cf`（max_tokens 注入）与 `f003127`（no silent DeepSeek fallback）**之前**，故 F1/F3 的"问题"描述已过时（实际已修）；F18/F24 文件路径写错（`src/lib/providers/types.ts` 不存在，实为 `src/components/settings/model-provider/types.ts`）；F22 判定有误（warn 已存在）；另有若干行号/表述需校准。**已按下文逐条订正，开工请以本版为准。**

---

## 一、决策点（需先拍板）

| # | 决策 | 推荐方案 | 备选方案 | 备注 |
|---|---|---|---|---|
| **D1** | max_tokens：模型元数据未知时发不发 32000 请求级兜底 | **发（已按参照源码定稿）**——LiveAgent 同场景实测设计：未知时注入 `model.maxTokens` 兜底值随请求发出（deepseek 兜底就是 32K，生产环境验证过）；ZCode 的 maxOutputTokens 为模型配置一等 option（完整 schema `max` 必填正值），每请求经 option-map 注入，「声明即注入」无静默省略路径。本方 32000 兜底 + 注释意图正是照此模式写的，只差注入最后一步 | 不发（未知不捏造）——但会被 LiveAgent/ZCode 双参照的设计否决 | F1 依赖此项；已定稿：**发** |
| **D2** | 记忆设置「会话摘要模型」（summaryModel） | **删除 UI 与字段**（✅已定稿执行，2026-10-07，本应用无摘要功能消费它，属 LiveAgent 移植残留；统一由 organizerModel 接管） | 接线到记忆整理管线 | F8 依赖此项（✅已完成） |
| **D3** | MCP 服务器策略（allow/ask/deny） | **删除 UI 与字段**（✅已定稿执行，2026-10-07，消灭失效死开关，保留任务级 activeTask.toolPolicies 独立运行） | 接线：工具执行前按策略拦截 | F9 依赖此项（✅已完成） |

---

## 二、批次 1：数据安全（高危）

### F1 · max_tokens 防截断意图从未接线 ✅已完成（2026-10-05，提交 f5a47cf）

- **问题（⚠️ 2026-10-05 复核订正：以下为修复前状态，现均已不成立）**：`modelFactory.ts` 曾有一段注释声称 openai 协议未知时「必须发送」max_tokens（防网关默认上限 ~3072 半途截断），但当时链路里没有注入——`pi-agent-core/dist/agent-loop.js:235` 调 stream 时透传的 options 里没有 maxTokens（runAgentTurn → streamFnAdapter → pi-agent-core 全链不传）；pi-ai openai 适配器 `params.max_tokens = options.maxTokens`（undefined → 不发），responses 适配器同。当时只有 anthropic 适配器 `?? model.maxTokens` 兜底发 32000。
- **修复（已落地，提交 f5a47cf）**：
  1. `src/lib/providers/runAgentTurn.ts` `wrapStreamWithProxiedFetch` 现在会在调用原 stream 前注入 `maxTokens`——见 [runAgentTurn.ts:286-291](src/lib/providers/runAgentTurn.ts)，`resolveMaxTokens` 定义在同文件 253-262 行：`请求值 > 0 ? Math.min(请求值, modelMax) : modelMax`，即未知时发 `model.maxTokens`（32000 兜底或真实元数据值），已知时取两者较小值；
  2. D1 已定稿：**未知也发 32000 兜底**（LiveAgent 生产验证 + ZCode「声明即注入」哲学双参照）；
  3. `modelFactory.ts` 注释块已同步改写（见 F15），并注明与 LiveAgent 的差异：LiveAgent 按供应商差异化兜底（claude 32K/codex 142K/gemini 65K/xai 142K/deepseek 32K，见其 `PROVIDER_FALLBACK_LIMITS`），本方一刀切 32000，后续可按供应商差异化。
- **验证**：① A2 测试断言：**已知元数据模型请求带真实值、未知元数据模型请求带 32000 兜底值**（订正——初稿误写「未知不发」，与 D1 定稿方向相反）；② 实测：未知元数据模型请求体带 max_tokens=32000，已知模型带真实值。
- **风险**：低。已知元数据模型从「从不发」变「发真实值」，属元数据本义；官方 API 均接受 ≤ 上限的值。

### F2 · buildModel 兜底链静默发 DeepSeek ✅已完成（2026-10-05，提交 f003127；含 titleGenerator 与 App 调用点）

- **问题（修复前状态）**：`src/lib/providers/modelFactory.ts:92-95` —— custom 服务商（catalog 外 id）配了 Key 但 modelId/baseUrl 留空时，`config.modelId || meta.defaultModelId` + `getProviderMeta || PROVIDERS[0]` 把请求静默发往 `api.deepseek.com` + `"deepseek-chat"`，用用户自己的 Key。
- **修复（已落地，提交 f003127）**：
  1. `buildModel`（[modelFactory.ts:92-129](src/lib/providers/modelFactory.ts)）：modelId 为空 → 抛错「未选择模型」；provider 为空 → 抛错；provider 在 catalog 外（`custom-*`）且 baseUrl 空 → 抛错；apiFormat 缺失/非法 → 抛错；
  2. App 层发送入口（composer 守卫）提前拦截给友好提示 + 「未配置默认模型」引导。
- **验证**：① 单测：空 modelId 抛错、custom 空 baseUrl 抛错、preset 空 baseUrl 走 catalog 默认（合法）不抛；② 实测：无模型新任务发送 → 明确错误行。
- **风险**：中——全新安装从「能跑（打 deepseek-chat）」变「必须先选模型」，属行为收紧（fail-fast 本义）。

### F3 · titleGenerator 协议误判 + 用 legacy settings ✅已完成（2026-10-05，提交 f003127；复核订正：初稿误标"待修"）

- **问题（修复前状态，现均已不成立）**：`src/lib/chat/titleGenerator.ts:89-105` —— custom id 恒落 deepseek meta，anthropic 格式供应商的标题请求误走 `/v1/chat/completions`；调用点 `App.tsx:1336` 传 legacy 全局 settings 而非活动任务配置。
- **修复（已落地，提交 f003127）**：
  1. 协议判定改由 `config.apiFormat`（设置页所选，经 `API_FORMAT_TO_WIRE`）驱动，catalog 预设回落 `meta.api`，两者皆无 → 本地降级不发请求——见 [titleGenerator.ts:89-110](src/lib/chat/titleGenerator.ts)；
  2. 调用点改为从 `sessionProviderId` 解析 provider 并传其 `apiFormat`（App.tsx:1339-1345），legacy 全局设置仅作会话值为空时的兜底；
  3. modelId 为空直接本地降级标题（不发请求）。
- **验证**：已由 f003127 单测覆盖（anthropic 格式 custom 供应商标题请求打到 `/v1/messages`；空 modelId → 本地标题）。
- **风险**：低。

---

## 三、批次 2：开关语义（让开关名副其实）

### F4 · 禁用服务商/模型后系统默认照发 ✅已完成（2026-10-05，提交 b1e3b8a）

- **问题（修复前状态，现均已不成立）**：enabled 只过滤聊天切换菜单（`LexicalComposer.tsx:1210-1237`，`enabledProviders`/`enabledModels` 仅用于构建切换菜单）；`buildTurnOptions`（`App.tsx:783-832`）主链路无 enabled 检查——禁用系统默认服务商/模型后请求照发；删除默认模型则 `settings.modelId` 悬空照发已删 id 且元数据静默归零；「设为默认」对禁用项无守卫。
- **复核补充**：`handleDeleteModel`（`ProviderDetailCard.tsx:212-234`）只重算该服务商自身的 `defaultModelId`，**从不触碰全局 `settings.modelId`**；而 `handleDeleteProvider`（`ModelProviderSettings.tsx:115-134`）会重指派默认——两者不对称，佐证缺口属实。
- **修复（已落地，提交 b1e3b8a）**：
  1. `handleSend` 新增 enabled 守卫：当前服务商或模型被禁用 → toast 明确提示并早退，绝不发请求（对齐既有 hook-block 样式；不走 isDemo 以免伪装成演示）；
  2. `handleSetAsDefault` 加守卫：禁用的服务商/模型不允许设为系统默认；
  3. 删除模型若恰是 `settings.modelId` → 新增 `onMigrateDefaultModel` 迁移全局默认到同供应商下一个可用模型（补齐相对 `handleDeleteProvider` 缺失的对称迁移）。⚠️ 与计划的差异：计划点 3「**禁用**默认模型时自动迁移」未做——禁用场景由上述发送守卫以明确报错覆盖（用户知情后自行切换/迁移），仅删除路径做自动迁移。
- **验证**：CDP——禁用默认服务商后发送得到明确报错；设为默认按钮对禁用项置灰；删除默认模型后设置自动切到下一个启用模型。
- **风险**：中——行为收紧（禁用从「照常能用」变「明确报错」，正是开关本义）。

### F5 · Ollama 免 Key 陷阱：绿点亮但实际走 faux 本地假流 ✅已完成（2026-10-05，提交 b1e3b8a）

- **问题（修复前状态，现均已不成立）**：UI 提示「本地 Ollama 无需填写 API Key」（`ProviderDetailCard.tsx:429`）、导航绿点豁免 ollama（`ProviderNavigation.tsx:53`）；但 `App.tsx:330-333` `activeApiKey = currentProvider?.apiKey ?? settings.apiKey ?? ""` → `isDemo = activeApiKey.trim().length === 0` → faux 演示假流，真实请求一个字节不发。custom 本地网关（LM Studio 类免 Key）同理。
- **修复（已落地，提交 b1e3b8a）**：
  1. 新增 `providerAllowsMissingApiKey` / `isProviderUsable` 作为免 Key 判定**单一真相源**，收编原散落 5 处的 `id === "ollama"` 硬编码（testConnectivity / fetchModels / ProviderNavigation / ProviderDetailCard）；
  2. `isDemo` 改为「无 Key **且需要 Key**」，主链路与自动化派发同口径：免 Key 本地网关走真实请求，网关要鉴权则如实 401；
  3. 连带修复：faux 会跳过记忆管线（conversationPool source === "faux"），旧行为下 Ollama 会话的记忆提取被静默禁用，一并恢复；
  4. `ProviderDetailCard` 占位文案改为通用「本地网关通常无需 API Key」。
- **验证**：CDP——免 Key 网关发送 → 真实请求（401 如实显示而非假回复）。
- **风险**：低——免 Key 网关从假流变真流；配错网关从假流变 401 报错，都更诚实。

### F6 · UI 显示 Default 实发 Max ✅已完成（2026-10-05，提交 b1e3b8a）

- **问题（修复前状态，现均已不成立）**：未声明 effort 元数据的模型跳过档位对齐 effect（`App.tsx:297` 守卫 `isReasoningSupported && currentModel?.effort`；`isReasoningSupported` 硬编码 true 于 287 行），任务档位残留 xhigh/max 时实际请求发 Max，按钮回落显示 "Default"。
- **复核校准**：`LexicalComposer.tsx` 的 `currentOpt` 回落链（1311-1327）是**数据驱动**的：无 effort 元数据时 `supportedList` 取默认集 `[default,low,medium,high]`，`visibleOptions` 首项是 THINKING_OPTIONS[0]（label "Default"）——因此"显示 Default"是默认集首位的结果，**并非硬编码回落成 "Default"**；且 xhigh/max 对未知模型会被排除。症状成立，但修复点应落在"对齐 effect 的守卫条件"上，而非改 `currentOpt` 回落链。
- **修复（已落地，提交 b1e3b8a）**：新增 `IMPLICIT_EFFORT_LEVELS`（default/low/medium/high）与 `resolveSupportedEffortLevels` 单一真相源，收编两处重复兜底数组；App 对齐 effect 去掉 `currentModel?.effort` 守卫——未声明元数据的模型同样收敛残留的 xhigh/max；`LexicalComposer` 改用同一函数取档位集，显示与实发同源。
- **验证**：单测对齐逻辑；实测——任务档位 xhigh → 切无 effort 元数据模型 → 按钮与请求一致。
- **风险**：低。

### F7 · 记忆/子代理 enabled 运行时不复查 + 候选列表不过滤 ✅已完成（2026-10-05，提交 b1e3b8a）

- **问题（修复前状态，现均已不成立）**：`modelResolution.ts:33-39`、`subagentDefinitions.ts:603-607` 运行时只查存在性+apiKey（无 enabled 检查）；`AgentSubagentsPage.tsx:65-81` 候选列表 `flatMap` 不过滤 provider/model 的 enabled。
- **修复（已落地，提交 b1e3b8a）**：
  1. `resolveIndependentMemoryModelDeps` / `resolveSubagentModelPin` 增加 enabled 与模型存在性复查（禁用/已删 → 抛错，与既有「apiKey 为空抛错」同风格），并接上免 Key 判定；
  2. `AgentSubagentsPage.loadModelOptions` 过滤已禁用供应商与模型；
  3. 测试：`modelResolution.test.mjs` 扩充 F5/F7 用例（10 项，含免 Key 判定真相源），并接入 test:hub（此前未被任何脚本引用）。
- **验证**：单测 + CDP——禁用已钉选的记忆模型 → 整理任务明确报错。
- **风险**：低。

---

## 四、批次 3：装饰性清理（含 D2/D3 决策执行，✅全部完成于 2026-10-07）

| 编号 | 项 | 位置 | 处置 | 验证 |
|---|---|---|---|---|
| **F8** ✅已完成（2026-10-07） | summaryModel 会话摘要选择器 | hubSettingsStore.ts / MemorySettingsDrawer.tsx | 按 D2：已删 UI 标题/分割线/ModelPicker 组件与 MemorySettings 字段；抽取与整理统一由 organizerModel 接管 | tsc + 设置抽屉无该项 + 全量单测通过 |
| **F9** ✅已完成（2026-10-07） | serverPolicy allow/ask/deny | mcpTypes.ts / McpServerCard.tsx / McpServersForm.tsx / hubSettingsStore.ts | 按 D3：已删 UI 卡片底部的 ToolPolicyToggle 及 McpSettings.serverPolicy 字段。任务级审批策略 toolPolicies 独立运行不受影响 | tsc + MCP 卡片无该项 + 全量单测通过 |
| **F10** ✅已完成（2026-10-07） | McpSettings.selected 恒空字段 | mcpTypes.ts / hubSettingsStore.ts | 已删字段及相关 normalize / hydrate 传参，保持 MCP 类型极简 | tsc + 全量单测通过 |
| **F11** ✅已完成（2026-10-07） | MemoryScheduleSettings.timezone | hubSettingsStore.ts | 已从接口与默认值中删除零消费的 timezone 字段 | tsc + 全量单测通过 |
| **F12**（保留） | reinagent-update-endpoint 仅回显 | AppUpdaterCard.tsx:15,35,43 | 复核确认：确已传给 `update_check`/`update_install`（真消费），且在 useEffect 中回读。作为更新源预填持久化键规范保留 | 手动 |
| **F13** ✅已完成（2026-10-07） | hideToTray UI 写死 useState(true) | SettingsPage.tsx:66 | 组件挂载时调用 `get_hide_to_tray` IPC 回读 SQLite 真实持久化设置，Linux & Windows 托盘对齐 | 实测：重启后开关状态保持同步 |
| **F14** ✅已完成（2026-10-07） | reinagent-preview-theme 死键 | preview/useTheme.ts | 删除了未调用的 `useTheme()` hook 与废弃 STORAGE_KEY，保留 PreviewPane 必需类型与工具函数 | tsc + 0 引用报错 |
| **F15** ✅已完成（2026-10-05） | modelFactory 93-99 注释块 | modelFactory.ts:93-100 | 变更历史注释（保留） | 人工 |
| **F16** ✅已完成（2026-10-07） | isReasoningSupported 档位 + THINKING_OPTIONS 无 off | App.tsx / LexicalComposer.tsx:127 | THINKING_OPTIONS 补齐 `off` 档，选中 `off` 时向下透传 `thinkingLevel: "off"`，彻底关闭思考模式 | tsc + 单测 + 运行时透传 |
| **死组件** ✅已完成（2026-10-07） | ProviderForm.tsx 死组件 | src/components/settings/ProviderForm.tsx | 彻底删除全库零引用的旧表单组件 | tsc + 文件移除 |

---

## 五、暂不修（记录在案）

| 项 | 理由 |
|---|---|
| 连通性测试与真实链路结构性分歧（非流式 vs Rust 流式反代、google key query vs header 形态、探测 max_tokens=1 vs 真实大值） | 根治需流式探测，成本高收益低；探测横幅已能暴露多数问题（anthropic 双 /v1 案例已修） |
| ModelEditModal 上下文快捷预设按钮（32K~2M） | 用户主动点选的填充辅助，非自动猜测 |
| fauxSource 演示模式合成流 | 文案逐字标注「[演示模式 · 合成数据]」，符合诚实原则（F5 只修误入场景） |
| 状态绿点判定粗粒度 | 随 F5 对齐 isDemo 语义后，绿点=「会发真实请求」基本成立 |

---

## 六、批次 4：第二轮审计 · 静默设计专项（✅已全部完成于 2026-10-07）

### 高危

| 编号 | 问题 | 位置 | 修复方案 | 验证 |
|---|---|---|---|---|
| **F17** ✅已完成（2026-10-05） | 草稿首轮审批门被绕过 | App.tsx:117-120 | 回退全局默认审批模式，实时解析任务 approvalMode | 单测通过 |
| **F18** ✅已完成（2026-10-05） | provider_config.json 读取失败覆盖配置 | model-provider/types.ts | 读失败抛错且绝不写盘，设置页显示错误横幅 | 单测通过 |
| **F19** ✅已完成（2026-10-05） | mcp_servers.json 损坏空表覆盖 | src-tauri/mcp.rs / hubSettingsStore.ts | Rust 返回 Result，前端加 mcpDegradedError 守卫 | Rust 单测通过 |
| **F20** ✅已完成（2026-10-07） | **自动化派发凭证错投**：providerId 与 modelId 跨源独立拼装 | App.tsx:896-950 | 严格实行同源校验：model 必须属于 provider，缺失或不可用时立即判定 failed 并汇报原因，拒绝跨源拼装 | tsc + 调度同源测试 |

### 中危

| 编号 | 问题 | 位置 | 修复方案 | 验证 |
|---|---|---|---|---|
| **F21** ✅已完成（2026-10-07） | classic hook 执行失败被吞掉 | hooksRuntime.ts:405-420 | 捕获错误时输出 console.warn 并写入 `outcome.hasError`，避免安全钩子隐秘崩溃 | tsc + 单测通过 |
| **F22**（已关闭） | persona load 降级 | runAgentTurn.ts:533-545 | 判定有误，代码中已有 console.warn | 人工复核 |
| **F23** ✅已完成（2026-10-07） | 会话/kv 持久化失败仅 console 无感知 | conversationPool.ts / storage/db.ts / useAppStore.ts / App.tsx | 暴露 `storageDegradedError` 状态通道，写盘失败时顶栏红条告警 | tsc + 状态响应测试 |
| **F24** ✅已完成（2026-10-07） | 服务商配置写盘失败静默 | model-provider/types.ts / ModelProviderSettings.tsx | saveProvidersConfigToDisk 返回布尔/抛错；设置页 toast 如实报错 | tsc + 写盘失败告警 |
| **F25** ✅已完成（2026-10-07） | automation schedule_rule 损坏静默替换为每天 09:00 真实触发 | src-tauri/src/automation.rs:183-205, 438-455 | 解析失败标记 `lifecycle_status = 'error'` 与 `last_error`，next_run 置 NULL，claim 排除 error 状态 | cargo test 4/4 绿 |
| **F26** ✅已完成（2026-10-07） | 记忆抽取独立模型解析失败静默回落主模型 | conversationPool.ts:655-675 | 独立模型配置失效时终止当轮抽取，记录警告，绝不擅自换为主模型消耗 Token | 单测通过 |

### 低危（✅全部完成）

- **L1** `automation_run_finished` catch 补 warn（App.tsx）
- **L2** `getInitialTasks` 解析单行损坏记录 `console.error`（useAppStore.ts）
- **L3** `updateModelEffortDefaultLevel` 目标未找到增加 warning（model-provider/types.ts）
- **L4** `API_FORMAT_TO_TYPE` 补充下游 buildModel fail-fast 校验注释（modelResolution.ts）
- **L9** `checkpoint_list` 失败记录警告（checkpointRewind.tsx）
- **L12** `conversationPool.getOptions` 缺失直接断言抛错，消除假 options 兜底（conversationPool.ts）
- **死组件** 移除 `ProviderForm.tsx`（已清理）

---

## 七、执行顺序与验收（批次 1-4 原有编号顺延；每批完成后同标准验收）

> ⚠️ **2026-10-05 复核后的顺序调整（重要）**：批次 4 的三项高危 F17/F18/F19 经亲验**全部属实**，且分别会造成「**审批门被绕过**」与「**用户配置被覆盖丢失**」——危害等级高于批次 1-3 的多数项。建议把 F17/F18/F19 提到最前（"批次 0"）先修，再按原顺序推进。同时 F1、F3 已修完（见上），F22 判定有误已关闭，实际待办范围已收窄。
>
> **2026-10-06 进度补记**：批次 0（F17/F18/F19，提交 1d0e563）与批次 2（F4-F7，提交 b1e3b8a）**已完成**，上文各节已补勾并记录与计划的差异点。

1. **顺序**：~~批次 1 → 批次 2 → 批次 3~~ **（订正）批次 0（F17/F18/F19 数据安全与审批，✅ 1d0e563）→ 批次 2（开关语义，✅ b1e3b8a）→ 批次 3（装饰性清理，待 D2/D3 拍板）→ 批次 4 其余。** F15 已随 F1 完成；F1/F3/F17/F18/F19/F4-F7 已完成不再排期。
2. **每批验收**：
   - `bunx tsc --noEmit` 0 错误；
   - `bun run test:providers / test:chat / test:settings / test:agent / test:hub`（及其余全部测试脚本）全绿；
   - 涉及 Rust 的（F13/F19/F25）加 `cargo check`；
   - Tauri 桌面端实测各修复项的「验证」列场景（不再依赖 CDP 断言，按 PROJECT_CONTEXT.md 既有实测口径）；
   - 同步更新 `PROJECT_CONTEXT.md` 对应章节。
3. **涉及文件预估**：批次 0（F17/F18/F19）约 4 个文件（App.tsx / model-provider/types.ts / mcp.rs / hubSettingsStore.ts）；批次 2 约 6 个文件；批次 3 视 D2/D3 决策 4~8 个文件。
