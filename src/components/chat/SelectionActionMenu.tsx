/**
 * SelectionActionMenu —— 选区浮层菜单（P2-C1，对齐 ZCode SelectionActionMenu）。
 *
 * Portal 到 body 的 fixed 浮层：水平居中于选区、优先上方（放不下落下方）；
 * pointerdown preventDefault 防止点击菜单丢选区。菜单项：添加到当前任务 /
 * 复制。超限/重复引用由 addSelectionReference 返回错误码，这里显示提示条。
 */

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, MessageSquarePlus } from "lucide-react";
import { useTranslation } from "../../i18n";
import {
  addSelectionReference,
  type SelectionReference,
} from "../../lib/chat/selectionReference";

export function SelectionActionMenu({
  selection,
  taskId,
  onAddReference,
}: {
  selection: SelectionReference & { rect: { top: number; bottom: number; left: number; right: number } };
  taskId: string;
  onAddReference: () => void;
}) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  // 定位：水平居中于选区、优先上方
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const compute = () => {
      const rect = menu.getBoundingClientRect();
      const center = (selection.rect.left + selection.rect.right) / 2;
      const left = Math.max(
        12,
        Math.min(window.innerWidth - rect.width - 12, center - rect.width / 2),
      );
      const preferredTop = selection.rect.top - rect.height - 8;
      const top = preferredTop >= 12 ? preferredTop : selection.rect.bottom + 8;
      setPosition({ left, top });
    };
    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(menu);
    return () => observer.disconnect();
  }, [selection.rect.left, selection.rect.right, selection.rect.top, selection.rect.bottom]);

  // 点击菜单不丢选区
  const swallow = (e: React.PointerEvent | React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleAdd = () => {
    const error = addSelectionReference(taskId, {
      text: selection.text,
    } as SelectionReference);
    if (error === "single-limit") {
      setFeedback(t("selectionSingleLimit"));
      return;
    }
    if (error === "max-items") {
      setFeedback(t("selectionMaxItems"));
      return;
    }
    if (error === "total-limit") {
      setFeedback(t("selectionTotalLimit"));
      return;
    }
    if (error === "duplicate") {
      setFeedback(t("selectionDuplicate"));
      return;
    }
    onAddReference();
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(selection.text);
      setFeedback(t("selectionCopied"));
    } catch {
      setFeedback(t("selectionCopyFailed"));
    }
  };

  const content = (
    <div
      ref={menuRef}
      onPointerDown={swallow}
      onMouseDown={swallow}
      style={{
        left: position?.left ?? -9999,
        top: position?.top ?? -9999,
        visibility: position ? "visible" : "hidden",
      }}
      className="fixed z-50 flex flex-col gap-0.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1 shadow-2xl"
    >
      <button
        type="button"
        onClick={handleAdd}
        data-selection-action="add-to-task"
        className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--text)] hover:bg-[var(--surface-hover)]"
      >
        <MessageSquarePlus className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
        {t("selectionAddToTask")}
      </button>
      <button
        type="button"
        onClick={() => void handleCopy()}
        data-selection-action="copy"
        className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--text)] hover:bg-[var(--surface-hover)]"
      >
        <Copy className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
        {t("selectionCopy")}
      </button>
      {feedback ? (
        <div className="px-2.5 py-1 text-[11px] text-[var(--text-secondary)]">{feedback}</div>
      ) : null}
    </div>
  );

  return createPortal(content, document.body);
}
