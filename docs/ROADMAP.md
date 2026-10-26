# ReinAgent 功能路线图（vs Hetu 借鉴分析）

> **文档定位**：2026-10-24 对 E:\DevCode\Hetu（河图，Apache-2.0，.NET 10 + React 19 + Tauri 2 壳 + SQLite/sqlite-vec 本地优先 AI 工作台）做实现层全量调研后，与 ReinAgent 现状比对得出的**借鉴清单与优先级排期**。三个探索方向（知识库与检索、记忆与笔记、看板与代码会话）均已下钻到服务层与数据模型，非 README 级推断。
> **参考源码**（严禁反编译，直接查阅）：`E:\DevCode\Hetu`（后端 `src/Hetu.Core` / `src/Hetu.Infrastructure`，前端 `frontend/src`，设计文档 `docs/guide/*.html`）。
> **历史归档**：LiveAgent / ZCode 差距分析路线图见 [archived/ROADMAP.md](./archived/ROADMAP.md)（其规划能力已全部交付）。项目全景真相源始终以 [PROJECT_CONTEXT.md](./PROJECT_CONTEXT.md) 为准。

---

## 〇、总评

Hetu 与 ReinAgent 定位同构（同为本地优先 AI 工作台，笔记系统 2026-10-14 即移植自 Hetu），其功能语义几乎全部可平移到 Rust + rusqlite 栈。ReinAgent 已对齐的部分（会话审批/压缩/回退/Git 面板/技能/MCP/子代理/自动化/远控）不再重复。**真正的空白集中在：检索（RAG）、会话工作区隔离、记忆生命周期管理、无人值守任务形态、笔记资产化能力**。

| 优先级 | 借鉴项 | 一句话价值 |
| --- | --- | --- |
| P0 | ① RAG 知识库 ✅（2026-10-24 v1 落地） | 笔记/会话/导入数据零检索 → sqlite-vec 语义检索 + agent 工具/自动注入 |
| P0 | ② 会话级 worktree 隔离 ✅（2026-10-24 v1 落地） | 多任务并行互踩工作区 → 懒创建 + 合并后自动清理 |
| P0 | ③ 记忆升级包（作用域/召回打分/Dream）✅（2026-10-24 v1 落地，会话作用域留 v2） | 纯数值算法、成本低，与现有 extraction/organizer 直接衔接 |
| P1 | ④ 笔记增强包（版本历史/划词 AI/回收站/标签）✅（2026-10-25 v1 落地） | 笔记从「编辑器」升级为「资产库」 |
| P1 | ⑤ 看板式 Agent 任务 ✅（2026-10-25 v1 落地） | 任务驱动的无人值守执行（与 cron 自动化互补） |
| P1 | ⑥ 进模型前文本压缩管线 ✅（2026-10-24 v1 落地） | 纯函数 5 节点（轻有损子集），专治工具输出超长，与 microcompact 正交 |
| P1 | ⑦ PR 面板（gh/glab） ✅（2026-10-25 v1 落地，随下一版本发布） | Git 面板自然延伸 + 「交给 Agent 修」闭环 |
| P2 | ⑫ SSH 项目 | 已标缓（⑧⑨⑩⑪ 均已落地；⓪ 队列随 ⑨ 以 wiki_jobs 形态落地） |
| 地基 | ⓪ 后台任务队列语义 | ①⑤⑨ 的公共前置：SQLite 表即队列 |

状态标记：☐ 未排期 · ◐ 进行中 · ✅ 已完成。

---

## 一、P0 借鉴项

### ① RAG 知识库 ✅（2026-10-24 v1 落地，实现细节见 PROJECT_CONTEXT「知识库（RAG v1）」节）

> v1 实际取舍：向量检索用 **Rust 暴力余弦**（用户拍板，零扩展依赖；sqlite-vec 降级为 v2 升级位——
> `knowledge_chunks.embedding/dims` 列语义与 vec0 虚表一致，后续只需加虚表 + 双写）；索引范围 v1 =
> **笔记 + 导入的外部会话**（用户拍板）；喂模型 = **composer 任务级开关自动注入 + search_knowledge
> 工具**双通道（用户拍板）。embedding 真链路（Ollama）待本机安装后补验。

**Hetu 机制**（`ChunkService.cs` / `NoteEmbeddingService.cs` / `SemanticSearchService.cs` / `SqliteVecInterceptor.cs`）：

- **分块**：默认结构化分块——按 Markdown 标题（`^#{1,6}\s`）切，无标题按空行段落，超 1500 字符按句子（`。！？.!?\n`）再切并保留 100 字符尾部重叠，<200 字符合并；LLM 分块（300–1500 字/块 + ≤100 字摘要）仅配置了分块模型时启用，失败/超 12000 字符一律回退结构化。
- **向量双写**：正规表存 byte[]（f32 LE）+ 元数据（Model/Dimensions/UpdatedAt），同事务写 sqlite-vec 虚表；单块笔记同时维护「整篇级 + 分块级」两份向量。
- **增量索引**：按 ChunkIndex 比对 Content+Summary，未变块复用向量只补写虚表；中断恢复做「正规表有、虚表缺」幂等补写。
- **检索链路**：整篇级 + 分块级两路 KNN 各取 topK×3 候选 → JOIN 正规表过滤软删 → 按 ID 去重截 topK（snippet 优先 LLM 块摘要，否则截 120 字）→ 图谱 1 跳邻居扩展追加 topK/2（无分数排后）→ vec 扩展不可用回退内存余弦。**不做重排**（避免分数不可比抖动）。
- **喂给 agent 两条路**：输入框开关打开时自动检索 top5，作为一条独立 user 消息插到最后一条用户消息前（SSE 推命中列表）；`search_notes`（全文+语义并行召回合并）/`read_note`/`list_knowledge` 工具族供模型主动调用。
- **维度管理**：虚表维度 = 最近一条向量 Dimensions → 模型配置 → 默认 1536；**维度变化即 DROP 重建虚表**（正规表 byte[] 是重建源）。

**对 ReinAgent 落地**：`sqlite-vec` 官方 Rust crate 可静态链接进 rusqlite（免 vec0.dll 加载）。索引对象：笔记（现文件制，内容入库快照或读文件）、导入的 20 源外部会话、`.ReinAgent` 内文档。注入链路复用 meta_user 注入骨架（[[meta-user-injection-restructure]]）。按 no-fallback 铁律：未配置 embedding 服务商时 UI 明示「知识库不可用」。

**必须继承的坑**：vec 虚表不支持 upsert（DELETE+INSERT 包同一事务）；KNN 语法 `WHERE embedding MATCH ? AND k = ?` 不能与 LIMIT 共存；虚表无元数据列，业务过滤必须 JOIN 回正规表（用 fetchK=topK×3 放大抵消）；换 embedding 模型 = 任务队列全量重算。

### ② 会话级 git worktree 隔离 ✅（2026-10-24 v1 落地；实现细节见 PROJECT_CONTEXT「十五、会话级 worktree 隔离」节。落地差异：确定性命名（标题slug+任务短id）替代 LLM 起名与 -2 递增——幂等关键；清理的已合并判定用主仓 HEAD..branch 计数）

**Hetu 机制**（`WorkWorktreeService.cs` / `WorktreeNameSuggester.cs` / `WorktreeCleanupService.cs`）：

- 会话级开关 `UseWorktree`/`BaseBranch`；**懒创建**（首次发消息才 `git worktree add`）。
- 命名：LLM 按首条消息生成 kebab-case 短名（20s 超时降级 slug / `session-<短id>`），目录名=分支名，冲突加 `-2..-20` 序号。
- 位置：`<仓库父目录>/.hetu-worktrees/<仓库名>/`（**仓库外**，可配根目录）；基分支是被占用本地分支或远程引用时自动 `-b` 新建/建跟踪分支；失败先 `worktree prune`。
- 同步：**不做自动 sync**（工作树分支固定，主仓库手动 pull `--ff-only`/push）。
- 清理（后台 worker 周期跑）：「已合并进集成分支（origin/HEAD→origin/main|master，或推送过但远端分支已删=squash 合并）+ 工作区干净 + 空闲超阈值」→ `worktree remove --force + prune` 并复位会话分支；孤立目录必清。

**对 ReinAgent 落地**：任务级开关（对齐任务级隔离设置的模式，[[task-isolation-approval-mode-plan]]），tokio::process 直调 git。多任务并行互踩工作区是当前真实痛点；注意用户曾拍板 ReinAgent 自身开发用普通分支——那是开发流程决策，与本产品能力不冲突。

### ③ 记忆升级包：三作用域 + 召回打分 + Dream 巩固 ✅（2026-10-24 v1 落地；会话作用域留 v2，实现细节见 PROJECT_CONTEXT「十四、记忆升级包」节）

**Hetu 机制**（`MessageService.cs` 的 MemoryService 区段 / `DreamMemoryService.cs` / `ChatContextInjector.cs`）：

- **作用域**：Global/Session/Project 三值；检索取 `Global ∪ 当前会话 ∪ 当前项目` 并集（Code 会话取 全局∪当前项目）；手动创建不允许 Session 作用域（会话记忆只能由对话提取产生）。
- **自动提取三信号**（任一满足，每轮结束后触发）：距上次提取 ≥10 条用户消息；≥30 分钟且 ≥3 条；≥5 条且最近 3 条平均长度 >200 字符。提取前先 0.9 相似度去重（命中只刷新 LastAccessedAt/AccessCount）。
- **召回打分**：`0.4×相似度 + 0.3×Importance + 0.2×exp(-0.05×闲置天数) + 0.1×log(1+召回次数)/log(51) + 0.05×非Global加成`；先 vec 虚表取 topK×5 候选再公式重排；**命中即回写 LastAccessedAt/AccessCount**（正反馈，Dream 衰减依赖它防误杀）。
- **Dream 巩固（全程无 LLM，纯数值）**：合并=贪心余弦聚类（≥0.85 入簇，keeper 取 Importance 最高→作用域最公共→最早；被吸收软删+删向量；keeper Importance+0.05 上限 1、AccessCount 取簇和）；衰减=>30 天未访问且 Importance>0.05 → ×0.8（下限 0.05）；遗忘=>180 天未访问且 Importance<0.15 → 软删+删向量（ForgetDays 配置 ≥ DecayDays）。默认每 24h 自动（可 1–720h）+ 手动；返回合并/衰减/遗忘/剩余统计。
- **注入格式**：以当前用户消息为 query 检索 top5，作为独立 user 消息插到最后一条用户消息前，每条 `[作用域·类别] 内容`；SSE 推 `memory_results`。另有 `search_memory` 工具供模型主动检索。

**对 ReinAgent 落地**：与现有 extraction（gating）+ organizer（quota）衔接：extraction 出的记忆补 Scope/Importance/AccessCount 字段；Dream 是纯算法可直接单测（移植时把 MergeThreshold/DecayDays/ForgetDays 的 clamp 约束与「保存配置不覆盖 LastRunAt」一起搬）。向量层与 ① 共用 sqlite-vec。⚠️ Hetu 的「合并只留 keeper 原文」是信息丢失点（其余表述直接软删），可考虑把被吸收内容存进 keeper metadata。

---

## 二、P1 借鉴项

### ④ 笔记增强包 ✅（2026-10-25 v1 落地；实现细节见 PROJECT_CONTEXT「十七、笔记增强包」节。落地差异：标签走 SQLite 零污染（用户拍板，.md 与 Obsidian/Typora 互通不受影响）、划词 AI 大半已在（只补 prompt 分区与精确替换两个缺口）、agent 标签工具与词级 diff 留 v2）

ReinAgent 笔记现状：文件制（notes_* Rust 命令）+ 整篇级 AI 侧栏（润色/翻译/续写）。Hetu 四件套（`NoteVersion.cs` / `NoteVersionService.cs` / `MarkdownEditor.tsx` / `NoteAiService.cs` / `TrashCleanupService.cs` / `TagService.cs`）：

- **版本历史**：变更前全量快照（仅 Title/Content），SQL 侧一条 DELETE 只留最近 20 版；**还原前先把当前内容存一版**（回滚本身不丢数据）；UI=右滑面板列表+并排对照（当前 vs 版本）+一键还原。
- **划词 AI**：ProseMirror selectionTracker 采集 `{text, from, to, coords}` → 浮动工具栏 → 6 动作（polish/translate/condense/expand/explain/custom，预设词预填可改）→ SSE 流式 → sanitize（剥对话性前后缀/代码围栏）→ **替换选区（选区丢失拒绝并提示改追加）或追加下方**。后端 prompt 把「待处理文本（选区）」与「背景参考（标题+全文）」显式分区并强调禁止回显背景。⚠️ 这套 sanitize/防覆盖是踩坑补丁，必须整套搬，否则重现「AI 结果顶掉整篇笔记」。所有 AI 动作触发版本快照。
- **回收站**：软删（IsDeleted+DeletedAt）+ 级联子树恢复/彻底删 + 30 天后台硬删。
- **标签**：多对多 + 配色 + 合并标签；agent 有 list_tags/set_note_tags 等工具。

ReinAgent 笔记是文件制：版本历史可落 `.ReinAgent/notes-versions/` 或 SQLite 快照表；划词 AI 依赖 Milkdown 选区追踪（Hetu 的 `MilkdownEditor.tsx:267-313` 可直接参考）。

### ⑤ 看板式 Agent 任务 ✅（2026-10-25 v1 落地；实现细节见 PROJECT_CONTEXT「十八、看板式 Agent 任务」节。落地差异：卡片=持久会话（非 Hetu 的每 run 新会话，时间线免费复用）；不自建执行器——复用 conversationPool + 事件驱动收敛（automation 的 5s 轮询在 ask_user 挂起时永不收敛，这是关键差异）；收件箱聚合留 v2）

**Hetu 机制**（`KanbanTask.cs` / `KanbanTaskService.cs` / `KanbanTaskExecutor.cs` / `InboxService.cs`）：

- 卡片 = 7 列固定状态机（Backlog/Todo/InProgress/InReview/Blocked/Done/Archived，迁移白名单硬编码后端校验）+ 优先级 + 可绑 Agent/Workflow/项目。
- **触发**：进 Todo 即入队执行；InReview/Blocked 下用户评论会把卡片打回 Todo 并重跑；每卡同时最多 1 run（查重跳过）。
- **执行**：一次性无会话 Agent Loop（MaxIterations=20），简报=标题/描述/优先级/项目路径/全部评论过压缩管线；工具审批全 Auto（无人值守）。
- **回写**：执行步骤逐条落库成 RunStep 时间线（thinking 合并缓冲/工具调用成对）；终态=run 记录 + Agent 评论 + 卡片转 InReview；失败转 Blocked+收件箱 Error。
- **「提问即阻塞」闭环**：后台执行遇 ask_question 抛专用异常 → run=WaitingAnswer、卡片=Blocked 等用户评论回答，评论回流自动重跑。
- **收件箱聚合**：通知带 CategoryKey，同键未归档记录合并（刷新内容/置回未读/次数+1），点击按 Link 跳转。

**对 ReinAgent 落地**：与 automations（cron 时间驱动）互补的任务驱动形态；复用任务级隔离/审批门静默档与 bg_list 徽标展示。依赖 ⓪ 后台任务队列。

### ⑥ 进模型前文本压缩管线 ✅（2026-10-24 v1 落地；实现细节见 PROJECT_CONTEXT「十六、文本压缩管线」节。v1 为轻有损 5 节点子集：结构化折叠/连续重复/SimHash 近重复/空白收敛/headtail 首尾保留；number_normalize/stopwords/keywords/llm_summary 四节点不进 v1）

**Hetu 机制**（`CompressionPipelineService.cs`，配置 `CompressionConfig`）：10 节点固定顺序的纯文本变换——structured（base64/HTML/JSON/表格折叠）→ dedup → whitespace → log_dedup → near_dup（**SimHash**）→ number_normalize → stopwords（默认关）→ keywords（关键行打分）→ headtail（超长保首尾）→ llm_summary（仅 ≥500 字符且非 algorithmic 模式）；硬守卫「结果没变短就保留原文」。用于：超长工具输出逐段压缩、看板简报、代理转发。

**对 ReinAgent 落地**：纯函数极易单测（Red Check 友好），先接 `fs_execute`/工具输出与附件预览等大文本场景；与 microcompact（历史压缩）、compact（会话摘要）三层正交。

### ⑦ PR 面板（gh/glab）✅（2026-10-25 v1 落地，实现细节见 PROJECT_CONTEXT「十九、PR / MR 面板」节。落地差异：close/reopen 在 gh 2.103 下必须显式传分支名；反馈聚合/动作映射照搬 Hetu）

**Hetu 机制**（`WorkPrClient.cs` / `WorkPrPanel.tsx`）：按 remote URL 自动选 gh/glab；状态（state/mergeable/reviewDecision/CI checks/变更量）、创建（title/body/base/draft）、动作（ready/draft/merge --merge|--squash|--rebase/close/reopen）、**反馈聚合**（失败+进行中 CI、行内审查意见、失败日志摘录 ≤2 条）；前端「交给 Agent 修」把 feedback 渲染成 prompt 发回会话。

**对 ReinAgent 落地**：Git 面板（提交/推送/图谱/diff）的自然延伸；gh CLI 依赖用户本机安装，UI 需明示未安装（no-fallback）。

---

## 三、P2 借鉴项

### ⑧ 用量分析页 ✅（2026-10-25 落地，实现细节见 PROJECT_CONTEXT「二十一、用量来源维度」节。落地差异：来源打标走 task payload.source + 六条独立调用链 usage_record 记账；明细分页列表用户拍板不做；7×24 周热力图做了）

Hetu 单表 `LlmUsageLog` 十二种来源记账（chat/work/kanban/workflow/wiki/note-ai/skill/graph/search/scheduled/proxy）+ RefId + 延迟；聚合出概览/近 7 天趋势/365 天热力图/7×24 周热力图/按模型/按来源/来源×模型堆叠。**两家都只记 token 不记成本**。ReinAgent 已有 api_message 原件持久化 + usage_reset 水位线 + SessionStatsBar，缺全景页与「来源」维度（补 source 字段即可）。

### ⑨ Wiki 项目文档生成 ✅（2026-10-26 落地，实现细节见 PROJECT_CONTEXT「二十三、Wiki 项目文档生成」节。落地差异：执行器在前端 TS（LLM 全在 TS 侧），⓪ 队列即 wiki_jobs 表语义；代码语义索引未建——上下文走源码采样兜底；mtime 过期判定 v1 不做（显示生成时间）

选题→大纲→并行成页三段（`WikiService.cs` 1314 行 + `WikiContextCollector.cs`）：规划一次调用出 `{chapters:[{title,pages:[{title,brief,covers}]}]}`（3–6 章/8–16 页，解析三层容错含正则抢救）；并行成页（并发 4，每页独立上下文，代码语义索引就绪则按页检索 24 条代码块，否则源码采样）；截断续写最多 4 轮（finish reason=length + 代码围栏未闭合检测）；总览页强制 mermaid 架构图；生成后自动投影进知识库与图谱；单页可重生成（Brief 复用）、按 mtime 判过期。依赖 ① 知识库先行。

### ⑩ 知识图谱 ✅（2026-10-25 落地，实现细节见 PROJECT_CONTEXT「二十二、知识图谱」节。落地差异：抽取在前端走 completeOneShotText（场景模型 graph 行）；关系别名归一 belongs_to 等为测试驱动新增；Canvas 力导向零依赖自绘）

实体 6 类（concept/person/organization/technology/project/custom）/关系 5 类封闭枚举抽取（`GraphService.cs`），实体小写名全局去重、关系 (source,target,type) 去重、LLM 关系 Confidence=0.8 手工 1.0；前端自绘 Canvas 力导向（手写 d3-force 风格，无 ReactFlow 依赖）。最大价值=给语义检索做 1 跳扩展（①的增强件），独立可视化价值次之。依赖 ①。

### ⑪ 场景化默认模型 ✅（2026-10-25 落地，实现细节见 PROJECT_CONTEXT「二十、场景默认模型」节。方案 A：统一 UI 读写四场景现有键零迁移；v1 场景=chat/embedding/记忆整理/笔记 AI，Fast/Chunk 随 ⑨⑩ 再加）

Hetu 两层：`AiModel.Purpose`（chat/embedding/completion）+ AppSettings 键 `Default{Scenario}ModelId` 七场景（Chat/Chunk/Fast/Embedding/Wiki/Graph/NoteAi），复合键 `providerId:modelId` 解析。ReinAgent 已有助手绑定（任务级）+ 全局默认；场景模型（fast/embedding 等）随 ①③ 落地一起做，UI 按 no-fallback 明示未配置。

### ⑫ SSH 项目 ☐

Hetu 方案=「系统 ssh 客户端（BatchMode+keepalive）+ shell 命令模拟文件 API」（`WorkCommandRunner.cs` 的 Local/Ssh 双 runner + `WorkRemoteFs.cs` 的 ls/cat/tee/grep/find 解析层），非 sshfs、不嵌 SSH 库；SSH 项目不支持 worktree 与 checkpoint。与 ReinAgent 的手机远控/远端实例运维场景有协同，但工程量大，缓。

---

## 四、明确不借鉴（及理由）

| 项 | 理由 |
| --- | --- |
| 可视化工作流引擎 | 用户已拍板 /workflow 暂缓勿再推动（[[reinagent-zcode-command-porting]]）；且 Hetu 引擎成熟度一般：顺序执行非并行、无状态机持久化/断点续跑、human 审批挂起用进程内 TaskCompletionSource 不落库（重启即丢）。真要做时参考其 10 种节点类型清单与 GraphSnapshot 固化设计 |
| OpenAI/Anthropic 兼容代理端点 | Hetu 源码**完全无鉴权**（文档宣称 key 生成，代码无实现，文档-实现漂移），仅本机回环可用的裸奔状态；ReinAgent 优先级低，若做必须先补鉴权 |
| PostgreSQL 双后端 / EF Core 分层 / SignalR | 架构性组件，Tauri 事件体系已覆盖等价物 |
| checkpoint 快照式回滚 | Hetu 是「工具批次前文件全文快照进 SQLite（200 文件/检查点、留 30 个）」；ReinAgent 已有 LiveAgent journal 式 checkpoint/rewind，语义更完整，不换 |
| 记忆星空可视化 | 好看但实现上无边、无相似度连线（隐喻式径向布局，位置=黄金角+ID 哈希），发现重复实际靠 Dream 聚类；锦上添花 |
| 模型目录批量导入（models.dev） | 与 no-fallback 铁律精神冲突（静态元数据源），且 ReinAgent 已强制解析服务端真实元数据 |

---

## 五、⓪ 前置地基：后台任务队列语义（先于 ①⑤⑨）☐

Hetu 的可靠性设计（`BackgroundTaskCoordinator` / `BackgroundTaskProcessor` / `HetuDbContext`）——**先落库再入队**是铁律：

- 任务表 TaskItem（Type/EntityId/Status 0排队1运行2完成3失败/Error/时间戳）；`(TaskType, EntityId)` **过滤唯一索引**（仅对未完成记录生效）保证同对象只有一条活跃任务。
- 消费循环：claim 时 Queued→Running；服务停止的取消重排回队列；启动时全量恢复遗留 Queued/Running；每 2 分钟巡检恢复「>5 分钟未更新且未被本进程跟踪」的记录；顺带清竞态重复记录。
- 进度展示：任务状态写库 + 完成时事件推送；Wiki 类长任务有独立 Job 表（Stage 文案 + Progress 0-100）。

Rust 侧简化：**砍掉内存队列层，SQLite 表即队列**——`INSERT OR IGNORE` + 部分唯一索引天然解决 Hetu 用静态信号量解决的「查重+建记录」竞态；`UPDATE ... WHERE status=0` 抢占式 claim + 心跳列判 stale；tokio 单 worker 或小 worker 池。

---

## 六、Hetu 关键文件路径速查

| 主题 | 文件 |
| --- | --- |
| 分块 / 向量化 / 检索 | `src/Hetu.Core/Services/ChunkService.cs`、`NoteEmbeddingService.cs`、`SemanticSearchService.cs`、`SqliteSemanticSearchStrategy.cs`；`src/Hetu.Infrastructure/Data/SqliteVecInterceptor.cs` |
| RAG 注入 / 检索工具 | `src/Hetu.Api/Services/ChatContextInjector.cs`；`src/Hetu.Core/Services/Tools/SearchNotesTool.cs` 等 |
| 记忆 / Dream / 打分 | `src/Hetu.Infrastructure/Services/MemoryService.cs`（打分与 Dream 在 `MessageService.cs` 504-953 区段）、`src/Hetu.Infrastructure/Background/DreamMemoryService.cs`；设计文档 `docs/guide/memory-recall.html` |
| 笔记版本 / 划词 AI / 回收站 / 标签 | `src/Hetu.Core/Entities/NoteVersion.cs`、`src/Hetu.Core/Services/NoteVersionService.cs`、`NoteService.cs`、`NoteAiService.cs`；`frontend/src/components/MarkdownEditor.tsx`（selectionTracker 267-313、sanitize 107-152）、`MilkdownEditor.tsx`；`TrashCleanupService.cs`、`TagService.cs` |
| 看板 / 执行器 / 收件箱 | `src/Hetu.Core/Entities/KanbanTask.cs`；`src/Hetu.Infrastructure/Services/KanbanTaskService.cs`、`KanbanTaskExecutor.cs`；`src/Hetu.Core/Services/InboxService.cs` |
| 压缩管线 | `src/Hetu.Core/Services/CompressionPipelineService.cs` |
| worktree / SSH / PR | `src/Hetu.Core/Services/Work/WorkWorktreeService.cs`、`WorktreeNameSuggester.cs`、`WorktreeCleanupService.cs`、`WorkCommandRunner.cs`、`WorkRemoteFs.cs`、`WorkPrClient.cs`；`src/Hetu.Core/Services/WorkGovernanceService.cs`（checkpoint） |
| 后台任务 / 定时任务 | `src/Hetu.Infrastructure/Background/`（`BackgroundTaskCoordinator.cs`、`BackgroundTaskProcessor.cs`、`ChannelBackgroundTaskQueue.cs`、`ScheduledTaskRunner.cs`、`WorktreeCleanupService.cs`、`TrashCleanupService.cs`） |
| Wiki / 图谱 | `src/Hetu.Core/Services/WikiService.cs`、`WikiContextCollector.cs`、`WikiKnowledgeSyncService.cs`、`GraphService.cs`；`frontend/src/pages/GraphPage.tsx`（自绘力导向） |
| 用量 / 代理 | `src/Hetu.Core/Entities/LlmUsageLog.cs`、`src/Hetu.Core/Services/UsageService.cs`；`OpenAiProxyController` / `AnthropicProxyController`（⚠️ 无鉴权） |
| 数据模型全景 | `src/Hetu.Infrastructure/Data/HetuDbContext.cs`（约 55 个 DbSet） |
