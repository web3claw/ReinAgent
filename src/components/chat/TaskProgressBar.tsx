/**
 * TaskProgressBar —— 任务清单进度条（对齐 LiveAgent TaskProgressBar 的轻量宿主版）。
 *
 * 数据源与进度口径见 `src/lib/chat/todoProgress.ts`（纯逻辑，单测直驱）。
 *
 * 形态（挂在输入框上方）：
 * - 圆环进度（N/M）+ 文案「任务进行中 · 第 X/Y 步」/「全部完成」；
 * - hover 用 Radix Tooltip 展开清单（每项状态图标 + 文案）；
 * - 无清单 / 清单为空 → 不渲染（No-Fallback：不显示假进度）。
 */

import { useMemo } from "react";
// ⚠️ 必须用 lw 的 Tooltip（内置 TooltipProvider）——直接用 radix primitive 会因缺
// Provider 崩掉整棵 React 树（本项目 2026-09-27 有过同类事故；Tauri 端实测复现）
import { Tooltip, TooltipContent, TooltipTrigger } from "../lw/ui/tooltip";
import { Check, Circle, ChevronRight } from "lucide-react";
import type { TimelineEntry } from "../../lib/chat/conversationModel";
import { extractLatestTodos, todoProgress as summarizeTodos } from "../../lib/chat/todoProgress";
import { useTranslation } from "../../i18n";

const RING_RADIUS = 7;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function TaskProgressBar({ messages }: { messages: TimelineEntry[] }) {
  const { t } = useTranslation();
  const todos = useMemo(() => extractLatestTodos(messages), [messages]);
  if (!todos) return null;
  const { total, done, current, percent } = summarizeTodos(todos);
  const allDone = done === total;

  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <button
          type="button"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          className="mb-1.5 inline-flex max-w-full items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-xs text-[var(--text-dim)] transition-colors hover:text-[var(--text)]"
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
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="start"
        sideOffset={6}
        className="max-w-md px-3 py-2"
      >
          <div className="space-y-1">
            {todos.map((todo, index) => (
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
      </TooltipContent>
    </Tooltip>
  );
}
