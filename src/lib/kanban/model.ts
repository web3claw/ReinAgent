/**
 * 看板纯函数层（ROADMAP ⑤）：状态机镜像（后端白名单的前端副本，用于拖拽
 * 即时反馈与非法迁移拦截）+ 简报组装（卡片→执行 prompt）+ run 终态分流。
 * 纯模块，node --test 直跑；Rust kanban.rs 是唯一权威校验，这里只是 UX 前置。
 */

export const KANBAN_COLUMNS = [
  "Backlog",
  "Todo",
  "InProgress",
  "InReview",
  "Blocked",
  "Done",
  "Archived",
] as const;
export type KanbanColumn = (typeof KANBAN_COLUMNS)[number];

export const KANBAN_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type KanbanPriority = (typeof KANBAN_PRIORITIES)[number];

/** 状态机白名单（与 Rust COLUMN_TRANSITIONS 逐条对齐——改一处必须同步另一处）。 */
const TRANSITIONS: Record<KanbanColumn, KanbanColumn[]> = {
  Backlog: ["Todo", "Archived"],
  Todo: ["InProgress", "Backlog", "Archived"],
  InProgress: ["InReview", "Blocked", "Backlog"],
  InReview: ["Done", "InProgress", "Blocked", "Todo"],
  Blocked: ["Todo", "InProgress"],
  Done: ["Archived"],
  Archived: ["Backlog"],
};

export function isValidTransition(from: KanbanColumn, to: KanbanColumn): boolean {
  if (from === to) return true;
  return (TRANSITIONS[from] ?? []).includes(to);
}

/** 该列进入即触发执行（唯一自动化触发点，对齐 Hetu）。 */
export function triggersExecution(column: KanbanColumn): boolean {
  return column === "Todo";
}

// ==================== 简报组装 ====================

export interface KanbanCardBriefSource {
  title: string;
  description: string;
  priority: string;
  workspacePath: string;
  column: string;
}

export interface KanbanCommentLite {
  author: string;
  body: string;
}

const PRIORITY_LABEL: Record<string, string> = {
  low: "低",
  medium: "中",
  high: "高",
  urgent: "紧急",
};

const MAX_COMMENT_CHARS = 2000;
const MAX_COMMENTS_IN_BRIEF = 20;

/**
 * 卡片 → 执行简报（首轮执行用）：任务描述 + 约束 + 历史评论。
 * 首次执行（无历史评论）与重跑（带评论）共用——重跑时评论是新的要求来源。
 * 明确「无人在场、不要提问」：v1 无人值守语义（若模型仍提问会触发 ask_user
 * 挂起 → 卡片 Blocked，用户可在卡片上回答）。
 */
export function buildCardBrief(
  card: KanbanCardBriefSource,
  comments: KanbanCommentLite[],
): string {
  const lines: string[] = [];
  lines.push(`# 看板任务：${card.title}`);
  if (card.description.trim()) {
    lines.push("", card.description.trim());
  }
  lines.push("");
  lines.push("## 执行约定");
  lines.push(`- 优先级：${PRIORITY_LABEL[card.priority] ?? card.priority}`);
  if (card.workspacePath) lines.push(`- 工作区：${card.workspacePath}`);
  lines.push(
    "- 这是一次无人值守的后台执行：请自行完成并给出结论，不要等待人工确认。",
    "- 若确实缺少关键信息无法继续，可使用提问工具——卡片会被标记为「阻塞」，等人回答后继续。",
    "- 完成后请简要总结：做了什么、结论、需要后续跟进的事项。",
  );
  const usable = (comments ?? []).filter((c) => c && c.body && c.body.trim());
  if (usable.length > 0) {
    lines.push("", "## 历史评论（按时间顺序，最新要求以此为准）");
    for (const comment of usable.slice(-MAX_COMMENTS_IN_BRIEF)) {
      const body = comment.body.trim();
      const clipped = body.length > MAX_COMMENT_CHARS ? `${body.slice(0, MAX_COMMENT_CHARS)}…[truncated]` : body;
      lines.push(`- [${comment.author}] ${clipped}`);
    }
  }
  return lines.join("\n");
}

// ==================== Run 终态分流 ====================

export interface TerminalEventLike {
  taskId: string;
  outcome: string;
  error?: string | null;
  awaitingDecision?: boolean;
  lastAssistantText?: string;
}

export type RunVerdict =
  | { runStatus: "succeeded"; nextColumn: KanbanColumn }
  | { runStatus: "failed"; nextColumn: KanbanColumn; error: string }
  | { runStatus: "blocked"; nextColumn: KanbanColumn; reason: string };

/**
 * 回合终态 → run 状态 + 卡片目标列（纯函数，单测缝）。
 * - awaitingDecision（ask_user 挂起）→ blocked / Blocked 列——这是 automation
 *   的 5s 轮询永远等不到的场景（status 仍是 streaming），事件驱动天然解决。
 * - done → succeeded / InReview（等人工验收）
 * - error 或其他 → failed / Blocked
 */
export function resolveRunVerdict(event: TerminalEventLike): RunVerdict {
  if (event.awaitingDecision) {
    return {
      runStatus: "blocked",
      nextColumn: "Blocked",
      reason: "卡片等待你的回答（模型发起了提问）",
    };
  }
  if (event.outcome === "done") {
    return { runStatus: "succeeded", nextColumn: "InReview" };
  }
  const error = (event.error ?? "").trim() || "执行未正常结束";
  return { runStatus: "failed", nextColumn: "Blocked", error };
}

/** 优先级 → 卡片左侧色条 class（语义 token 之外的固定色，仅视觉编码）。 */
export function priorityBarClass(priority: string): string {
  switch (priority) {
    case "urgent":
      return "bg-red-500";
    case "high":
      return "bg-amber-500";
    case "medium":
      return "bg-blue-500";
    default:
      return "bg-slate-400";
  }
}
