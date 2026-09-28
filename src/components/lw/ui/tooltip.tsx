// LiveAgent 移植：crates/agent-ui/src/components/ui/tooltip.tsx
// 适配：@base-ui/react Tooltip → @radix-ui/react-tooltip。
// - **必须含 Tooltip.Provider**（本项目有过无 Provider 崩溃的教训）：包装层内置 Provider；
// - Base UI `disabled`（Root）在 Radix 无对应 prop：由 Trigger 上的原生 disabled 兜底；
// - Base UI Trigger 的 `delay` / `closeOnClick` 形参在 Radix 无对应：延迟用 Root 的
//   `delayDuration` 表达，`closeOnClick` 忽略（仅影响点击后的提示驻留）；
// - Base UI createTooltipHandle 不移植（三个 Hub 页面未使用）。
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as React from "react";

import { cn } from "../lib/utils";
import { useZoneFontScaleStyle } from "./zone-font-scale";

export function Tooltip({
  children,
  disabled: _disabled,
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Root> & { disabled?: boolean }) {
  return (
    <TooltipPrimitive.Provider data-slot="tooltip-provider">
      <TooltipPrimitive.Root data-slot="tooltip" {...props}>
        {children}
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

export function TooltipTrigger(
  props: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger> & {
    /** Base UI 形参兼容：Radix 无对应实现，忽略。 */
    delay?: number;
    /** Base UI 形参兼容：Radix 无对应实现，忽略。 */
    closeOnClick?: boolean;
    /** Base UI 形参兼容：由 Root 的 delayDuration 表达，忽略。 */
    disabled?: boolean;
    render?: never;
  },
) {
  const { delay: _delay, closeOnClick: _closeOnClick, disabled: _disabled, ...rest } = props;
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...rest} />;
}

type TooltipContentProps = React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> &
  Pick<
    React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>,
    "align" | "collisionPadding" | "side" | "sideOffset"
  >;

export const TooltipContent = React.forwardRef<HTMLDivElement, TooltipContentProps>(
  (
    {
      align = "center",
      className,
      collisionPadding = 8,
      side = "top",
      sideOffset = 6,
      style,
      ...props
    },
    ref,
  ) => {
    const zoneStyle = useZoneFontScaleStyle();
    return (
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          ref={ref}
          align={align}
          collisionPadding={collisionPadding}
          side={side}
          sideOffset={sideOffset}
          data-slot="tooltip-content"
          className={cn(
            // hub-scope：Portal 挂 body，需自带 LiveAgent 色板作用域（lw 组件仅 Hub 页消费）
            "hub-scope layer-popover isolate max-w-64 rounded-lg border border-border/60 bg-popover px-2.5 py-1.5",
            "text-xs font-medium leading-4 text-popover-foreground shadow-lg outline-none transition-[transform,opacity] duration-150",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-[state=instant-open]:animate-in data-[state=instant-open]:fade-in-0 data-[state=instant-open]:zoom-in-95 motion-reduce:transition-none",
            className,
          )}
          style={{ ...zoneStyle, ...style }}
          {...props}
        />
      </TooltipPrimitive.Portal>
    );
  },
);
TooltipContent.displayName = "TooltipContent";
