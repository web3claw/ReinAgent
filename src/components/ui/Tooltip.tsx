import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

export const TooltipProvider = TooltipPrimitive.Provider;
export const TooltipRoot = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export interface TooltipProps {
  children: React.ReactNode;
  title: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  delayDuration?: number;
}

export function Tooltip({
  children,
  title,
  side = "top",
  align = "center",
  sideOffset = 5,
  delayDuration = 100,
}: TooltipProps) {
  if (!title) return <>{children}</>;

  return (
    <TooltipProvider delayDuration={delayDuration}>
      <TooltipRoot>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            align={align}
            sideOffset={sideOffset}
            className="z-50 px-2.5 py-1 text-xs text-white bg-[#1f2328] dark:bg-[#22272e] border border-[var(--border)] rounded-md shadow-lg animate-in fade-in-0 zoom-in-95 pointer-events-none select-none"
          >
            {title}
            <TooltipPrimitive.Arrow className="fill-[#1f2328] dark:fill-[#22272e]" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipRoot>
    </TooltipProvider>
  );
}
