/**
 * todoProgress.ts —— 任务清单（todo_write）纯逻辑：清单提取与进度口径。
 *
 * 数据源：会话时间线里**最后一条** `todo_write` 工具条目（该工具是全量覆盖语义，
 * 末条即当前清单；随轮次落库，刷新后自然复原，无需新持久化字段）。
 *
 * No-Fallback：无清单 / 空清单 / 缺字段一律返回 null（UI 不渲染假进度）。
 */

import type { TimelineEntry } from "./conversationModel";

export interface TodoItemView {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/** 从时间线提取当前清单（末条 todo_write 条目的 args.todos；无则 null）。 */
export function extractLatestTodos(messages: TimelineEntry[]): TodoItemView[] | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const entry = messages[i];
    if (entry.role !== "tool" || entry.toolName !== "todo_write") continue;
    const raw = (entry.args as { todos?: unknown } | undefined)?.todos;
    if (!Array.isArray(raw)) continue;
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
  return null;
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
