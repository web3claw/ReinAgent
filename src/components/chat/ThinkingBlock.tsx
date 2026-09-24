/**
 * ThinkingBlock —— 思考过程区块（对齐 ZCode ReasoningTrigger/Content，含三态折叠）。
 *
 * - 折叠状态机：`open = userToggle ?? streaming` ——
 *   流式中默认**展开**（限高滚动 + 自动吸底跟随最新思考）；思考完成**自动收成一行**
 *   「思考 · 持续了 N 秒」；用户手动点击后以用户为准（自动行为不再覆盖，对齐 ZCode
 *   shouldAutoCollapseReasoning 原则）。
 * - header：BrainIcon + 「思考」（流式「正在思考」）+ 「持续了 N 秒 / 持续了几秒」；
 * - 正文：最暗文字层 + 左导线缩进 + 限高 240px 滚动 + `whitespace-pre-wrap` 纯文本
 *   （流式期不做 Markdown 解析，对齐 ZCode 性能取舍）；
 * - 时长：完成态用冻结的 `thinkingDurationMs`（整秒向上取整）；流式且展开时用 liveNowMs
 *   实时跳动；历史数据无打点时如实显示「持续了几秒」，绝不伪造。
 */

import { useEffect, useRef, useState } from "react";
import { Brain, ChevronRight } from "lucide-react";
import type { ChatMessage } from "../../lib/chat/conversationModel";
import { MarkdownText } from "./MarkdownText";
import { useTranslation } from "../../i18n";

export interface ThinkingBlockProps {
  entry: ChatMessage;
  /** 每秒刷新的当前时间（由 MessageList 的 live tick 提供；仅在流式展开态使用）。 */
  liveNowMs?: number;
  /**
   * 所属轮次是否仍在运行（对齐用户确认的折叠时机）：整轮 running 期间思考块保持展开
   * 并持续吸底，轮完成的瞬间才自动收成一行（用户手动点击后归属用户，不再自动干预）。
   */
  turnRunning?: boolean;
}

export function ThinkingBlock({ entry, liveNowMs, turnRunning = false }: ThinkingBlockProps) {
  const { t } = useTranslation();
  /** 用户手动点击的选择（null = 未交互，折叠行为完全由运行状态派生）。 */
  const [userToggle, setUserToggle] = useState<boolean | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const hasThinking = entry.thinking.length > 0;
  const streaming = entry.status === "streaming";
  // 折叠时机 = 整轮完成（而非思考段自身完成）：轮内保持展开，轮结束自动收起。
  const active = streaming || turnRunning;
  const open = userToggle ?? active;

  // 展开且轮内运行时：每个思考增量到达时贴住底部（折叠态不为隐藏内容滚动）。
  useEffect(() => {
    if (!open || !active) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entry.thinking, open, active]);

  if (!hasThinking) return null;

  let seconds: number | undefined;
  if (entry.thinkingDurationMs !== undefined) {
    seconds = Math.max(1, Math.ceil(entry.thinkingDurationMs / 1000));
  } else if (streaming && entry.thinkingStartedAt !== undefined && typeof liveNowMs === "number") {
    seconds = Math.max(1, Math.ceil((liveNowMs - entry.thinkingStartedAt) / 1000));
  }

  const durationText =
    seconds !== undefined
      ? t("thinkingSeconds").replace("{seconds}", String(seconds))
      : t("thinkingFewSeconds");
  const label = streaming ? t("thinkingLive") : t("thinkingLabel");

  return (
    <div className="thinking-block group/thinking" data-streaming={streaming || undefined}>
      <button
        type="button"
        onClick={() => setUserToggle(!open)}
        className="thinking-trigger"
        aria-expanded={open}
      >
        <Brain className="w-4 h-4 shrink-0 text-[var(--text-dim)]" />
        <span className="thinking-label">
          {label}
          <span className="thinking-duration"> · {durationText}</span>
        </span>
        <ChevronRight
          className={`w-3.5 h-3.5 ml-0.5 transition-transform text-[var(--text-dim)] ${
            open ? "rotate-90 opacity-100" : "opacity-0 group-hover/thinking:opacity-60"
          }`}
        />
      </button>
      {open && (
        <div className="thinking-body" ref={bodyRef}>
          <div className="thinking-text md">
            <MarkdownText text={entry.thinking} />
          </div>
        </div>
      )}
    </div>
  );
}
