/**
 * compaction.ts —— 历史压缩纯逻辑（对齐 ZCode core/compact 与 LiveAgent lib/chat/compaction）。
 *
 * 语义：
 * - **轮边界切分**：只压「完整轮」（user 开轮到下一条 user 前），绝不切进工具调用对——
 *   轮内 assistant(toolCall) + toolResult 必须同生共死，切开会造成孤儿 toolResult → 400；
 * - **保留最近 N 轮原样**（KEEP_RECENT_TURNS），只压更早的；
 * - 压缩产物 = 一条 `kind: "compact"` 的 assistant 条目（摘要文本），落库可复原；
 * - `toApiMessages` 把 compact 条目输出为一条 assistant 文本消息，并**跳过被压缩的区间**
 *   （被压的原始条目仍留在时间线里供 UI 查看，只是不再发给模型）；
 * - **失败不压缩**（No-Fallback）：摘要调用失败时保持原状，绝不伪造摘要。
 *
 * 提示词要点对齐 ZCode core/compact/prompt.ts：保留关键决策/文件路径/未完成任务；
 * 安全约束逐字保留。
 */

import type { TimelineEntry } from "./conversationModel";

/** 压缩后保留的原样轮数（对齐 ZCode 默认保留近段）。 */
export const KEEP_RECENT_TURNS = 4;
/** 压缩条目的 kind 标记。 */
export const COMPACT_KIND = "compact" as const;

/**
 * 触发自动压缩的水位线比例——作用于「可用 prompt 空间」而非整个声明窗口。
 *
 * 为什么不用「声明窗口 × 80%」（旧实现）：那套算法在大窗口模型上会等得太晚。
 * 实测 2026-10-05：deepseek-flash 声明 `contextWindow = 1,048,576`，旧阈值要
 * ~83.9 万 tokens 才触发；而该会话在 **~55 万 tokens 就以 `Connection error.` 断连**
 * （详见 PROJECT_CONTEXT「LLM 流式本地反代」/ 本模块 design note）。声明窗口偏乐观，
 * 必须留出余量、并允许被实测经验（见 observedCeilingTokens）继续收紧。
 */
export const COMPACTION_WATERMARK_RATIO = 0.7;
/** 上游未声明 maxOutputTokens 时的输出预留比例（内部预算常量，非对上游元数据的捏造）。 */
export const OUTPUT_RESERVE_RATIO = 0.25;
/** 经验上限安全系数：学到「多大会失败」后，把水位线压到它的这个比例之下。 */
export const OBSERVED_CEILING_SAFETY_RATIO = 0.7;

/** 模型标识键（经验上限按「服务商/模型」维度存储）。 */
export function modelKeyOf(config?: { provider?: string; modelId?: string } | null): string {
  return `${config?.provider ?? ""}/${config?.modelId ?? ""}`;
}

/**
 * 可用 prompt 空间 = 声明窗口 − 输出预留。
 *
 * 我们每个请求都会发 `max_output_tokens`（当前等于模型的 maxOutputTokens，deepseek-flash
 * 为 393,216）。若上游按 `input + max_output ≤ window` 校验，prompt 真正能占的空间比
 * 声明窗口小一截（1,048,576 − 393,216 ≈ 655K）——水位线必须建在这个空间上。
 * `contextWindow` 非法/未知 → undefined（No-Fallback：不猜）。
 */
export function availablePromptTokens(
  contextWindow: unknown,
  maxOutputTokens: unknown,
): number | undefined {
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return undefined;
  }
  const reserve =
    typeof maxOutputTokens === "number" && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
      ? maxOutputTokens
      : Math.round(contextWindow * OUTPUT_RESERVE_RATIO);
  const available = contextWindow - reserve;
  // 预留吃满/超过窗口（如 maxOutputTokens ≥ contextWindow）→ 视为无法判定，
  // 不返回 0（那会让水位线为 0、每轮都压）；交给手动 /compact，绝不猜。
  return available > 0 ? available : undefined;
}

/**
 * 计算自动压缩水位线（tokens）：
 * - 基准 = 可用空间 × `COMPACTION_WATERMARK_RATIO`；
 * - 若已有「经验上限」（某次大 prompt 失败被 Fail-Fast 记录），再取
 *   `min(基准, 经验上限 × OBSERVED_CEILING_SAFETY_RATIO)`——让系统依据实测收敛到
 *   本机/本账号的真实限制，而不是相信服务端声明的窗口；
 * - 拿不到 `contextWindow` → undefined（退化为只给手动 `/compact`，绝不猜）。
 */
export function computeCompactionWatermark(
  contextWindow: unknown,
  maxOutputTokens: unknown,
  observedCeilingTokens?: number | null,
): number | undefined {
  const available = availablePromptTokens(contextWindow, maxOutputTokens);
  if (available === undefined) return undefined;
  const base = Math.round(available * COMPACTION_WATERMARK_RATIO);
  if (
    typeof observedCeilingTokens === "number" &&
    Number.isFinite(observedCeilingTokens) &&
    observedCeilingTokens > 0
  ) {
    return Math.min(base, Math.round(observedCeilingTokens * OBSERVED_CEILING_SAFETY_RATIO));
  }
  return base;
}

export interface TurnSlice {
  /** 轮在 messages 里的起止下标 [start, end)（含 user，含其后全部活动） */
  start: number;
  end: number;
}

/**
 * 把时间线切分成轮区间（与 UI 的 groupTurns 同口径：user 开轮，至下一条 user 前；
 * 无 user 开头的头部散条目算第 0 轮）。
 */
export function sliceTurns(messages: TimelineEntry[]): TurnSlice[] {
  const slices: TurnSlice[] = [];
  let start = 0;
  for (let i = 0; i < messages.length; i += 1) {
    if (i > 0 && messages[i].role === "user") {
      slices.push({ start, end: i });
      start = i;
    }
  }
  if (start < messages.length) slices.push({ start, end: messages.length });
  return slices;
}

/** 轮是否「在途」（含 streaming/running 条目）——在途轮绝不进压缩区间。 */
function turnIsInFlight(messages: TimelineEntry[], slice: TurnSlice): boolean {
  for (let i = slice.start; i < slice.end; i += 1) {
    const status = messages[i]?.status;
    if (status === "streaming" || status === "running") return true;
  }
  return false;
}

/** 轮是否已是 compact 产物（不重复压缩）。 */
function turnIsCompact(messages: TimelineEntry[], slice: TurnSlice): boolean {
  return (messages[slice.start] as TimelineEntry & { kind?: string })?.kind === COMPACT_KIND;
}

export interface CompactionRange {
  /** 待压缩区间 [startIndex, endIndex)（messages 下标） */
  startIndex: number;
  endIndex: number;
  /** 参与压缩的轮数（信息用） */
  turnCount: number;
}

/**
 * 计算可压缩区间：
 * - 全部轮中，保留最后 KEEP_RECENT_TURNS 轮原样；
 * - 更早的、非在途、非 compact 的连续轮构成压缩区间；
 * - 可压缩区间为空（轮数不足/全在途/已压缩）→ null。
 */
export function findCompactionRange(
  messages: TimelineEntry[],
  options?: { keepRecentTurns?: number },
): CompactionRange | null {
  const keep = options?.keepRecentTurns ?? KEEP_RECENT_TURNS;
  const slices = sliceTurns(messages);
  if (slices.length <= keep) return null;

  const candidates = slices.slice(0, slices.length - keep);
  // 连续段规则：在途轮**截断**（其后的轮与它在同一工作流里，压掉会丢上下文）；
  // 已压缩轮**跳过**（它们已经是摘要，后面照常可压）。
  let first = -1;
  let last = -1;
  for (let i = 0; i < candidates.length; i += 1) {
    const slice = candidates[i];
    if (turnIsInFlight(messages, slice)) break;
    if (turnIsCompact(messages, slice)) continue;
    if (first === -1) first = i;
    last = i;
  }
  if (first === -1) return null;
  return {
    startIndex: candidates[first].start,
    endIndex: candidates[last].end,
    turnCount: last - first + 1,
  };
}

/**
 * 构造摘要请求的输入文本（把待压缩区间的条目转成带角色的转录文本）。
 * 工具条目只保留名称 + 参数摘要 + 结果首行（摘要模型不需要全量结果）。
 */
export function buildCompactionSource(messages: TimelineEntry[], range: CompactionRange): string {
  const lines: string[] = [];
  for (let i = range.startIndex; i < range.endIndex; i += 1) {
    const m = messages[i];
    if (m.role === "user") {
      lines.push(`[User] ${m.text}`);
      continue;
    }
    if (m.role === "tool") {
      const firstLine = (m.resultText || "").split("\n")[0].slice(0, 200);
      lines.push(`[Tool:${m.toolName}] ${firstLine}`);
      continue;
    }
    // assistant：正文 + 思考摘要（决策常在思考里）
    const thinking = m.thinking ? ` (thinking: ${m.thinking.slice(0, 200)})` : "";
    lines.push(`[Assistant] ${m.text.slice(0, 800)}${thinking}`);
  }
  return lines.join("\n");
}

/**
 * 压缩提示词（对齐 ZCode core/compact/prompt.ts 的要点；单测锁定关键约束）。
 */
export function buildCompactionPrompt(source: string): string {
  return [
    "Summarize the conversation segment below for continuation. The summary will be",
    "the ONLY context available from this segment — future turns rely on it.",
    "",
    "Requirements:",
    "- Keep every concrete detail needed to continue: file paths, function/class names,",
    "  key decisions made and WHY, current task state, and unfinished work (explicit TODO list).",
    "- Preserve verbatim any security-relevant instructions or constraints the user stated.",
    "- Do not add information that is not in the segment. Do not editorialize.",
    "- Write in the same language as the segment. Be thorough but compact.",
    "",
    "--- CONVERSATION SEGMENT ---",
    source,
    "--- END OF SEGMENT ---",
  ].join("\n");
}

/** 从摘要模型返回的文本中提取摘要（剥离思考/围栏——模型可能包 ```）。 */
export function extractSummary(reply: string): string {
  let text = (reply ?? "").trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/.exec(text);
  if (fence) text = fence[1].trim();
  return text;
}

/**
 * 应用压缩：生成新的消息数组——
 * - [0, startIndex) 原样保留；
 * - 压缩区间替换为一条 compact 标记条目（id 稳定：`compact-<startIndex>`）；
 * - [endIndex, length) 原样保留。
 * 不改变 messages 数组以外的任何 state 字段。
 */
export function applyCompaction(
  messages: TimelineEntry[],
  range: CompactionRange,
  summary: string,
  nowMs: number,
): TimelineEntry[] {
  const compactEntry = {
    id: `compact-${range.startIndex}`,
    role: "assistant" as const,
    text: summary,
    thinking: "",
    status: "done" as const,
    kind: COMPACT_KIND,
    /** 被压缩的消息总数（UI 压缩带 chips 用；存条目上避免渲染层重算） */
    coveredCount: range.endIndex - range.startIndex,
    startedAt: nowMs,
    endedAt: nowMs,
  };
  return [
    ...messages.slice(0, range.startIndex),
    compactEntry as TimelineEntry,
    ...messages.slice(range.endIndex),
  ];
}

/** 条目是否为压缩标记（UI 与 toApiMessages 消费）。 */
export function isCompactEntry(entry: TimelineEntry): boolean {
  return (entry as TimelineEntry & { kind?: string }).kind === COMPACT_KIND;
}

/**
 * microcompact：发送前裁剪**较早的**大工具结果（对齐 ZCode microcompact）。
 *
 * ⚠ 数据形状（2026-10-05 修复历史 bug）：本函数作用于 `toApiMessages()` 产出的
 * pi-ai 消息数组——工具条目的 `role` 是 `"toolResult"`，正文在 `content` 的
 * `{ type: "text", text }` 块里。**不是**时间线条目（那是 `role: "tool"` + `resultText`）。
 * 旧实现只认时间线条目形状，调用点却一直传发送用的消息数组，两边对不上 ⇒ 一条都没
 * 裁过、上下文只增不减（正是 23 轮 / 226 步会话涨到 55 万 tokens 后断连的根源之一）。
 *
 * 语义约束（缓存友好）：
 * - **只改发送视图**：返回新的数组/对象，绝不改写时间线里的 `apiMessage` 原件
 *   （`toApiMessages` 是按引用推入这些原件的）；
 * - **确定性 + 幂等 + 单调**：同一输入永远同一输出；已带省略标记的不再二次裁剪，
 *   因此「裁过就不再变」，不会每步改写前缀、打穿 prompt 缓存；
 * - 尾部 `keepLastEntries` 条保持全文（模型当前还在用的结果不裁）；
 * - 只裁大块（> threshold），小结果与其后随内容不动——无收益的改写只会拖累缓存。
 */
export const MICROCOMPACT_THRESHOLD_BYTES = 4096;
export const MICROCOMPACT_KEEP_HEAD = 800;
export const MICROCOMPACT_KEEP_TAIL = 400;
export const MICROCOMPACT_KEEP_LAST_ENTRIES = 6;
const MICROCOMPACT_MARKER = "…[microcompacted:";

/** microcompact 作用的最小消息形状（pi-ai `Message` 的结构子集，避免类型耦合）。 */
export interface MicrocompactMessage {
  role?: string;
  content?: unknown;
}

export function microcompactMessages<T extends MicrocompactMessage>(
  messages: T[],
  options?: { thresholdBytes?: number; keepLastEntries?: number; keepHead?: number; keepTail?: number },
): T[] {
  const threshold = options?.thresholdBytes ?? MICROCOMPACT_THRESHOLD_BYTES;
  const keepLast = options?.keepLastEntries ?? MICROCOMPACT_KEEP_LAST_ENTRIES;
  const keepHead = options?.keepHead ?? MICROCOMPACT_KEEP_HEAD;
  const keepTail = options?.keepTail ?? MICROCOMPACT_KEEP_TAIL;
  const cutFrom = Math.max(0, messages.length - keepLast);
  let changed = false;
  const out = messages.map((entry, index) => {
    if (index >= cutFrom || !entry || entry.role !== "toolResult") return entry;
    const content = entry.content;
    if (!Array.isArray(content)) return entry;
    let entryChanged = false;
    const nextContent = content.map((block) => {
      if (!block || typeof block !== "object") return block;
      const typed = block as { type?: unknown; text?: unknown };
      if (
        typed.type !== "text" ||
        typeof typed.text !== "string" ||
        typed.text.length <= threshold ||
        typed.text.includes(MICROCOMPACT_MARKER)
      ) {
        return block;
      }
      const omitted = typed.text.length - keepHead - keepTail;
      entryChanged = true;
      return {
        ...(block as object),
        text: `${typed.text.slice(0, keepHead)}\n${MICROCOMPACT_MARKER} ${omitted} chars omitted for context budget; full result remains in the UI]…\n${typed.text.slice(-keepTail)}`,
      };
    });
    if (!entryChanged) return entry;
    changed = true;
    return { ...entry, content: nextContent } as T;
  });
  return changed ? out : messages;
}
