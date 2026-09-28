// LiveAgent 移植：crates/agent-ui/src/components/ui/separator.tsx
// 适配：@base-ui/react Separator → 原生 div[role="separator"]。
import * as React from "react";

import { cn } from "../lib/utils";

export const Separator = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { orientation?: "horizontal" | "vertical" }
>(({ className, orientation = "horizontal", ...props }, ref) => (
  <div
    ref={ref}
    role="separator"
    aria-orientation={orientation}
    className={cn(
      "shrink-0 bg-border",
      orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
      className,
    )}
    {...props}
  />
));

Separator.displayName = "Separator";
