/**
 * ConfirmDialog —— Promise 化确认对话框（对齐 LiveAgent confirm-dialog.tsx）。
 * 结构一致：标题 + 副标题 + 描述 + 等宽字体 detail 路径清单 + 底部 取消/确认；
 * 确认键默认 destructive 红色（回退等破坏性操作），hideCancel 用于结果告知框。
 * 颜色全部走主题语义变量，跟随 data-theme 换肤。
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";

export interface ConfirmDialogOptions {
  title: ReactNode;
  subtitle?: ReactNode;
  description?: ReactNode;
  /** 等宽字体的明细清单（如待回退路径），\n 分行。 */
  detail?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  hideCancel?: boolean;
}

interface PendingConfirmDialog extends ConfirmDialogOptions {
  resolve: (confirmed: boolean) => void;
}

function ConfirmDialogImpl({
  title,
  subtitle,
  description,
  detail,
  confirmLabel,
  cancelLabel,
  hideCancel = false,
  onCancel,
  onConfirm,
}: ConfirmDialogOptions & { onCancel: () => void; onConfirm: () => void }) {
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-xs" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[91] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl">
          <Dialog.Title className="break-words pr-10 text-base font-medium text-[var(--text)]">
            {title}
          </Dialog.Title>
          {subtitle ? (
            <div className="mt-1 break-words text-xs leading-relaxed text-[var(--text-secondary)]">
              {subtitle}
            </div>
          ) : null}
          <Dialog.Close
            className="absolute right-4 top-4 text-[var(--text-secondary)] transition-colors hover:text-[var(--text)]"
            aria-label={cancelLabel}
          >
            <X className="h-4 w-4" />
          </Dialog.Close>

          {description || detail ? (
            <div className="mt-3">
              {description ? (
                <Dialog.Description className="text-sm leading-relaxed text-[var(--text)]">
                  {description}
                </Dialog.Description>
              ) : null}
              {detail ? (
                <div className="mt-2.5 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-[var(--bg)] px-2.5 py-1.5 font-mono text-xs leading-5 text-[var(--text-secondary)]">
                  {detail}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="mt-4 flex justify-end gap-2">
            {hideCancel ? null : (
              <Dialog.Close
                autoFocus
                className="h-8 cursor-pointer rounded-lg border border-[var(--border)] px-3 text-xs text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)]"
              >
                {cancelLabel}
              </Dialog.Close>
            )}
            <button
              type="button"
              onClick={onConfirm}
              className="h-8 cursor-pointer rounded-lg bg-[var(--danger)] px-3 text-xs text-white transition-opacity hover:opacity-90"
            >
              {confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** `const { confirm, dialog } = useConfirmDialog();` —— confirm 返回 Promise<boolean>。 */
export function useConfirmDialog() {
  const [pending, setPending] = useState<PendingConfirmDialog | null>(null);
  const pendingRef = useRef<PendingConfirmDialog | null>(null);

  const close = useCallback((confirmed: boolean) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    current?.resolve(confirmed);
  }, []);

  const confirm = useCallback((options: ConfirmDialogOptions) => {
    return new Promise<boolean>((resolve) => {
      pendingRef.current?.resolve(false);
      const next = { ...options, resolve };
      pendingRef.current = next;
      setPending(next);
    });
  }, []);

  useEffect(() => {
    return () => {
      pendingRef.current?.resolve(false);
      pendingRef.current = null;
    };
  }, []);

  const dialog = pending ? (
    <ConfirmDialogImpl
      title={pending.title}
      subtitle={pending.subtitle}
      description={pending.description}
      detail={pending.detail}
      confirmLabel={pending.confirmLabel}
      cancelLabel={pending.cancelLabel}
      hideCancel={pending.hideCancel}
      onCancel={() => close(false)}
      onConfirm={() => close(true)}
    />
  ) : null;

  return { confirm, dialog };
}
