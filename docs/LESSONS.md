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

#### 分类 B：架构与双模兼容（Architectural Violations & Dual-mode）
- **所有系统级 Native 命令（PTY 终端、文件操作、Dialog）必须提供完备的 Web Mock Fallback** - 曾直接在组件顶层调用 `@tauri-apps/api` 的 Native 方法，导致在 Headless Chrome 测试环境和纯浏览器预览中发生未捕获异常白屏 - 必须使用运行时环境检测与 Web Mock 垫片 - Done right: 见 `src/lib/agent/tools.ts` 和 `src/lib/terminal/terminalUi.ts` 的 Web fallback 抽象 - Seen 2× (2026-09-29, 2026-10-04).
- **严禁修改用户已经拍板的 deliberate decisions（产品既定交互）** - 侧边栏拖拽手柄、任务置顶展示、审批模式三态等属于经过确认的稳定产品形态，Agent 严禁在优化其他功能时随意篡改既定布局与操作习惯 - Done right: 遇有交互冲突时，优先保留 deliberate decisions 并向用户求证 - Seen 1× (2026-10-11).

#### 分类 C：测试与验证粗糙（Shallow Verification & False Positives）
- **修复 Bug 写的测试必须通过 Red Check（回退变异测试），严禁提交未经验证的“恒真假绿”测试** - 曾新增测试用例但因为断言范围过宽，即使底层存在 Bug 测试依然返回成功 - 新增测试必须先故意破坏代码或改回旧实现，亲眼确认测试真实红屏报错后方可算作有效测试 - Done right: 运行 `bun test` 前先执行一次故意变异验证 - Seen 1× (2026-10-13).
- **验收报告中凡未实际运行或缺少环境的场景，必须显式注明 Not run，严禁隐瞒** - 曾因缺少真实云端 API Key，在汇报中笼统宣称“全流程通过”，隐藏了真实请求未跑的事实 - 交付报告中必须分门别类列出 `Passed`、`Red Verified` 和 `Not run` - Done right: 报告结尾显式标注真实调用与 Mock 调用的边界 - Seen 1× (2026-10-13).
