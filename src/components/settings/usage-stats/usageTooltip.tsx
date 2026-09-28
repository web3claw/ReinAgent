/**
 * usageTooltip —— ZCode ControlHintTooltip 的替代（P1-7 复刻移植）。
 *
 * ⚠ 行为对齐要点（用户实测反馈驱动）：
 * - 热力图 364 个格子每个都有提示，**必须共享一个 Provider**（每格自带 Provider
 *   会把 Radix 上下文树放到格子数量级，且各自默认 delayDuration=700ms——
 *   表现为「鼠标移上去迟迟不显示」）。Provider 由 UsageTooltipProvider 提供在
 *   UsageHeatmap 顶层，delayDuration=0 即时显示。
 * - lw/ui/tooltip 的封装自带 Provider 且不可调延迟，故这里直接用 Radix 原语。
 */

import type { ReactNode } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "../../../preview/components/lib/utils";

/** 热力图（及后续用量场景）共享的即时 Tooltip Provider。 */
export function UsageTooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={0} skipDelayDuration={0}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

export function UsageHintTooltip({ title, children }: { title: string; children: ReactNode }) {
  if (!title) {
    return <>{children}</>;
  }
  return (
    <TooltipPrimitive.Root delayDuration={0}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side="top"
          sideOffset={4}
          collisionPadding={8}
          className={cn(
            "z-50 max-w-64 whitespace-pre-wrap rounded-lg border border-border/60 bg-popover px-2.5 py-1.5",
            "text-xs font-medium leading-4 text-popover-foreground shadow-lg",
            "data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95",
          )}
        >
          {title}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
