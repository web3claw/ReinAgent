/**
 * todoProgress.ts —— 任务清单（todo_write）纯逻辑：清单提取与进度口径。
 *
 * 数据源：会话时间线里的 `todo_write` 工具条目（全量覆盖语义，随轮次落库，
 * 刷新后自然复原，无需新持久化字段）。
 * - `extractTodoLists`：按「内容新增」口径提取全部清单快照（多胶囊并排数据源，
 *   用户定稿 2026-10-06：内容不同即新开一份，UI 只显示最近 N 个）；
 * - `extractLatestTodos`：当前清单（末条快照，单胶囊时代的历史入口，现为其薄包装）。
 *
 * No-Fallback：无清单 / 空清单 / 缺字段一律返回空（UI 不渲染假进度）。
 */

import type { TimelineEntry } from "./conversationModel";

export interface TodoItemView {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/** 一份清单快照：key = 规范化内容的 JSON 签名（React key 与关闭持久化共用）。 */
export interface TodoListSnapshot {
  key: string;
  todos: TodoItemView[];
}

/** 归一化 todos 入参：合法且非空 → TodoItemView[]；空数组/非法形状 → null。 */
function normalizeTodos(raw: unknown): TodoItemView[] | null {
  if (!Array.isArray(raw)) return null;
  const todos: TodoItemView[] = [];
  for (const item of raw) {
    const record = item as { content?: unknown; status?: unknown };
    if (typeof record?.content !== "string") continue;
    const status =
      record.status === "completed"
        ? "completed"
        : record.status === "in_progress"
          ? "in_progress"
          : "pending";
    todos.push({ content: record.content, status });
  }
  return todos.length > 0 ? todos : null;
}

/**
 * 按时间正序提取全部清单快照（多胶囊并排的数据源，用户定稿「按内容新增」口径）：
 * - 内容与上一份快照**不同**的 todo_write → 新开一份快照（即使发生在同一轮；
 *   模型的进度推进 0/4→2/4 也会成列，由 UI 层「只显示最近 N 个」控量）；
 * - 内容与上一份**相同**的重复写入 → 跳过（同一份清单，不新增）；
 * - **显式空数组 = 清空清单**（覆盖语义）→ 已有快照全部消失；
 * - 缺 todos 字段 / 条目非法 → 跳过（非清除意图，不渲染假进度）。
 */
export function extractTodoLists(messages: TimelineEntry[]): TodoListSnapshot[] {
  const lists: TodoListSnapshot[] = [];
  for (const entry of messages) {
    if (entry.role !== "tool" || entry.toolName !== "todo_write") continue;
    const raw = (entry.args as { todos?: unknown } | undefined)?.todos;
    if (raw === undefined) continue;
    const todos = normalizeTodos(raw);
    if (todos === null) {
      if (Array.isArray(raw) && raw.length === 0) lists.length = 0;
      continue;
    }
    const key = JSON.stringify(todos);
    const last = lists[lists.length - 1];
    if (last && last.key === key) continue;
    lists.push({ key, todos });
  }
  return lists;
}

/** 从时间线提取当前清单（末条快照；无则 null）。 */
export function extractLatestTodos(messages: TimelineEntry[]): TodoItemView[] | null {
  const lists = extractTodoLists(messages);
  return lists.length > 0 ? lists[lists.length - 1].todos : null;
}

/** 清单进度摘要：done/total/current/percent（空清单 percent=0，不除零）。 */
export function todoProgress(todos: TodoItemView[]): {
  total: number;
  done: number;
  current: TodoItemView | null;
  percent: number;
} {
  const total = todos.length;
  const done = todos.filter((t) => t.status === "completed").length;
  const current = todos.find((t) => t.status === "in_progress") ?? null;
  const percent = total === 0 ? 0 : (done / total) * 100;
  return { total, done, current, percent };
}
