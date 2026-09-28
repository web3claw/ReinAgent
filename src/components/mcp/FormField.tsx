// LiveAgent 移植：crates/agent-ui/src/components/settings/FormField.tsx
// Label 一并内联（LA 来源 crates/agent-ui/src/components/ui/label.tsx）；
// lw 组件库未提供该展示原语，页面本地承载。
import type { ComponentProps } from "react";

import { cn } from "../lw/lib/utils";

function Label({ className, ...props }: ComponentProps<"label">) {
  return <label className={cn("text-sm font-medium leading-none", className)} {...props} />;
}

/** Layout only: callers retain labels, control IDs, validation and field state. */
export function FormField({
  density = "default",
  className,
  ...props
}: ComponentProps<"div"> & { density?: "default" | "compact" }) {
  return <div {...props} className={cn(density === "compact" ? "space-y-1.5" : "space-y-2", className)} />;
}

export function FormFieldLabel({
  size = "default",
  className,
  ...props
}: ComponentProps<typeof Label> & { size?: "default" | "compact" }) {
  return (
    <Label
      {...props}
      className={cn(size === "compact" && "text-xs", "text-muted-foreground", className)}
    />
  );
}

export function FormFieldDescription({ className, ...props }: ComponentProps<"p">) {
  return <p {...props} className={cn("text-xs leading-5 text-muted-foreground", className)} />;
}
