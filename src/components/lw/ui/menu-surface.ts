// LiveAgent 移植：crates/agent-ui/src/components/ui/menu-surface.ts
/** Shared chrome for lightweight floating surfaces (menus, popovers, selects). */
export const floatingSurfaceClassName =
  "rounded-xl border border-border/70 bg-popover text-popover-foreground shadow-xs";

/** Backwards-compatible semantic alias for menu-like custom surfaces. */
export const menuSurfaceClassName = floatingSurfaceClassName;
