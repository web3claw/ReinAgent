// LiveAgent 移植：crates/agent-ui/src/components/ui/popover.tsx
// 适配：@base-ui/react Popover → @radix-ui/react-popover。
// Base UI Trigger/Close 的 `render` 组合 → Radix `asChild`；
// data-[starting-style]/data-[ending-style] → data-[state=open]/closed 等效动画类。
import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as React from "react";

import { cn } from "../lib/utils";
import { floatingSurfaceClassName } from "./menu-surface";
import { useZoneFontScaleStyle } from "./zone-font-scale";

export function Popover(props: React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

export function PopoverTrigger(
  props: React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Trigger>,
) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

export function PopoverClose(props: React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Close>) {
  return <PopoverPrimitive.Close data-slot="popover-close" {...props} />;
}

type PopoverContentProps = React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> &
  Pick<
    React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>,
    "align" | "alignOffset" | "collisionPadding" | "side" | "sideOffset"
  >;

export const PopoverContent = React.forwardRef<HTMLDivElement, PopoverContentProps>(
  (
    {
      align = "center",
      alignOffset,
      className,
      collisionPadding = 8,
      side = "bottom",
      sideOffset = 4,
      style,
      ...props
    },
    ref,
  ) => {
    const zoneStyle = useZoneFontScaleStyle();
    return (
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          ref={ref}
          data-slot="popover-content"
          align={align}
          alignOffset={alignOffset}
          collisionPadding={collisionPadding}
          side={side}
          sideOffset={sideOffset}
          className={cn(
            floatingSurfaceClassName,
            // LA 浮层层级（layer-popover=10000）：Hub 页容器带 z-10，浮层无显式
            // z-index 时会被整页压住（弹层可见但点击全落在页面上）
            "layer-popover",
            "w-72 origin-(--radix-popover-content-transform-origin) p-4",
            "text-sm outline-none transition-[transform,scale,opacity] duration-150",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 motion-reduce:transition-none",
            className,
          )}
          style={{ ...zoneStyle, ...style }}
          {...props}
        />
      </PopoverPrimitive.Portal>
    );
  },
);
PopoverContent.displayName = "PopoverContent";

export const PopoverHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="popover-header"
      className={cn("flex flex-col gap-1", className)}
      {...props}
    />
  ),
);
PopoverHeader.displayName = "PopoverHeader";

// Radix Popover 无 Title/Description 导出（Base UI 有）：以普通元素 + 同类名实现，
// LA 三个 Hub 页面未使用这两个导出，仅为 API 兼容保留。
export const PopoverTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3
      ref={ref}
      data-slot="popover-title"
      className={cn("font-medium", className)}
      {...props}
    />
  ),
);
PopoverTitle.displayName = "PopoverTitle";

export const PopoverDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    data-slot="popover-description"
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
PopoverDescription.displayName = "PopoverDescription";
