/**
 * BackgroundWorkTrigger —— composer 工具条的运行中后台工作徽标 + 管理浮层
 * （对齐 ZCode ConversationBackgroundWorkTrigger + ConversationStatusPanel 的最小移植）。
 *
 * 徽标：running 的终端/子代理按类型显示「图标+计数」，全部为零时整个隐藏；
 * 点击展开浮层。浮层：分区列运行项（图标+描述+秒针时长+停止），终端行点击
 * 跳终端面板，子代理行点击跳右侧面板子代理视图。
 */

import { useEffect, useRef, useState } from "react";
import { Bot, Loader2, SquareTerminal } from "lucide-react";
import { useTranslation } from "../../i18n";
import { toast } from "../lw/ui/toast";
import { useAppStore } from "../../store/useAppStore";
import {
  stopSubagentWork,
  stopTerminalWork,
  useBackgroundWork,
  type BackgroundSubagentWork,
  type BackgroundTerminalWork,
} from "../../lib/chat/backgroundWork";

/** 秒针（1s 本地 interval；有浮层/时长显示才开销）。 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function formatElapsed(startedAtMs: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAtMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** 输出尾行摘要：取最后一个非空行，压缩空白，40 字符截断。 */
function outputSummary(tail: string): string {
  const lastLine = tail.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  return lastLine.length > 40 ? `${lastLine.slice(0, 39)}…` : lastLine;
}

export function BackgroundWorkTrigger() {
  const { t } = useTranslation();
  // 动态 i18n 键（bgWork* 查表）需要 string 签名
  const tf = t as unknown as (key: string) => string;
  const work = useBackgroundWork();
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const now = useNow(open || work.terminals.length + work.subagents.length > 0);

  const terminalCount = work.terminals.length;
  const subagentCount = work.subagents.length;
  const total = terminalCount + subagentCount;

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  if (total === 0) return null;

  const handleStopTerminal = async (item: BackgroundTerminalWork) => {
    setStopping(item.taskId);
    const stopped = await stopTerminalWork(item.taskId);
    setStopping(null);
    if (!stopped) toast.error(tf("bgWorkStopFailed").replace("{id}", item.taskId));
  };

  const handleStopSubagent = (item: BackgroundSubagentWork) => {
    setStopping(item.id);
    const ok = stopSubagentWork(item.id);
    setStopping(null);
    if (!ok) toast.error(tf("bgWorkStopFailed").replace("{id}", item.id));
  };

  const openTerminalPane = () => {
    setOpen(false);
    // 终端面板开关在 App 层（store.isTerminalOpen / toggleTerminal）
    useAppStore.getState().setTerminalOpen(true);
  };

  const openSubagentPane = () => {
    setOpen(false);
    // 子代理管理视图 = 右侧面板 subagents 来源（ focusId 定位可后续增强）
    useAppStore.getState().openCodeViewer({ type: "subagents", title: "子智能体" });
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={tf("bgWorkTitle")}
        className="flex items-center gap-2 rounded-lg px-2 py-1 text-xs transition-colors hover:bg-[var(--surface-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
      >
        {terminalCount > 0 ? (
          <span className="inline-flex items-center gap-0.5">
            <SquareTerminal className="size-3.5" />
            <span className="tabular-nums">{terminalCount}</span>
          </span>
        ) : null}
        {subagentCount > 0 ? (
          <span className="inline-flex items-center gap-0.5">
            <Bot className="size-3.5" />
            <span className="tabular-nums">{subagentCount}</span>
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute bottom-full left-0 mb-2 w-80 max-h-80 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl p-1.5 text-xs z-50">
          {terminalCount > 0 ? (
            <div className="mb-1">
              <div className="px-2 py-1 text-[11px] font-semibold text-[var(--text-dim)]">
                {tf("bgWorkTerminals").replace("{count}", String(terminalCount))}
              </div>
              {work.terminals.map((item) => (
                <button
                  key={item.taskId}
                  type="button"
                  onClick={openTerminalPane}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--surface-hover)] cursor-pointer"
                >
                  <SquareTerminal className="size-3.5 shrink-0 text-[var(--text-dim)]" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[11px] text-[var(--text-primary)]">
                      {item.taskId}
                    </span>
                    <span className="block truncate text-[10px] text-[var(--text-dim)]">
                      {outputSummary(item.outputTail) || tf("bgWorkNoOutput")}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums text-[10px] text-[var(--text-dim)]">
                    {formatElapsed(item.startedAtMs, now)}
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleStopTerminal(item);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.stopPropagation();
                        void handleStopTerminal(item);
                      }
                    }}
                    title={tf("bgWorkStop")}
                    className="shrink-0 rounded p-1 text-[var(--text-dim)] hover:bg-red-500/10 hover:text-red-500 cursor-pointer"
                  >
                    {stopping === item.taskId ? <Loader2 className="size-3 animate-spin" /> : <span className="block size-2.5 rounded-[2px] bg-current" />}
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          {subagentCount > 0 ? (
            <div>
              <div className="px-2 py-1 text-[11px] font-semibold text-[var(--text-dim)]">
                {tf("bgWorkSubagents").replace("{count}", String(subagentCount))}
              </div>
              {work.subagents.map((item) => (
                <div
                  key={item.id}
                  role="button"
                  tabIndex={0}
                  onClick={openSubagentPane}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') openSubagentPane();
                  }}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--surface-hover)]"
                >
                  <Bot className="size-3.5 shrink-0 text-[var(--text-dim)]" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] text-[var(--text-primary)]">
                      {item.description || item.type}
                    </span>
                    <span className="block truncate text-[10px] text-[var(--text-dim)]">
                      {item.type} · {item.id}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums text-[10px] text-[var(--text-dim)]">
                    {formatElapsed(item.startedAt, now)}
                  </span>
                  {item.stoppable ? (
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={() => handleStopSubagent(item)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") handleStopSubagent(item);
                      }}
                      title={tf("bgWorkStop")}
                      className="shrink-0 rounded p-1 text-[var(--text-dim)] hover:bg-red-500/10 hover:text-red-500 cursor-pointer"
                    >
                      {stopping === item.id ? <Loader2 className="size-3 animate-spin" /> : <span className="block size-2.5 rounded-[2px] bg-current" />}
                    </span>
                  ) : (
                    <span className="w-5 shrink-0" />
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
