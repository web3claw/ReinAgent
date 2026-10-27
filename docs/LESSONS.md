# ReinAgent 错题本与动态演进规则 (LESSONS.md)

> **定位**：ReinAgent 项目的自进化动态错题本与经验教训库（对标 magpie 机制）。
> **核心原则**：记录在开发、评审与运行过程中发现的**返工失误、架构违规与薄弱验证**。错误被记录不是终点，而是防止同类错误再次发生的自动化抓手。

---

## 规则晋升机制（Seen 3× 晋升硬规则）

1. **初始记录**：在任务执行、Bug 修复或用户反馈中发现的新问题，按标准条目格式写入本文件，初始标记为 `Seen 1× (YYYY-MM-DD)`。
2. **频次累加**：若后续在不同日期或不同任务中再次出现同类失误，递增计次并追加日期记录，如 `Seen 2× (2026-10-05, 2026-10-08)`。
3. **“事不过三”转正硬规则**：
   - 当同一条教训在 **3 个不同日期/任务中复现（`Seen 3×`）** 时，触发**转正升级**；
   - 该条规则将从 `docs/LESSONS.md` 正式迁移写入 [AGENTS.md](../AGENTS.md) 与 [docs/PROJECT_CONTEXT.md](./PROJECT_CONTEXT.md) 的核心硬性红线中；
   - 转正后的条目在本文件中保留归档标记为 `[Promoted to AGENTS.md]`，后续所有的开发与审查均必须按硬性规范逐条对齐。

---

## 条目书写规范格式

每一条 Lesson 严格遵循以下单条结构：

```markdown
- **<一句话规则>** - <哪个场景/功能出事，后果与返工原因是什么> - <修复方案与代码位置> - Done right: <正向对齐范例> - Seen N× (YYYY-MM-DD, ...).
```

---

## 动态错题与经验库清单

### 1. 已转正硬规则归档（Promoted Rules）

- **[Promoted] 严禁臆测模型上下文与 Token 限制，必须 100% 完整解析服务端 API 真实元数据** - 曾试图用模型名称前缀匹配写死猜测的 `context_window` 与 Token 限制，导致新型号与私有模型配置严重失真且掩盖异常 - 强制解析真实返回，未提供则明确提示未知并向用户报警 - Done right: 见 [AGENTS.md](../AGENTS.md) 规则 5 及 `src/lib/providers/` - Seen 3× (2026-09-20, 2026-09-24, 2026-09-28) `[Promoted to AGENTS.md Rule 5]`.
- **[Promoted] 严禁在 CIFS 共享盘直接运行含软链接构建命令** - 曾因网络共享文件系统不支持 Linux 软链接及文件锁，导致 `node_modules` 软链接卡死与构建报错 - 废弃隔离区，统一在真实本地工作区直接使用 `bun install` 与 `bun run tauri dev` - Done right: 见 [AGENTS.md](../AGENTS.md) 规范 3 - Seen 3× (2026-09-15, 2026-09-16, 2026-09-18) `[Promoted to AGENTS.md Rule 3]`.
- **[Promoted] 严禁在样式中硬编码 Hex/RGB 颜色值** - 曾直接在组件 class 中写入 `#1e1e1e`、`#ffffff`，导致主题在深色/浅色切换时出现样式脱节与视觉刺眼 - 强制使用 `src/styles/global.css` 定义的语义变量（如 `var(--bg)`、`var(--sidebar-bg)`、`var(--border)`） - Done right: 见 [AGENTS.md](../AGENTS.md) 规则 3 - Seen 3× (2026-09-22, 2026-09-27, 2026-10-02) `[Promoted to AGENTS.md Rule 3]`.

---

### 2. 活跃跟踪经验池（Active Lessons）

#### 分类 A：返工与修漏（Regression & Incomplete Fix）
- **多任务切换时必须设置非空快照防御与 currentMessagesRef 守卫** - 曾因在新建任务或切换任务时调用了 `clear()`，导致历史消息在切回瞬间被短暂的空状态覆盖丢失 - 必须通过 `currentMessagesRef` 在清空前核验非空与目标 ID 匹配性 - Done right: 参考 `useConversation.ts` 与 `ProjectList.tsx` 的会话恢复防空保护 - Seen 2× (2026-10-05, 2026-10-08).
- **同类 Bug 或同类组件改造必须一并全量更新，严禁只修报告截图中单一实例** - 曾修复输入框下拉组件时仅处理了 ModelSelector，遗漏了 ReasoningEffort 下拉框的同类层级与滚动穿透问题，引发二次返工 - 任何交互修复必须排查全项目同构组件 - Done right: 全局检查类似 Dropdown/Popover 行为并同步应用 - Seen 1× (2026-10-10).
- **任务级定制状态（如特定模型）在新建与草稿时必须干净回退至系统默认** - 曾在任务 A 定制了特定模型后，点击侧边栏 `+` 新建任务依然残留上一个任务的模型，破坏全局默认设定 - 点击新建必须显式恢复系统默认配置 - Done right: 检查 `AppTask` 的 `providerId/modelId` 附着与重置生命周期 - Seen 2× (2026-10-09, 2026-10-12).
- **压缩条目（kind: compact）严禁归入 lastAssistant 或工时活动头，必须与常规助手回复正文完全隔离** - 压缩产生的摘要条目其 role 为 assistant，若 groupTurns 误将其记为 lastAssistant，会导致该摘要在 CompactionBand 渲染之后又以 MessageItem 气泡（含复制/删除/编辑操作）再次渲染，造成同一摘要在时间线上重复出现两次且伴随冗余的 0 秒工时条 - 必须在 groupTurns 提取 lastAssistant 与 TurnGroupView showHeader 处显式排除 `isCompactEntry` - Done right: 见 `src/lib/chat/turnActivity.ts` 与 `TurnGroupView.tsx` 的 `!isCompactEntry` 防守 - Seen 1× (2026-10-13).
- **虚拟列表与滚动容器严禁对内部易变子元素挂载自递归 ResizeObserver，滚动记忆必须持久化 wasPinnedToBottom 贴底态** - 曾在 `MessageList.tsx` 中用 ResizeObserver 监听虚拟列表容器 `listEl` 并更新 `setScrollMargin`，导致列表项测高与状态重绘相互激荡陷入无限死循环，超长任务下 CPU 飙至 90% 并发生界面冻结；且会话切换时丢弃了贴底跟随状态，导致切回时被旧锚点强制拉回历史消息顶部 - 滚动边距仅监听外层稳定视口 `scrollEl` 与 `window.resize`；滚动记忆严格遵循 ZCode 规范保存 `wasPinnedToBottom`，运行中或切出前在底部的会话切回一律 stickToBottom 跟随最新输出 - Done right: 见 `src/lib/chat/scrollMemory.ts` 与 `src/components/chat/MessageList.tsx` - Seen 1× (2026-10-16).
- **状态机事件流转与生命周期清理时必须保持关键状态字段（steerQueue 等）的继承与引用缓存** - 曾因在 `conversationModel.js` 的 `turn_start` 和 `appendUser` 中返回新对象漏写 `...state`，导致工具调用或新轮进入时排队消息 `steerQueue` 被冲刷丢失；且在 `conversationController.js` 的 `finally` 块中把 `abortRef = null` 放在了 `if (abortRef === controller)` 之前，导致条件永远为 false 无法自动弹出排队消息续跑 - 状态机必须展开 `...state`，控制器必须先用 `const isCurrent = abortRef === controller` 缓存轮次句柄再清理并触发自动续跑 - Done right: 见 `src/lib/chat/conversationModel.js`、`conversationController.js` 与 `conversationController.test.mjs` - Seen 1× (2026-10-21).
- **新增 fixture 类测试资产必须 `git check-ignore` 核验真实落库，测试断言依赖的文件一旦被 .gitignore 静默排除就成了「本机绿、fresh clone 红」的假绿测试** - 「WorkBuddy fixture：孪生解析」自 0ceee8c 起在换机克隆必红：`.gitignore` 全局规则 `.workbuddy/`（本意挡机器私有数据目录）把 `src/lib/import/fixtures/home/.workbuddy/` 测试 fixture 静默排除在 git 之外，作者本机存在未跟踪 fixture 文件故一直绿，且提交时无任何告警 - 已补孪生 fixture 并在 `.gitignore` 加路径级反排除（`!src/lib/import/fixtures/home/.workbuddy/` + `!.../**`；注意必须先反排除目录本身，否则 git 不下探其内容），并用 `git check-ignore -v <路径>` 验证反排除生效 - Done right: 新增测试固定装置后执行 `git check-ignore -v <路径>`（退出码 1 = 已落库）或以 fresh clone 跑测试验证 - Seen 1× (2026-10-24).
- **Red Check 破坏验证必须先用「非平凡输入」自检破坏是否真的会改变结果，全单位向量/全理想值测试对归一化类破坏免疫** - knowledge_index 余弦测试首版全用单位向量（[1,0]/[0,1]/[-1,0]/[0.6,0.8]），Red Check 破坏 `l2_norm`（去掉 sqrt）后测试仍全绿——单位向量的 norm² 恰好等于 norm，归一化破坏对它们不可见，Red Check 形同虚设 - 改用非单位向量锚定归一化不变量（`[2,0]` vs `[1,0]` 余弦恒为 1；norm² 实现下得 0.25）后同破坏真实报红 - Done right: 做 Red Check 时先心算「这个破坏在现有断言输入下是否真的改变输出」，归一化/缩放类函数必须配尺度不同的输入（见 `src-tauri/src/knowledge_index.rs` cosine 测试注释） - Seen 1× (2026-10-24).
- **WebView2 用户数据目录（WEBVIEW2_USER_DATA_FOLDER）严禁在应用运行中删除，E2E 收尾清理必须先杀应用进程** - CDP E2E 后顺手 `rm -rf webview-e2e`（当时应用还开着），HTTP 缓存索引指向已删文件，模块请求批量 `net::ERR_CACHE_READ_FAILURE` → React 永不挂载、卡死启动 logo；且这些错误只进 Log 域不进 console，`Runtime.consoleAPICalled` 抓不到，极易误判为新代码问题 - 诊断口径：CDP 里 `root.childElementCount === 0` + console 零报错 = 模块脚本没执行，必须开 `Log.enable` + `Network.enable` 抓 `Log.entryAdded`/`Network.loadingFailed`（本次真凶即在此现形）；修复 = 杀进程 → 删 profile → 重启重建 - Done right: E2E 清理脚本第一步永远先 `taskkill ReinAgent.exe` 再删用户数据目录；`ERR_CACHE_READ_FAILURE` = 缓存目录被外力抽走，直接重建 profile 即可（应用数据无损，与业务库无关） - Seen 1× (2026-10-24).
- **用脚本做字符串替换 patch 后必须验证「命中计数」，String.replace 不命中是静默无操作** - worktree remove 重构用 node -e 的 str.replace 换实现，转义层级出错导致查找串不匹配，replace 静默无操作（无报错无日志），旧实现原样保留——直到 Real Usage E2E 在 Windows 上踩出「在被删工作树里跑 git」的 cwd 竞态才暴露；期间编译、纯函数测试全绿，完全无感 - 补救：① 重要 patch 改用文件式 patch 脚本 + 打印命中计数（如 worktree refs: N），N 异常即中止；② 涉及流程重写的 patch，patch 后 grep 新代码特征串确认落位；③ E2E 必须覆盖被改路径的异常分支（本次 remove 的 GIT_NOT_REPO 分支就是首版 E2E 抓到的） - Done right: patch 脚本断言命中数>0 再写盘；对「我以为改了」的代码先 grep 再信 - Seen 1× (2026-10-24).
- **zustand store 的 kv 初值读取必须区分「模块求值期」与「initStorage 填充后」，创建时读缓存恒空，启动水合必须显式补读** - `hubSettingsStore` 的 skills/memory/knowledge 三切片在模块求值期（main.tsx 的 import 图先于 `await initStorage()` 执行）调 `kvGet` 读初值，读到的恒为空 Map → **应用重启后所有 kv 型 hub 设置永远回落默认**（skills 选集/记忆整理模型/知识库绑定全部不生效）；潜伏至今未暴露是因为用户历史设置恰好与默认值一致，知识库绑定 E2E 时绑定在 reload 后消失才现形 - 新增 `rehydrateHubKvSlices()`（重读三切片 kv 并 setState），在 `main.tsx` bootstrap 的 `initStorage()` 之后调用 - Done right: 任何「模块求值期读缓存」的 store，凡缓存由异步 init 填充，必须配套「init 后补读水合」；评审时对 `import 顺序 vs await init` 的时序做专项检查（见 `src/store/hubSettingsStore.ts` rehydrateHubKvSlices 与 `src/main.tsx`） - Seen 1× (2026-10-24).
- **下拉菜单与浮动气泡必须在就近容器设置定位锚点与 pointerdown 防竞争，严禁使用嵌套 fixed 遮罩导致裁切与菜单项点击失效** - 侧栏项目列表「+」下拉菜单（`ProjectList.tsx`）因外层缺乏 `relative z-50` 锚点且内嵌了全屏 `fixed inset-0` 遮罩层，在复合布局中菜单被父级 overflow 截断；且在点击「SSH 连接...」菜单项时，全屏遮罩先于按钮捕获 pointerdown 事件导致菜单关闭、表单无法弹出 - 锚点容器增加 `relative z-50`，移除全屏 `fixed` 遮罩，改用 `useRef` + `document.addEventListener("pointerdown")` 结合按钮 `onPointerDown={(e) => e.stopPropagation()}` 隔离冒泡 - Done right: 见 `src/components/sidebar/ProjectList.tsx` 与 Computer Use 实测截图 `fix1_menu_perfect_opened.png` / `fix1_ssh_form_proven.png` - Seen 1× (2026-10-27).
- **顶栏控制抽屉/浮层的开关按钮必须实现原位 Toggle 幂等与激活高亮态，严禁写死单向开态** - 笔记版本管理历史抽屉（`NoteEditor.tsx`）顶栏时钟图标点击后滑出版本抽屉，但再次点击该图标时因写死 `setIsVersionOpen(true)` 毫无反应，用户无法原位收起；且缺少激活态视觉回显 - 时钟按钮 `onClick` 改为 `setIsVersionOpen((prev) => !prev)`，并在开启时增加 `bg-[var(--surface-hover)] text-[var(--brand)] ring-1 ring-[var(--brand)]` 激活高亮与 aria-expanded - Done right: 见 `src/components/notes/NoteEditor.tsx` 与 Computer Use 展开/收起对比截图 `fix2_drawer_opened.png` / `fix2_drawer_closed.png` - Seen 1× (2026-10-27).
- **复合知识源 ID 前缀解析必须严格按命名空间剥离，严禁在 parseKnowledgeSourceId 中遗漏合法前缀** - 知识图谱跳转溯源解析（`sourceLinks.ts`）在解析 `note:notebook:file.md` 格式时未剥离 `note:` 前缀，导致冒号拆分后误将 `notebook` 识别为 `"note"`，真实子目录与文件名错位导致笔记跳转定位失败 - 在 `parseKnowledgeSourceId` 中增加 `note:` 前缀剥离逻辑（与 `wiki:` / `import:` 对齐），兼顾多层子目录与根目录单文件名 - Done right: 见 `src/lib/knowledge/sourceLinks.ts` 与 Red Check 变异测试 `src/lib/knowledge/sourceLinks.test.mjs` - Seen 1× (2026-10-27).

#### 分类 B：架构与双模兼容（Architectural Violations & Dual-mode）
- **所有系统级 Native 命令（PTY 终端、文件操作、Dialog）必须提供完备的 Web Mock Fallback** - 曾直接在组件顶层调用 `@tauri-apps/api` 的 Native 方法，导致在 Headless Chrome 测试环境和纯浏览器预览中发生未捕获异常白屏 - 必须使用运行时环境检测与 Web Mock 垫片 - Done right: 见 `src/lib/agent/tools.ts` 和 `src/lib/terminal/terminalUi.ts` 的 Web fallback 抽象 - Seen 2× (2026-09-29, 2026-10-04).
- **严禁修改用户已经拍板的 deliberate decisions（产品既定交互）** - 侧边栏拖拽手柄、任务置顶展示、审批模式三态等属于经过确认的稳定产品形态，Agent 严禁在优化其他功能时随意篡改既定布局与操作习惯 - Done right: 遇有交互冲突时，优先保留 deliberate decisions 并向用户求证 - Seen 1× (2026-10-11).
- **局域网跨端调度与 MCP 通信必须使用 systemd-run 逃逸宿主网络，严禁在沙箱中裸调** - 曾因在容器/沙箱环境下直接执行 curl 或 node 请求 192.168.3.27:7777，被系统代理（no_proxy 不支持 CIDR 掩码）强行截断转发至本地代理产生 ECONNRESET，导致误判远端离线 - 必须统一使用 `systemd-run --user --wait --pipe` 调度通信脚本直接穿透宿主物理网卡 - Done right: 见 `scripts/wait_remote_dialogue.mjs` 与 `scripts/send_directive.mjs` - Seen 1× (2026-10-20).
- **远端 ReinAgent 切换模型必须且只能选择 Magpie 服务商，且必须防范 activeTaskId 未变更导致的 React 状态闭包滞留** - 远端切换模型曾因选择其他服务商撞上 WorkBuddy 429 频控；且调用 `reinagent_set_model` 修改 `task.providerId` 后，因当前会话 `activeTaskId` 没变未能触发 `App.tsx` 的 `useEffect([activeTaskId])`，导致输入框 `sessionProviderId/sessionModelId` 依然死锁在旧模型闭包上继续发送旧请求 - 铁律：① 远端模型严格仅限选择 Magpie 服务商（如 `trae-cn/DeepSeek-V4-Flash-Official-max`）；② 切换模型必须三连穿透（改任务模型 + 改 settings.json 全局默认 + `reinagent_switch_task` 切走再切回强制击穿组件重挂） - Done right: 见 `PROJECT_CONTEXT.md` 第四十二至四十三节及 `scripts/send_directive.mjs` - Seen 1× (2026-10-21).
- **守护监控脚本检测会话递增时严禁臆测顶层 seq 字段，必须提取 revision、messages 尾部 seq 或 totalMessages 防误报假冻结** - 曾在 `wait_remote_dialogue.mjs` 中写死 `data.seq ?? 0`，由于 `reinagent_get_task_status` 返回结构中顶层并不存在 `seq`（序列号位于内部 `messages[i].seq` 或 `revision/totalMessages`），导致 `currentSeq` 始终读出 0，在远端 Agent 持续产生 80+ 条高频工具调用与测试代码时，每隔 10 分钟误触发一次死锁假警报 - 必须优先解析 `data.revision ?? data.messages?.[-1]?.seq ?? data.totalMessages ?? 0` 保证活跃度精确感知 - Done right: 见 `scripts/wait_remote_dialogue.mjs` line 245 - Seen 1× (2026-10-21).
- **Windows 下调用 explorer.exe 必须进行反斜杠清洗，严禁传递正斜杠 `/`，跨平台打开目录优先使用 tauri-plugin-opener** - 顶栏文件夹图标点击后在 Windows 上意外打开「文档」目录；原因是前端规范化路径统一转为 POSIX 正斜杠 `/`，而 Windows `explorer.exe` 的命令行解析器将 `/` 视作命令行开关（如 `/select`, `/root`），解析失败后自动 Fallback 回退打开系统默认的「文档」文件夹 - 前端优先使用 `@tauri-apps/plugin-opener` 的 `openPath`（底层走 Windows 原生 ShellExecuteW API），Rust 端 `open_in_file_manager` 加固 `sanitize_explorer_path` 强制替换正斜杠为反斜杠 `\\`，并提供空工作区防御 - Done right: 见 `src/App.tsx` 与 `src-tauri/src/fs_cmd.rs` 的 `sanitize_explorer_path` 及单测 - Seen 1× (2026-10-21).
- **远端 ReinAgent 模型切换严格限定为 Magpie 服务商下的 DeepSeek 与 GLM 系列，且所有分析确认事实必须即时落盘** - 曾在模型出问题时随意切至未授权服务商导致频控断连，且分析出的关键接口参数滞留于口头未及时落盘导致后续 Agent 重复试错 - 铁律：① 远端调度或改模型只能在 Magpie（`custom-1791417182102`）下的 DeepSeek 与 GLM 系列模型中切换；② 任何分析研究一旦确认（如 ID 映射、设备特征、协议字段），必须第一时间同步写入 `PROJECT_PROGRESS.md`、`.ReinAgent/remote_wangshangliao/RESEARCH_PROGRESS_LEDGER.md` 与核心文档 - Done right: 见 `AGENTS.md` RULE 12 与台账第 48~49 条 - Seen 1× (2026-10-22).
- **Webview（浏览器环境）对 User-Agent 与敏感头的静默剥离防护，第三方 API 伪装必须在 Rust 本地反代层强制重写注入** - 在桌面 WebView2/WebKit 架构下，W3C 规范禁止 JS `fetch` 修改 `User-Agent` 等 Forbidden Headers，前端设置的官方 User-Agent 会被引擎静默吞掉并还原为操作系统的浏览器 UA（`Mozilla/5.0...`）；若 Rust 本地反代仅原样转发前端 headers，上游（如 OpenCode Zen 服务端）会因识别出浏览器 UA 及 `sec-ch-ua` / `sec-fetch-*` 跨域头判定为非官方调用而下发 403 FreeTierError - 必须在 Rust 核心转发层针对特定上游（`opencode.ai` 等）强制重写注入官方 CLI `User-Agent`，并彻底剥离暴露浏览器身份的全部 `sec-*` 请求头，确保出网报文与官方 CLI 字节级一致 - Done right: 见 `src-tauri/src/llm_proxy.rs`、`src/lib/web/proxiedFetch.ts` 与 `src/lib/providers/opencodeZenAdapter.ts` - Seen 1× (2026-10-22).
- **Rust `reqwest` 依赖声明严禁使用 `default-features = false` 漏掉 TLS 特性，否则出站 HTTPS 请求会在本地被 hyper 拦截抛出 `invalid URL, scheme is not http`** - 在 `src-tauri/Cargo.toml` 中为 `reqwest` 声明依赖时，误写了 `default-features = false, features = ["stream", "json"]`，导致底层完全没有编译 TLS/SSL 协议栈（无 `native-tls` 或 `default-tls`）；应用自更新（`self_update.rs`）向 GitHub Releases 发起 `https://.../latest.json` 检查时，hyper 识别到缺失 HTTPS connector 根本不发网络包即报错 `ConnectError("invalid URL, scheme is not http")`，导致界面版本更新图标误亮黄色感叹号并提示「获取更新信息失败」 - 必须在 `src-tauri/Cargo.toml` 中为 `reqwest` 显式启用 `native-tls`，并在 `self_update.rs` 维护 `build_client_supports_https_scheme` 守护测试 - Done right: 见 `src-tauri/Cargo.toml` 与 `src-tauri/src/self_update.rs` - Seen 1× (2026-10-22).



#### 分类 C：测试与验证粗糙（Shallow Verification & False Positives）
- **修复 Bug 写的测试必须通过 Red Check（回退变异测试），严禁提交未经验证的“恒真假绿”测试** - 曾新增测试用例但因为断言范围过宽，即使底层存在 Bug 测试依然返回成功 - 新增测试必须先故意破坏代码或改回旧实现，亲眼确认测试真实红屏报错后方可算作有效测试 - Done right: 运行 `bun test` 前先执行一次故意变异验证 - Seen 1× (2026-10-13).
- **验收报告中凡未实际运行或缺少环境的场景，必须显式注明 Not run，严禁隐瞒** - 曾因缺少真实云端 API Key，在汇报中笼统宣称“全流程通过”，隐藏了真实请求未跑的事实 - 交付报告中必须分门别类列出 `Passed`、`Red Verified` 和 `Not run` - Done right: 报告结尾显式标注真实调用与 Mock 调用的边界 - Seen 1× (2026-10-13).
- **App.tsx 新增 hooks 必须放在「设置页早退 return」之前的统一 hooks 声明区，严禁在组件后段随手追加 useEffect** - ROADMAP ⑦ 的 prefill 事件监听 useEffect 被加在 App.tsx 后段（handleQuickPrompt 旁，位于设置页早退 return 之后）——workbench 视图渲染时 hooks 齐全，一旦打开设置页走早退分支 hooks 数量骤减，React 抛 "Rendered fewer hooks than expected" 并卸载整树，设置页一片空白（用户报障；tsc/单测全绿无法捕捉，纯运行时缺陷） - 修复：移到 prefillNonceRef 声明旁的 hooks 区（App.tsx）；诊断路径：WebKitGTK 无 CDP，用 tauri dev 自带的 vite 1420 + CDP 复现点击设置抓到真实错误栈 - Done right: 改 App.tsx 前先 grep 早退 return 的位置；新增 hook 一律插在既有 hooks 声明区（useState/useRef 群）；PROJECT_CONTEXT 早期 EmptyState prefill 段早已写明该约束，属重复踩坑 - Seen 1× (2026-10-25).
