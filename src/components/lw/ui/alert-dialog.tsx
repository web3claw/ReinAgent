// LiveAgent 移植：crates/agent-ui/src/components/ui/alert-dialog.tsx
// 适配：@base-ui/react AlertDialog → 由 @radix-ui/react-dialog 组合出 AlertDialog 语义组件
// （项目未安装 @radix-ui/react-alert-dialog）。Radix Dialog 默认点击遮罩关闭，
// 这里在 Content 上阻止（Base UI AlertDialog 同样不允许点遮罩关闭）；Esc 关闭保留。
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";

import { cn } from "../lib/utils";
import { resolveZoneFontScale, ZoneFontScaleContext } from "./zone-font-scale";

export function AlertDialog(
  props: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root>,
) {
  return <DialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

export const AlertDialogPortal = DialogPrimitive.Portal;

export function AlertDialogClose(
  props: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Close>,
) {
  return <DialogPrimitive.Close data-slot="alert-dialog-close" {...props} />;
}

export function AlertDialogCloseButton({
  className,
  disabled,
  label,
}: {
  className?: string;
  disabled?: boolean;
  label: string;
}) {
  return (
    <DialogPrimitive.Close
      data-slot="alert-dialog-close-button"
      aria-label={label}
      title={label}
      disabled={disabled}
      asChild
      className={className}
    >
      <button type="button" className="shrink-0 rounded-lg">
        <X className="size-4" />
      </button>
    </DialogPrimitive.Close>
  );
}

const AlertDialogOverlay = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    data-slot="alert-dialog-overlay"
    className={cn(
      "layer-modal fixed inset-0 bg-black/40 backdrop-blur-xs transition-opacity duration-150",
      "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 motion-reduce:transition-none",
      className,
    )}
    {...props}
  />
));
AlertDialogOverlay.displayName = "AlertDialogOverlay";

// 与 dialog.tsx 的 DIALOG_FONT_SCALE 保持同一档位。
const ALERT_DIALOG_FONT_SCALE = 0.9;

type AlertDialogContentProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>;

export const AlertDialogContent = React.forwardRef<HTMLDivElement, AlertDialogContentProps>(
  ({ className, children, style, ...props }, ref) => {
    // 同 dialog.tsx：把缩放档位经 context 带过弹层的 portal 边界。
    const zoneFontScale = resolveZoneFontScale(style, ALERT_DIALOG_FONT_SCALE);
    return (
      <AlertDialogPortal data-slot="alert-dialog-portal">
        <AlertDialogOverlay />
        <div
          data-slot="alert-dialog-viewport"
          className={cn(
            "layer-modal fixed inset-0 flex min-h-0 flex-col items-center overflow-y-auto",
            "overscroll-contain px-4 pb-safe-bottom pt-safe-top",
          )}
        >
          <DialogPrimitive.Content
            ref={ref}
            data-slot="alert-dialog-content"
            style={{
              ...({ "--zone-font-scale": ALERT_DIALOG_FONT_SCALE } as React.CSSProperties),
              ...style,
            }}
            onInteractOutside={(event) => event.preventDefault()}
            className={cn(
              // 与 dialog.tsx 同源：弹窗自成一个字号缩放 zone（portal 渲染，
              // 落在所有 zone 之外），且 padding 由 header/body/footer 各自负责。
              "zone-font-scale",
              "relative my-auto w-full max-w-md",
              "rounded-2xl border border-border/70 bg-background text-foreground shadow-2xl outline-none",
              "transition-[transform,opacity] duration-150 ease-out",
              "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 motion-reduce:transition-none",
              className,
            )}
            {...props}
          >
            <ZoneFontScaleContext.Provider value={zoneFontScale}>
              {children}
            </ZoneFontScaleContext.Provider>
          </DialogPrimitive.Content>
        </div>
      </AlertDialogPortal>
    );
  },
);
AlertDialogContent.displayName = "AlertDialogContent";

export const AlertDialogHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="alert-dialog-header"
    className={cn(
      "relative flex shrink-0 flex-col min-h-13 gap-1.5",
      "px-4 py-3 max-[820px]:px-3.5 max-[820px]:py-2",
      className,
    )}
    {...props}
  />
));
AlertDialogHeader.displayName = "AlertDialogHeader";

export const AlertDialogBody = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="alert-dialog-body"
    className={cn("px-4 py-3 max-[820px]:p-3.5", className)}
    {...props}
  />
));
AlertDialogBody.displayName = "AlertDialogBody";

export const AlertDialogFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="alert-dialog-footer"
    className={cn(
      "flex shrink-0 flex-row items-center justify-end min-h-13 gap-2",
      "px-4 py-3",
      "max-[820px]:flex-col-reverse max-[820px]:items-stretch max-[820px]:px-3.5 max-[820px]:py-3",
      className,
    )}
    {...props}
  />
));
AlertDialogFooter.displayName = "AlertDialogFooter";

export const AlertDialogActions = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="alert-dialog-actions"
    className={cn(
      "flex min-w-0 items-center justify-end gap-2",
      "max-[820px]:w-full max-sm:grid max-sm:grid-cols-2 max-sm:has-[>:only-child]:grid-cols-1 max-sm:[&>button]:w-full",
      className,
    )}
    {...props}
  />
));
AlertDialogActions.displayName = "AlertDialogActions";

export const AlertDialogTitle = React.forwardRef<
  HTMLHeadingElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    data-slot="alert-dialog-title"
    className={cn("text-base font-semibold leading-none text-foreground", className)}
    {...props}
  />
));
AlertDialogTitle.displayName = "AlertDialogTitle";

export const AlertDialogDescription = React.forwardRef<
  HTMLParagraphElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    data-slot="alert-dialog-description"
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
AlertDialogDescription.displayName = "AlertDialogDescription";
