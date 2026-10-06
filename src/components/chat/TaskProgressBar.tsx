/**
 * TaskProgressBar —— 任务清单进度条（对齐 LiveAgent TaskProgressBar 的轻量宿主版）。
 *
 * 数据源与进度口径见 `src/lib/chat/todoProgress.ts`（纯逻辑，单测直驱）。
 *
 * 形态（挂在输入框上方，用户定稿 2026-10-06）：
 * - **多清单并排一行**：内容不同的 todo_write 各成一个胶囊，时间正序排列——
 *   新清单出现在第一个胶囊的右边，以此类推；只显示最近 MAX_VISIBLE_TODO_LISTS 个，
 *   更老的快照隐藏（数据仍在时间线，不丢）；
 * - 每个胶囊：圆环进度（N/M）+ 文案「任务进行中 · 第 X/Y 步」/「全部完成」；
 *   点击展开该清单浮层、再点收起（lw Popover；点外部 / Esc 也会收起）；
 *   行内 × 逐胶囊关闭，关闭签名按清单内容独立持久化（kv）；
 * - 无清单 / 全部被关闭 → 不渲染（No-Fallback：不显示假进度）。
 */

import { useMemo, useState } from "react";
// 浮层一律用 lw 组件（裸引 radix primitive 有缺 Provider/被页面层级压住的事故史）
import { Popover, PopoverContent, PopoverTrigger } from "../lw/ui/popover";
import { Check, Circle, ChevronRight, X } from "lucide-react";
import type { TimelineEntry } from "../../lib/chat/conversationModel";
import type { TodoListSnapshot, TodoItemView } from "../../lib/chat/todoProgress";
import { extractTodoLists, todoProgress as summarizeTodos } from "../../lib/chat/todoProgress";
import { useTranslation } from "../../i18n";
import { kvGet, kvSet } from "../../lib/storage/db";

const RING_RADIUS = 7;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** 胶囊行最多可见的清单数（更老的快照隐藏；数据仍在时间线里，不丢）。 */
const MAX_VISIBLE_TODO_LISTS = 5;
/** 逐胶囊关闭签名持久化（JSON 字符串数组；上限截断防无限增长）。 */
const DISMISSED_KEYS_KV = "reinagent-todo-dismissed-keys";
const DISMISSED_KEYS_MAX = 50;

function readDismissedKeys(): string[] {
  try {
    const raw = kvGet(DISMISSED_KEYS_KV);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((k) => typeof k === "string") : [];
  } catch {
    return [];
  }
}

function persistDismissedKeys(keys: string[]): void {
  kvSet(DISMISSED_KEYS_KV, JSON.stringify(keys.slice(-DISMISSED_KEYS_MAX)));
}

export function TaskProgressBar({ messages }: { messages: TimelineEntry[] }) {
  const lists = useMemo(() => extractTodoLists(messages), [messages]);
  // 被关闭的清单签名集合（state 镜像保证点击立即隐藏；kv 写入供重启恢复）
  const [dismissedKeys, setDismissedKeys] = useState<string[]>(readDismissedKeys);

  const alive = lists.filter((l) => !dismissedKeys.includes(l.key));
  const visible = alive.slice(-MAX_VISIBLE_TODO_LISTS);
  if (visible.length === 0) return null;

  const dismiss = (key: string) => {
    setDismissedKeys((prev) => {
      if (prev.includes(key)) return prev;
      const next = [...prev, key];
      persistDismissedKeys(next);
      return next;
    });
  };

  return (
    <div className="mb-1.5 inline-flex max-w-full items-center gap-2 overflow-x-auto">
      {visible.map((list) => (
        <TodoCapsule key={list.key} list={list} onDismiss={() => dismiss(list.key)} />
      ))}
    </div>
  );
}

function TodoCapsule({
  list,
  onDismiss,
}: {
  list: TodoListSnapshot;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const { total, done, current, percent } = summarizeTodos(list.todos);
  const allDone = done === total;

  return (
    <div className="inline-flex shrink-0 items-center gap-0.5">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
            className="inline-flex max-w-64 items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-xs text-[var(--text-dim)] transition-colors hover:text-[var(--text)]"
          >
            <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true" className="shrink-0">
              <circle
                cx="9"
                cy="9"
                r={RING_RADIUS}
                fill="none"
                stroke="currentColor"
                strokeOpacity="0.25"
                strokeWidth="2"
              />
              <circle
                cx="9"
                cy="9"
                r={RING_RADIUS}
                fill="none"
                stroke={allDone ? "var(--status-ok)" : "var(--brand)"}
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray={RING_CIRCUMFERENCE}
                strokeDashoffset={RING_CIRCUMFERENCE * (1 - percent / 100)}
                transform="rotate(-90 9 9)"
              />
            </svg>
            <span className="min-w-0 truncate">
              {allDone
                ? t("todoAllDone").replace("{total}", String(total))
                : t("todoProgress")
                    .replace("{done}", String(done))
                    .replace("{total}", String(total))}
            </span>
            {current && !allDone ? (
              <span className="min-w-0 truncate text-[var(--text)]/70">· {current.content}</span>
            ) : null}
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={6}
          // w-auto 抵消 lw PopoverContent 默认的 w-72 定宽：清单面板随内容自适应（上限 max-w-md）
          className="w-auto max-w-md px-3 py-2"
        >
          <div className="space-y-1">
            {list.todos.map((todo: TodoItemView, index: number) => (
              <div key={index} className="flex items-start gap-2 text-xs">
                {todo.status === "completed" ? (
                  <Check className="mt-0.5 size-3.5 shrink-0 text-[var(--status-ok)]" />
                ) : todo.status === "in_progress" ? (
                  <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-[var(--brand)]" />
                ) : (
                  <Circle className="mt-0.5 size-3.5 shrink-0 text-[var(--text-dim)]" />
                )}
                <span
                  className={
                    todo.status === "completed"
                      ? "text-[var(--text-dim)] line-through"
                      : "text-[var(--text)]"
                  }
                >
                  {todo.content}
                </span>
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      <button
        type="button"
        title={t("todoDismiss")}
        onClick={onDismiss}
        className="rounded p-0.5 text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] cursor-pointer"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
