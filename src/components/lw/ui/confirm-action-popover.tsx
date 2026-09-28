// LiveAgent 移植：crates/agent-ui/src/components/ui/confirm-action-popover.tsx
// 适配：Base UI PopoverTrigger/Close 的 render 组合 → Radix asChild；
// i18n 铁律：LA 内部使用 useLocale() 的默认文案（取消按钮）改为**必填 props**，
// 页面层负责传入 i18n 值（见各 prop 的 JSDoc）。
import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../lib/utils";
import { Button } from "./button";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "./popover";

export function ConfirmActionPopover(props: {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  /** 取消按钮文案。页面需传 i18n 值（LA 源码为 t("settings.cancel")）。 */
  cancelLabel: string;
  onConfirm: () => void;
  // Popover edge to align with the trigger; "end" suits right-aligned action
  // rows (settings lists), "start" left-aligned ones (assistant reply row),
  // "center" wide self-centered triggers (e.g. the full-width stats bar row).
  align?: "start" | "center" | "end";
  // Preferred trigger side to open from; the positioner flips on collision.
  side?: "top" | "bottom";
  // Visual intent: "destructive" (default) for irreversible actions,
  // "default" for non-destructive confirmations (e.g. branching).
  tone?: "destructive" | "default";
  // Controlled mode (both or neither): callers that gate opening on extra
  // state (e.g. the usage ring's two-tap touch flow) own the open state.
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: (open: () => void) => ReactNode;
}) {
  const {
    title,
    description,
    confirmLabel,
    cancelLabel,
    onConfirm,
    align = "end",
    side = "bottom",
    tone = "destructive",
    open,
    onOpenChange,
    children,
  } = props;

  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange ? (nextOpen) => onOpenChange(nextOpen) : undefined}
    >
      {/* Radix asChild 组合：触发器由调用方渲染，open() 仅为 Base UI 兼容签名（no-op） */}
      <PopoverTrigger asChild>{children(() => {}) as React.ReactElement}</PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        sideOffset={6}
        // hub-scope：Portal 挂 body，需自带 LiveAgent 色板作用域（确认气泡只在 Hub 页使用）
        className="hub-scope w-64 p-0"
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <div className="p-3">
          <div className="flex items-start gap-2.5">
            <div
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-lg",
                tone === "destructive" ? "bg-destructive/10" : "bg-primary/10",
              )}
            >
              <AlertTriangle
                className={cn(
                  "size-4",
                  tone === "destructive" ? "text-destructive" : "text-primary",
                )}
              />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{title}</p>
              <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {description}
              </div>
            </div>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <PopoverClose asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2.5 text-xs"
                onClick={(event) => event.stopPropagation()}
              >
                {cancelLabel}
              </Button>
            </PopoverClose>
            <PopoverClose asChild>
              <Button
                variant={tone === "destructive" ? "destructive" : "default"}
                size="sm"
                className="h-7 px-2.5 text-xs"
                onClick={(event) => {
                  event.stopPropagation();
                  onConfirm();
                }}
              >
                {confirmLabel}
              </Button>
            </PopoverClose>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * LA 的 ConfirmDeletePopover 通过 useLocale 组装文案；本移植改为全 props 注入，
 * 页面层需传：title（t("settings.deleteConfirm")）、confirmLabel（t("settings.delete")）
 * 与 description 组装函数（name 加粗嵌入 + "？"+ 说明，见 LA 源码）。
 */
export function ConfirmDeletePopover(props: {
  name: string;
  /** 页面需传 i18n 值（LA 源码为 t("settings.deleteConfirm")）。 */
  title: string;
  /** 页面需传 i18n 值（LA 源码为 t("settings.delete")）。 */
  confirmLabel: string;
  /** 页面需传 i18n 值（LA 源码为 t("settings.cancel")）。 */
  cancelLabel: string;
  /**
   * 描述组装：LA 源码为
   * `<>{t("settings.deleteConfirmYes")} <span className="font-medium text-foreground">{name}</span>？{t("settings.deleteConfirmDesc")}</>`
   */
  description?: (name: string) => ReactNode;
  onConfirm: () => void;
  children: (open: () => void) => ReactNode;
}) {
  const { name, title, confirmLabel, cancelLabel, description, onConfirm } = props;

  return (
    <ConfirmActionPopover
      title={title}
      description={
        description ? (
          description(name)
        ) : (
          <>
            <span className="font-medium text-foreground">{name}</span>
          </>
        )
      }
      confirmLabel={confirmLabel}
      cancelLabel={cancelLabel}
      onConfirm={onConfirm}
    >
      {props.children}
    </ConfirmActionPopover>
  );
}
