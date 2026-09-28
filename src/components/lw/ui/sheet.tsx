// LiveAgent 移植：crates/agent-ui/src/components/ui/sheet.tsx
// 适配：@base-ui/react Dialog → @radix-ui/react-dialog（Sheet 语义）。
// Base UI data-[starting-style]/data-[ending-style] 的位移/淡入 → Radix
// data-[state=open]/closed 的 slide-in-from-*/slide-out-to-* 等效类。
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";

import { cn } from "../lib/utils";
import { Button } from "./button";

export function Sheet(props: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="sheet" {...props} />;
}

export function SheetPortal(props: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

export function SheetTrigger(props: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

export function SheetClose(props: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="sheet-close" {...props} />;
}

export const SheetBackdrop = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    data-slot="sheet-backdrop"
    className={cn(
      "layer-modal fixed inset-0 bg-black/40 backdrop-blur-xs transition-opacity duration-200",
      "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 motion-reduce:transition-none",
      className,
    )}
    {...props}
  />
));
SheetBackdrop.displayName = "SheetBackdrop";

type SheetSide = "top" | "right" | "bottom" | "left";
type SheetVariant = "default" | "inset";

type SheetPopupProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  /** 页面需传入 i18n 文案（LA 默认 "Close"）。 */
  closeLabel?: string;
  closeProps?: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Close>;
  showCloseButton?: boolean;
  side?: SheetSide;
  variant?: SheetVariant;
};

export const SheetPopup = React.forwardRef<HTMLDivElement, SheetPopupProps>(
  (
    {
      side = "right",
      variant = "default",
      className,
      children,
      closeLabel = "Close",
      closeProps,
      showCloseButton = true,
      ...props
    },
    ref,
  ) => (
    <SheetPortal>
      <SheetBackdrop />
      <DialogPrimitive.Content
        ref={ref}
        data-slot="sheet-popup"
        data-side={side}
        className={cn(
          "layer-modal fixed flex max-h-full min-h-0 min-w-0 flex-col overflow-hidden",
          "bg-background text-foreground shadow-2xl outline-none",
          "transition-[translate,transform,opacity] duration-200 ease-out",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 motion-reduce:transition-none",
          side === "top" &&
            "inset-x-0 top-0 max-h-85dvh border-b data-[state=open]:slide-in-from-top-8 data-[state=closed]:slide-out-to-top-8",
          side === "right" &&
            "inset-y-0 right-0 w-inset-3rem max-w-lg border-l data-[state=open]:slide-in-from-right-8 data-[state=closed]:slide-out-to-right-8",
          side === "bottom" &&
            "inset-x-0 bottom-0 max-h-85dvh border-t data-[state=open]:slide-in-from-bottom-8 data-[state=closed]:slide-out-to-bottom-8",
          side === "left" &&
            "inset-y-0 left-0 w-inset-3rem max-w-lg border-r data-[state=open]:slide-in-from-left-8 data-[state=closed]:slide-out-to-left-8",
          variant === "inset" && side === "right" && "inset-y-4 right-4 rounded-2xl border",
          variant === "inset" && side === "left" && "inset-y-4 left-4 rounded-2xl border",
          variant === "inset" && side === "top" && "inset-x-4 top-4 rounded-2xl border",
          variant === "inset" && side === "bottom" && "inset-x-4 bottom-4 rounded-2xl border",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton ? (
          <DialogPrimitive.Close
            data-slot="sheet-close"
            aria-label={closeLabel}
            title={closeLabel}
            asChild
            className="absolute right-3 top-3 z-10"
            {...closeProps}
          >
            <Button variant="ghost" size="icon-sm">
              <X className="size-4" />
            </Button>
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </SheetPortal>
  ),
);
SheetPopup.displayName = "SheetPopup";

export const SheetHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="sheet-header"
      className={cn("flex shrink-0 flex-col gap-2 p-6", className)}
      {...props}
    />
  ),
);
SheetHeader.displayName = "SheetHeader";

export const SheetPanel = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="sheet-panel"
      className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain p-6", className)}
      {...props}
    />
  ),
);
SheetPanel.displayName = "SheetPanel";

type SheetFooterProps = React.HTMLAttributes<HTMLDivElement> & {
  variant?: "default" | "bare";
};

export const SheetFooter = React.forwardRef<HTMLDivElement, SheetFooterProps>(
  ({ className, variant = "default", ...props }, ref) => (
    <div
      ref={ref}
      data-slot="sheet-footer"
      className={cn(
        "flex shrink-0 flex-col-reverse gap-2 px-6 sm:flex-row sm:items-center sm:justify-end",
        variant === "default" && "border-t border-border bg-muted/40 py-4",
        variant === "bare" && "pb-6 pt-4",
        className,
      )}
      {...props}
    />
  ),
);
SheetFooter.displayName = "SheetFooter";

export const SheetTitle = React.forwardRef<
  HTMLHeadingElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    data-slot="sheet-title"
    className={cn("text-base font-semibold leading-none text-foreground", className)}
    {...props}
  />
));
SheetTitle.displayName = "SheetTitle";

export const SheetDescription = React.forwardRef<
  HTMLParagraphElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    data-slot="sheet-description"
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
SheetDescription.displayName = "SheetDescription";

export { SheetBackdrop as SheetOverlay, SheetPopup as SheetContent };
