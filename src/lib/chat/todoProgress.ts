/**
 * todoProgress.ts —— 任务清单（todo_write）纯逻辑：清单提取与进度口径。
 *
 * 数据源：会话时间线里的 `todo_write` 工具条目（全量覆盖语义，随轮次落库，
 * 刷新后自然复原，无需新持久化字段）。
 * - `extractTodoLists`：提取清单胶囊（多胶囊并排数据源；归并口径见该函数注释，
 *   用户定稿 2026-10-08：同一份清单原地实时更新，完成封存后才新开）；
 * - `extractLatestTodos`：当前清单（末个胶囊，单胶囊时代的历史入口，现为其薄包装）。
 *
 * No-Fallback：无清单 / 空清单 / 缺字段一律返回空（UI 不渲染假进度）。
 */

import type { TimelineEntry } from "./conversationModel";

export interface TodoItemView {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/** 一份清单胶囊：key = 条目内容集合签名（React key 与关闭持久化共用）。 */
export interface TodoListSnapshot {
  key: string;
  todos: TodoItemView[];
  /** 是否已全部完成（UI 淘汰最老胶囊时优先藏已完成者）。 */
  completed: boolean;
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
 * 清单是否已全部完成。
 */
function isAllCompleted(todos: TodoItemView[]): boolean {
  return todos.every((t) => t.status === "completed");
}

/**
 * 胶囊稳定标识（React key 与关闭持久化共用）：按**条目内容集合**签名（排序去重）。
 * 同一份清单状态推进时 key 恒定（关闭态得以延续）；条目集合变了（换了一批任务）
 * 才换 key。
 */
function listKey(todos: TodoItemView[]): string {
  return JSON.stringify(todos.map((t) => t.content).sort());
}

/**
 * 按时间正序提取清单胶囊（多胶囊并排的数据源）。
 *
 * 归并口径（用户定稿 2026-10-08，取代 2026-10-06 的「按内容新增」）：
 * `todo_write` 是**全量覆盖**当前清单，故两次调用之间天然是同一份清单在推进——
 * - 末个胶囊**尚未全部完成**（存在 pending/in_progress）→ 原地更新该胶囊
 *   （改状态、加/删任务、改措辞皆就地刷新，不新开；避免堆出一排未完成胶囊）；
 * - 末个胶囊**已全部完成** → 封存；之后再来一份**含未完成项**的清单 → 新开胶囊；
 * - 新来的清单若也"全完成" → 原地更新末个胶囊（不新开无意义空壳）。
 *
 * 由此得到不变式：**除末个胶囊外，其余胶囊必然都是已完成态**（UI 的「超 3 个
 * 优先藏最老已完成」因此总有可藏目标）。已确认的取舍：中途放弃的半截未完成清单
 * 会被后一份清单原地覆盖，不在胶囊区单独留痕（仍可回看会话时间线）。
 *
 * - **显式空数组 = 清空清单**（覆盖语义）→ 已有胶囊全部消失；
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
    const allDone = isAllCompleted(todos);
    const last = lists[lists.length - 1];
    if (last && (!last.completed || allDone)) {
      // 末个胶囊仍可推进，或本次也全完成 → 原地更新（不新开）
      last.todos = todos;
      last.key = listKey(todos);
      last.completed = allDone;
    } else {
      lists.push({ key: listKey(todos), todos, completed: allDone });
    }
  }
  return lists;
}

/** 从时间线提取当前清单（末条快照；无则 null）。 */
export function extractLatestTodos(messages: TimelineEntry[]): TodoItemView[] | null {
  const lists = extractTodoLists(messages);
  return lists.length > 0 ? lists[lists.length - 1].todos : null;
}

/**
 * 选出要显示的胶囊（UI 上限控量，纯逻辑便于单测）：不超过 max 时原样返回；
 * 超出时淘汰**最老的已完成**胶囊（归并口径保证除末个外其余都是已完成态，故一定有
 * 可淘汰者，未完成的不会被藏）；最后兜底按最老的淘汰，保证绝不超上限。时间正序返回。
 */
export function selectVisibleCapsules(
  lists: TodoListSnapshot[],
  max: number,
): TodoListSnapshot[] {
  if (lists.length <= max) return lists;
  const overflow = lists.length - max;
  const drop = new Set<number>();
  for (let i = 0; i < lists.length && drop.size < overflow; i++) {
    if (lists[i].completed) drop.add(i);
  }
  for (let i = 0; i < lists.length && drop.size < overflow; i++) {
    if (!drop.has(i)) drop.add(i);
  }
  return lists.filter((_, i) => !drop.has(i));
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
