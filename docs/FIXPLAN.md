# ReinAgent 修复计划表 —— 写死数据与装饰性功能审计（2026-10-05）

> **文档定位**：2026-10-05 全库审计（三路并行扫描 + 人工逐条复核）产出的修复计划。
> 审计范围：装饰性设置（UI 有、运行时零消费）、写死数据（违反 No-Fallback 铁律）、失效开关（操作后不改变运行时行为）。
> **状态**：批次 0（F17/F18/F19，1d0e563）、批次 1（F1/F2/F3，f5a47cf / f003127）与批次 2（F4-F7，b1e3b8a）**已完成**（2026-10-06 补勾）；批次 3 待 D2/D3 拍板后开工（D1 已定稿：发）；批次 4 其余（F20-F26、L1-L12）待确认。
> **维护纪律**：完成任务后勾选 `[x]`、写完成日期与提交号，并同步 `PROJECT_CONTEXT.md`。
>
> **⚠️ 复核修订（2026-10-05 晚，逐条对照当前工作区亲验）**：审计初稿成文于修复提交 `f5a47cf`（max_tokens 注入）与 `f003127`（no silent DeepSeek fallback）**之前**，故 F1/F3 的"问题"描述已过时（实际已修）；F18/F24 文件路径写错（`src/lib/providers/types.ts` 不存在，实为 `src/components/settings/model-provider/types.ts`）；F22 判定有误（warn 已存在）；另有若干行号/表述需校准。**已按下文逐条订正，开工请以本版为准。**

---

## 一、决策点（需先拍板）

| # | 决策 | 推荐方案 | 备选方案 | 备注 |
|---|---|---|---|---|
| **D1** | max_tokens：模型元数据未知时发不发 32000 请求级兜底 | **发（已按参照源码定稿）**——LiveAgent 同场景实测设计：未知时注入 `model.maxTokens` 兜底值随请求发出（deepseek 兜底就是 32K，生产环境验证过）；ZCode 的 maxOutputTokens 为模型配置一等 option（完整 schema `max` 必填正值），每请求经 option-map 注入，「声明即注入」无静默省略路径。本方 32000 兜底 + 注释意图正是照此模式写的，只差注入最后一步 | 不发（未知不捏造）——但会被 LiveAgent/ZCode 双参照的设计否决 | F1 依赖此项；已定稿：**发** |
| **D2** | 记忆设置「会话摘要模型」（summaryModel） | **删除 UI 与字段**（本应用无摘要功能消费它，属 LiveAgent 移植残留；kv 旧数据保留兼容读取） | 接线到记忆整理管线 | F8 依赖此项 |
| **D3** | MCP 服务器策略（allow/ask/deny） | **删除 UI 与字段**（接线需另立「MCP 工具执行审批门」项目，工作量大） | 接线：工具执行前按策略拦截 | F9 依赖此项 |

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

## 四、批次 3：装饰性清理（含 D2/D3 决策执行）

| 编号 | 项 | 位置 | 处置 | 验证 |
|---|---|---|---|---|
| F8 | summaryModel 会话摘要选择器 | hubSettingsStore.ts:35,92 / MemorySettingsDrawer.tsx:125,249,384 | 按 D2：删 UI+字段（kv 旧数据兼容读取）。复核：全库无消费方属实 | tsc + 设置页无该项 |
| F9 | serverPolicy allow/ask/deny | mcpTypes.ts:50 / McpServersForm.tsx:102 | 按 D3：删 UI+字段+normalize 清理。⚠️ 复核校准：**通用 `toolPolicies` 链路是活的**（runAgentTurn.ts:365 消费），死的是 `McpSettings.serverPolicy` 本身——它从未被映射进 `mcp__<id>__<tool>` 工具名，勿与 toolPolicies 混为一谈 | tsc + MCP 页无该项 |
| F10 | McpSettings.selected 恒空字段 | mcpTypes.ts:48（hydrate 恒置 []，hubSettingsStore.ts:135） | 删字段（normalize/hydrate 同步清理） | tsc |
| F11 | MemoryScheduleSettings.timezone | hubSettingsStore.ts:30,94 | 删字段 | tsc |
| F12 | reinagent-update-endpoint 仅回显 | AppUpdaterCard.tsx:15,35,43 | ⚠️ 复核订正：**并非纯回显**——endpoint 值确已传给 `update_check`/`update_install`（真消费）；真正"只写不读"的是**该 KV 键**（仅用于下次预填）。故本项降级为"预填持久化键"语义，是否保留待选 | 手动 |
| F13 | hideToTray UI 写死 useState(true) | SettingsPage.tsx:66 | Rust `get_hide_to_tray` **已存在**（hide_to_tray.rs:42，lib.rs:162 已注册）——复核订正：只差前端初始化回读（无任何 TS 侧 invoke 它） | 实测：关闭→重启→开关显示关 |
| F14 | reinagent-preview-theme 死键 | preview/useTheme.ts | ⚠️ 复核校准：**死的是 `useTheme()` hook 与 `reinagent-preview-theme` 键**（hook 零调用方）；但**文件不算死**——`resolveTheme`/`Theme` 仍被 PreviewPane.tsx:54,563、previewPaneContent.tsx:22 等使用。故只删 hook+键，不删文件 | tsc |
| F15 | modelFactory 93-99 注释块 | modelFactory.ts:93-100 | ✅已完成（2026-10-05，随 F1 一并改写）。⚠️ 复核订正：该块现为**故意保留的变更历史注释**（写明"旧行为：…"），内容与当前代码一致，**不是错误注释**——标题"陈旧"一词应改为"变更历史注释（保留）" | 人工 |
| F16 | isReasoningSupported=true 死分支 + THINKING_OPTIONS 无 off | App.tsx:287 / LexicalComposer.tsx:120（THINKING_OPTIONS 定义；1311 为使用点） | 可选：加 off 档（真可关推理）或删死分支（待选） | 单测 |

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

> 背景：F2 修复后按「全库不留静默设计」指令复查。已跳过批次 2/3 已立案项。新发现按危险级别排列；标注「✅已亲验」的经过人工代码复核。**（2026-10-06 更新：三项高危 F17/F18/F19 已修复落地，提交 1d0e563；其余项待确认。）**

### 高危

| 编号 | 问题 | 位置 | 修复方案 | 验证 |
|---|---|---|---|---|
| **F17** ✅已完成（2026-10-05，提交 1d0e563） | **草稿首轮审批门被绕过**（修复前状态）✅已亲验（2026-10-05 复核：行号订正——注释在 App.tsx:117，硬编码在 120，sendNow 在 1313-1364）：新建任务首条消息 createTask 落库了草稿所选 approvalMode，但 buildTurnOptions 闭包里 activeTask 仍为 null → `?? "full"` 冻结进首轮（无审批直接执行工具 + maxSteps 0 无上限）；UI 徽标显示 ask 实跑 full。`App.tsx:117` 注释「缺省回退全局默认」与 `:120` 实现 `activeTask?.approvalMode ?? "full"` 矛盾（thinkingLevel 走全局 `?? thinkingLevel`，唯独 approvalMode 硬编码 full） | App.tsx:117-120 + sendNow 1313-1364 | **已落地（1d0e563）**：① `?? "full"` 改回退全局默认审批模式；② buildTurnOptions 新增 taskId 参数，发送瞬间从 store 实时解析任务 approvalMode/助手；sendNow/editResend/retry/远程发送均显式传 taskId，消除闭包冻结 | 单测：草稿提升轮的 turn options 断言任务 approvalMode；实测：草稿选 ask → 首轮写文件必须挂审批 |
| **F18** ✅已完成（2026-10-05，提交 1d0e563） | **provider_config.json 读取失败 → 空白预设立即写盘覆盖用户全部配置（含 Key）**（修复前状态）✅已亲验（2026-10-05 复核：**路径订正**，初稿路径不存在）：loadProvidersConfigFromDisk catch → `list=[]` → 初始化分支 `saveProvidersConfigToDisk` 持久化覆盖，不可恢复 | **src/components/settings/model-provider/types.ts:149-176**（初稿误写 src/lib/providers/types.ts） | **已落地（1d0e563）**：读失败（invoke 异常/JSON 损坏/结构非法）与文件不存在区分——前者抛错且**绝不写盘**，设置页新增错误横幅 + persistProviders 守卫（读取失败态下拒绝写盘）；仅确认文件不存在才初始化预设。调用方（App/CommitDialog/PromptEnhancementCard 等）不再静默吞错 | 单测：损坏 JSON → 不写盘 + 报错态；实测：手改坏文件 → 重启见横幅而非空配置 |
| **F19** ✅已完成（2026-10-05，提交 1d0e563） | **mcp_servers.json 损坏 → 空表静默回写覆盖用户 MCP 配置**（修复前状态；与 F18 同构，Rust `load_servers` 失败静默返回空 + 前端任意设置变更整表回写）✅已亲验：mcp.rs:104-108（读失败/解析失败均返回空）、save_servers:111-119 整表截断写；hubSettingsStore.ts:144-153 任意 setSettings 都回写 | src-tauri/mcp.rs:104-108 + hubSettingsStore.ts:144-153 | **已落地（1d0e563）**：Rust load_servers 返回 Result（文件不存在/空→Ok(空)；读取/解析失败→Err），mcp_list_servers 透传错误（移除 unwrap_or_default）；前端 hubSettingsStore 新增 mcpDegradedError 保护态，setSettings/updateMcpOps 两处整表回写均加守卫，MCP 页显示错误横幅；新增 4 例 Rust 单测（缺失/空/损坏/正常） | 单测 + 手动：损坏文件 → 启动报错横幅 |
| **F20** | **自动化派发凭证错投**：providerId 与 modelId 独立回退（App.tsx:839-840）可拼出「A 家供应商+B 家模型」 | App.tsx:836-875 | 供应商与模型必须同源解析（provider 存在 → 模型必须属于它，否则该次运行 failed 并注明原因）；Key/baseUrl 只取所配供应商，缺则 failed，禁止跨源拼接。⚠️ **复核订正：初稿"空 Key 把 legacy Key 发往该供应商 baseUrl"子项不成立**——`ProviderItem.apiKey` 是非可选 string，`??` 不会在空串上回退（App.tsx:844）；legacy Key 仅在 provider 整个为 undefined 时随 baseUrl 一并回退，属一致的 legacy 组合，非"错投" | 单测 + 手动：构造缺 model 的 automation → run failed 带明确错误 |

### 中危

| 编号 | 问题 | 位置 | 修复方案 |
|---|---|---|---|
| F21 | classic hook 执行失败被完全吞掉（连 console 都无）——防护型 hook 失效时工具照常执行（⚠️ 复核订正行号：`executeSingleHook` 的 catch 在 hooksRuntime.ts:324-330 返回 error 不抛；真正的"吞掉点"在 hooksRuntime.ts:415-418——仅 observational 事件 warn，classic 的 error 只进 `runs[]`） | hooksRuntime.ts:324-330 / 415-418（消费方只读 blocked，从不看 runs[].error） | hook 执行错误 → toast/审批区红点（对齐既有审批反馈通道）；错误进 runs 已有，补消费端 |
| F22 | ⚠️ **复核订正：本项判定有误，应从"待修"移除** —— `runAgentTurn.ts:543-545` **已有** `console.warn("[assistant] persona load failed (continuing without):", err)`，并非"连 warn 都无"。唯一"静默"的是 def 未找到/正文为空的分支（:540），属注释明示的有意行为。若仍希望用户可见（而非仅 console），可降级为"补 UI 降级提示"（可选） | runAgentTurn.ts:533-545 | （可选）若需用户可见：在回合事件里带一条人设降级提示；否则本项关闭 | 人工复核 |
| F23 | 会话/kv 持久化失败仅 console——重启丢数据无感知（settingsStore 有 degraded 通道，db.ts/conversationPool 没有）✅复核属实：conversationPool.ts:248-250、storage/db.ts:29-30,38-39 均仅 console.error | conversationPool.ts:248-250 / storage/db.ts | 复用 settingsStore 的 degraded/warning UI 通道：持久化失败 → 顶栏持久化警示 |
| F24 | 服务商配置写盘失败静默（设置页假成功）✅复核属实（**路径订正**） | **src/components/settings/model-provider/types.ts:231-233**（初稿误写 src/lib/providers/types.ts；Promise 照常 resolve） | saveProvidersConfigToDisk 返回成功/失败；失败时设置页 toast 如实报错 |
| F25 | automation schedule_rule 损坏 → 静默**替换**为每天 09:00 真实触发（⚠️ 复核订正用词：是内存中 `row_to_automation` 的 `unwrap_or(默认)` 替换并参与 claim，**并未回写 DB 的 schedule_rule 列**，不会持久污染原值） | src-tauri/automation.rs:189-196 | 解析失败 → 该自动化标记 error 状态 + last_error，**不猜默认计划**；next_run 置 NULL 且不参与 claim（区别于「立即触发」） |
| F26 | 记忆抽取独立模型解析失败静默回落主模型（organizer 同错误却是显式抛错，双路径语义分叉）✅复核属实（注：抽取路径有 warn，非完全静默，但模型确实被静默回落） | conversationPool.ts:651-663 | 统一为可见失败（错误进抽取状态并跳过本轮，注明原因），或统一回落+双路径声明一致（待选） |

### 低危（列出，随批顺带或接受）

L1 `automation_run_finished` 空 catch 补 warn（App.tsx:876-880 / 894-900，⚠️ 实为 promise `.catch(()=>{})` 非 try/catch）；L2 `getInitialTasks` 单行损坏静默丢任务补 console.error（useAppStore.ts:165-172）；L3 `updateModelEffortDefaultLevel` 找不到目标静默 return 补提示（**src/components/settings/model-provider/types.ts:239-261**，初稿路径同上误写）；L4 `API_FORMAT_TO_TYPE ?? "openai"`（下游已兜住，改注释；定义 modelResolution.ts:19-25）；L9 checkpoint_list 失败空列表与「无回退点」区分（checkpointRewind.tsx:181-182）；L12 conversationPool `getOptions` 不可达兜底改断言抛错（:298-311）。**ProviderForm.tsx 为死组件**（全库零引用，复核属实），建议删除（内含写死 catalog 默认模型的 onChange）。

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
