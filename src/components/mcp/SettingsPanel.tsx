// LiveAgent 移植：crates/agent-ui/src/components/settings/SettingsPanel.tsx
// （仅页面用到的 SettingsPanel；SettingsHint 未使用不移植。）
import type { ComponentProps } from "react";

import { cn } from "../lw/lib/utils";

const variants = {
  collapsible: "overflow-hidden rounded-xl border border-border/60 bg-muted/20",
  configuration: "space-y-3 rounded-xl border border-border/70 bg-muted/35 p-4",
} as const;

/** Presentation only; callers retain content, semantics and state. */
export function SettingsPanel({
  variant,
  className,
  ...props
}: ComponentProps<"div"> & { variant: keyof typeof variants }) {
  return <div {...props} className={cn(variants[variant], className)} />;
}
