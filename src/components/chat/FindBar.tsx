/**
 * FindBar —— 会话内查找条（P2-A1，形态对齐 ZCode 会话内 find）。
 *
 * 浮在聊天区顶部的紧凑查找条：输入框 + 「第 n / m 处」计数 + 上下导航 +
 * Esc/关闭。命中跳转复用 MessageList 的 scrollTargetMessageId 机制
 * （滚动定位 + 消息高亮）；命中消息变化时自动跳转。
 */

import { useEffect } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { useConversationFind } from "./useConversationFind";
import { useTranslation } from "../../i18n";
import type { TimelineEntry } from "../../lib/chat/conversationModel";

export function FindBar({
  messages,
  onClose,
  onJumpToMessage,
}: {
  messages: TimelineEntry[];
  onClose: () => void;
  /** 命中消息变化时回调（App 层接 scrollTargetMessageId 滚动定位）。 */
  onJumpToMessage: (messageId: string) => void;
}) {
  const { t } = useTranslation();
  const { query, setQuery, hits, cursor, currentHit, goNext, goPrev, reset } =
    useConversationFind(messages);

  // 命中变化 → 通知跳转（当前命中消息）
  useEffect(() => {
    if (currentHit) onJumpToMessage(currentHit.messageId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentHit?.messageId]);

  return (
    <div
      data-testid="find-bar"
      className="fixed left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-1.5 shadow-lg"
    >
      <input
        autoFocus
        type="text"
        value={query}
        placeholder={t("findPlaceholder")}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            reset();
            onClose();
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) goPrev();
            else goNext();
          }
        }}
        className="w-56 bg-transparent text-sm text-[var(--text)] placeholder:text-[var(--text-dim)] focus:outline-none"
      />
      <span className="whitespace-nowrap text-xs tabular-nums text-[var(--text-dim)]">
        {hits.length > 0 ? `${cursor + 1} / ${hits.length}` : query ? t("findNoHits") : ""}
      </span>
      <button
        type="button"
        aria-label={t("findPrev")}
        title={t("findPrev")}
        disabled={hits.length === 0}
        onClick={goPrev}
        className="rounded p-0.5 text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-40"
      >
        <ArrowUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label={t("findNext")}
        title={t("findNext")}
        disabled={hits.length === 0}
        onClick={goNext}
        className="rounded p-0.5 text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-40"
      >
        <ArrowDown className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label={t("findClose")}
        title={t("findClose")}
        onClick={() => {
          reset();
          onClose();
        }}
        className="rounded p-0.5 text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
