/**
 * EditableUserMessageBubble —— 编辑重发的行内编辑气泡（完整移植 LiveAgent
 * EditableUserMessageBubble 的结构与交互）：
 * - 受控 textarea，行数自适应（rows = max(2, 行数)）；
 * - 聚焦用 preventScroll 并恢复滚动视口位置（长对话编辑不拽走视口）；
 * - 键盘只有 Esc = 取消（Enter 是换行，必须点「发送」，对齐 LiveAgent）；
 * - 附件卡可移除；提交 trim，空文本且无附件禁提交。
 * 样式对齐原实现，颜色换用本项目主题语义变量。
 */

import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FileText, Image as ImageIcon, X } from "lucide-react";
import { useTranslation } from "../../i18n";
import type { UserAttachmentRef } from "../../lib/chat/attachments";

export interface EditableUserMessageBubbleProps {
  initialText: string;
  attachments: UserAttachmentRef[];
  preserveViewportScrollOnFocus?: boolean;
  onCancel: () => void;
  onSubmit: (text: string, attachments: UserAttachmentRef[]) => void;
}

export const EditableUserMessageBubble = memo(function EditableUserMessageBubble(
  props: EditableUserMessageBubbleProps,
) {
  const { initialText, attachments, preserveViewportScrollOnFocus = false, onCancel, onSubmit } = props;
  const { t } = useTranslation();
  const [draftText, setDraftText] = useState(initialText);
  const [draftAttachments, setDraftAttachments] = useState<UserAttachmentRef[]>(attachments);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setDraftAttachments(attachments);
  }, [attachments]);

  // 默认档：直接聚焦并把光标移到末尾。
  useLayoutEffect(() => {
    if (preserveViewportScrollOnFocus) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
  }, [preserveViewportScrollOnFocus]);

  // 编辑重发档：聚焦不滚动视口（preventScroll + 记录/恢复 [data-scroll-viewport] 的 scrollTop）。
  useEffect(() => {
    if (!preserveViewportScrollOnFocus) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const viewport = textarea.closest<HTMLDivElement>("[data-scroll-viewport]");
    const scrollTopBeforeFocus = viewport?.scrollTop ?? null;
    const restoreViewportScroll = () => {
      if (viewport && scrollTopBeforeFocus !== null) {
        viewport.scrollTop = scrollTopBeforeFocus;
      }
    };

    textarea.focus({ preventScroll: true });
    const cursorPosition = textarea.value.length;
    textarea.setSelectionRange(cursorPosition, cursorPosition);
    restoreViewportScroll();

    const animationFrameId = requestAnimationFrame(restoreViewportScroll);
    return () => cancelAnimationFrame(animationFrameId);
  }, [preserveViewportScrollOnFocus]);

  const canSubmit = draftText.trim().length > 0 || draftAttachments.length > 0;

  return (
    <div className="w-full max-w-2xl rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-md">
      {draftAttachments.length > 0 && (
        <div className="flex flex-wrap gap-2 pb-1">
          {draftAttachments.map((a) =>
            a.kind === "image" ? (
              <div key={a.path} className="relative">
                <div className="block h-16 w-16 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg)]">
                  {a.previewUrl ? (
                    <img src={a.previewUrl} alt={a.name} className="h-full w-full object-cover" />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center text-[var(--text-secondary)]">
                      <ImageIcon className="h-4 w-4" />
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setDraftAttachments((cur) => cur.filter((f) => f.path !== a.path))}
                  className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg-elev)] text-[var(--text-secondary)] hover:text-red-500"
                  title="移除"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            ) : (
              <div
                key={a.path}
                className="relative flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
              >
                <FileText className="h-3.5 w-3.5 text-blue-500" />
                <span className="max-w-40 truncate">{a.name}</span>
                <button
                  type="button"
                  onClick={() => setDraftAttachments((cur) => cur.filter((f) => f.path !== a.path))}
                  className="ml-1 text-[var(--text-secondary)] hover:text-red-500"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ),
          )}
        </div>
      )}
      <textarea
        ref={textareaRef}
        className="w-full resize-none rounded-lg bg-transparent p-2 leading-relaxed text-[var(--text)] outline-none"
        value={draftText}
        onChange={(event) => setDraftText(event.target.value)}
        rows={Math.max(2, draftText.split("\n").length)}
        aria-label={t("editMessage")}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onCancel();
          }
        }}
      />
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          className="cursor-pointer rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-xs text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)]"
          onClick={onCancel}
        >
          {t("cancel")}
        </button>
        <button
          type="button"
          className="cursor-pointer rounded-lg bg-[var(--brand)] px-3 py-1.5 text-xs text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!canSubmit}
          onClick={() => {
            if (!canSubmit) return;
            onSubmit(draftText.trim(), draftAttachments);
          }}
        >
          {t("send")}
        </button>
      </div>
    </div>
  );
});
