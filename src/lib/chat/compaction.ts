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
/** 触发自动压缩的上下文使用率阈值（80%，与 TASKS.md 定档一致）。 */
export const COMPACTION_TRIGGER_RATIO = 0.8;
/** 压缩条目的 kind 标记。 */
export const COMPACT_KIND = "compact" as const;

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
 * microcompact：发送前裁剪**较早轮次**的大工具结果（对齐 ZCode microcompact）。
 * - 只裁 tool 条目的 resultText（首部 + 尾部保留，中间以省略标记替代）；
 * - 当轮（ reciente）条目不动：`keepLastEntries` 指定从尾部起保留多少条不裁；
 * - 只影响发送视图，不改时间线（展示仍看原结果）。
 */
export const MICROCOMPACT_THRESHOLD_BYTES = 4096;
export const MICROCOMPACT_KEEP_HEAD = 800;
export const MICROCOMPACT_KEEP_TAIL = 400;

export function microcompactMessages(
  messages: TimelineEntry[],
  options?: { thresholdBytes?: number; keepLastEntries?: number },
): TimelineEntry[] {
  const threshold = options?.thresholdBytes ?? MICROCOMPACT_THRESHOLD_BYTES;
  const keepLast = options?.keepLastEntries ?? 6;
  const cutFrom = Math.max(0, messages.length - keepLast);
  let changed = false;
  const out = messages.map((entry, index) => {
    if (index >= cutFrom) return entry;
    if (entry.role !== "tool" || !entry.resultText || entry.resultText.length <= threshold) {
      return entry;
    }
    changed = true;
    const head = entry.resultText.slice(0, MICROCOMPACT_KEEP_HEAD);
    const tail = entry.resultText.slice(-MICROCOMPACT_KEEP_TAIL);
    const omitted = entry.resultText.length - MICROCOMPACT_KEEP_HEAD - MICROCOMPACT_KEEP_TAIL;
    return {
      ...entry,
      resultText: `${head}\n…[microcompacted: ${omitted} chars omitted for context budget; full result remains in the UI]…\n${tail}`,
    };
  });
  return changed ? out : messages;
}
