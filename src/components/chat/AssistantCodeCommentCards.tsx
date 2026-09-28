/**
 * AssistantCodeCommentCards —— 代码评论卡（P2-C2，ZCode AssistantCodeCommentCards 适配）。
 *
 * 数据来自 `::code-comment{...}` 行内指令解析（assistantCodeComment.ts），
 * 纯派生数据零持久化。单张可折叠卡片，展开为评论列表；P0 红色、其余中性；
 * 点击评论行 → 打开对应文件预览（onOpenComment 由挂载层接 openCodeViewer）。
 */
import { useState } from "react";
import { useTranslation } from "../../i18n";
import type { AssistantCodeCommentCard } from "../../lib/chat/codeComment/assistantCodeComment";

function displayTitle(card: AssistantCodeCommentCard): string {
  if (card.priority === undefined) return card.title;
  const prefix = `[P${card.priority}]`;
  return card.title.startsWith(prefix) ? card.title.slice(prefix.length).trimStart() : card.title;
}

function priorityClassName(priority: AssistantCodeCommentCard["priority"]): string {
  if (priority === 0) {
    return "border-destructive/40 bg-destructive/10 text-destructive";
  }
  return "border-border bg-background text-foreground-subtle";
}

function hasTextSelectionInCard(card: HTMLElement): boolean {
  if (typeof window === "undefined") return false;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  try {
    return selection.getRangeAt(0).intersectsNode(card);
  } catch {
    return false;
  }
}

export function AssistantCodeCommentCards({
  cards,
  onOpenComment,
}: {
  cards: readonly AssistantCodeCommentCard[];
  /** 点击评论行：挂载层打开文件预览。 */
  onOpenComment?: (card: AssistantCodeCommentCard) => void;
}) {
  const { t } = useTranslation();
  const tt = t as (key: string) => string;
  const [isOpen, setIsOpen] = useState(false);

  if (cards.length === 0) return null;

  return (
    <section
      data-testid="assistant-code-comment-cards"
      className="mt-2 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-elev)]"
    >
      <div
        data-testid="assistant-code-comment-header"
        className="flex h-10 items-center gap-2 px-3 transition-colors hover:bg-[var(--surface-hover)]"
      >
        <button
          type="button"
          className="flex h-full min-w-0 flex-1 items-center gap-2 px-1 text-left"
          aria-expanded={isOpen}
          aria-label={
            isOpen
              ? tt("codeCommentCardsCollapse").replace("{count}", String(cards.length))
              : tt("codeCommentCardsExpand").replace("{count}", String(cards.length))
          }
          onClick={() => setIsOpen((value) => !value)}
        >
          <span
            aria-hidden="true"
            className={`inline-block size-1.5 shrink-0 -rotate-45 border-r border-b border-[var(--text-dim)] transition-transform ${
              isOpen ? "rotate-45" : ""
            }`}
          />
          <h3 className="min-w-0 truncate text-sm font-medium text-[var(--text)]">
            {(cards.length === 1
              ? tt("codeCommentsOne")
              : tt("codeCommentsMany")
            ).replace("{count}", String(cards.length))}
          </h3>
        </button>
      </div>
      <div
        data-testid="assistant-code-comment-list"
        className={`flex flex-col ${isOpen ? "border-t border-[var(--border)]" : ""}`}
      >
        {isOpen
          ? cards.map((card) => {
              const locationLabel = card.startLine
                ? `${card.displayPath}:${
                    card.endLine && card.endLine !== card.startLine
                      ? `${card.startLine}–${card.endLine}`
                      : card.startLine
                  }`
                : card.displayPath;
              const title = displayTitle(card);
              const open = () => onOpenComment?.(card);

              return (
                <div key={card.id} className="bg-[var(--bg)]/50">
                  <div
                    role="button"
                    tabIndex={0}
                    data-code-comment-path={card.displayPath}
                    className="flex min-h-10 w-full min-w-0 cursor-pointer select-text items-center gap-3 px-6 py-2 text-left whitespace-nowrap transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none"
                    aria-label={tt("codeCommentCardsOpenReview").replace("{title}", title)}
                    onClick={(event) => {
                      if (hasTextSelectionInCard(event.currentTarget)) return;
                      open();
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      open();
                    }}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
                      {card.priority !== undefined ? (
                        <span
                          className={`shrink-0 rounded border px-1.5 py-0.5 text-xs font-medium ${priorityClassName(card.priority)}`}
                        >
                          P{card.priority}
                        </span>
                      ) : null}
                      <span className="min-w-0 shrink truncate text-sm font-medium text-[var(--text)]">
                        {title}
                      </span>
                      <span className="min-w-0 shrink truncate text-sm text-[var(--text-dim)]">
                        {locationLabel}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })
          : null}
      </div>
    </section>
  );
}
