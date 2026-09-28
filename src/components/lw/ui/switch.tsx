// LiveAgent 移植：crates/agent-ui/src/components/ui/switch.tsx
// 适配：@base-ui/react Switch → 自写无依赖 button[role="switch"]；
// Base UI 的 data-checked/data-unchecked/data-disabled 状态属性原样保留。
import * as React from "react";

import { cn } from "../lib/utils";

/** Shared internal state for SwitchRoot-style primitives. */
function useSwitchState(
  controlled: boolean | undefined,
  defaultChecked: boolean,
  onChange: ((checked: boolean) => void) | undefined,
) {
  const [internal, setInternal] = React.useState(defaultChecked);
  const checked = controlled ?? internal;
  const toggle = React.useCallback(() => {
    if (controlled === undefined) setInternal((prev) => !prev);
    onChange?.(!checked);
  }, [checked, controlled, onChange]);
  return [checked, toggle] as const;
}

type SwitchRootProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "checked"> & {
  checked?: boolean;
  /** Uncontrolled initial state. */
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  required?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
};

/** Unstyled parts for existing controls with a distinct track or hit area. */
export const SwitchRoot = React.forwardRef<HTMLButtonElement, SwitchRootProps>(
  (
    {
      checked: checkedProp,
      defaultChecked = false,
      onCheckedChange,
      disabled,
      readOnly,
      onClick,
      ...props
    },
    ref,
  ) => {
    const [checked, toggle] = useSwitchState(checkedProp, defaultChecked, onCheckedChange);
    return (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        ref={ref}
        data-checked={checked ? "" : undefined}
        data-unchecked={!checked ? "" : undefined}
        data-disabled={disabled ? "" : undefined}
        data-readonly={readOnly ? "" : undefined}
        {...props}
        onClick={(event) => {
          onClick?.(event);
          if (event.defaultPrevented || readOnly || disabled) return;
          toggle();
        }}
      />
    );
  },
);
SwitchRoot.displayName = "SwitchRoot";

export const SwitchThumb = React.forwardRef<
  HTMLSpanElement,
  React.HTMLAttributes<HTMLSpanElement>
>(({ className, ...props }, ref) => (
  <span ref={ref} data-slot="switch-thumb" className={className} {...props} />
));
SwitchThumb.displayName = "SwitchThumb";

type SwitchProps = SwitchRootProps & {
  tone?: "default" | "success";
  /** `sm` is for switches that sit inline with a label rather than owning a row. */
  size?: "default" | "sm" | "lg";
};

// Track and thumb have to move together: the thumb's travel is
// trackWidth - thumbWidth - inset, so overriding only the track from a call site
// would leave the thumb overshooting or short of the far edge.
const SWITCH_SIZES = {
  default: { track: "h-5 w-9", thumb: "size-4 data-[checked]:translate-x-18px" },
  sm: { track: "h-4 w-7", thumb: "size-3 data-[checked]:translate-x-14px" },
  lg: {
    track: "relative inline-block h-6 w-11",
    thumb: "absolute left-0.5 top-0.5 size-5 translate-x-0 data-[checked]:translate-x-5",
  },
} as const;

const switchTrackClassName =
  "shrink-0 rounded-full bg-muted-foreground/20 transition-colors data-[checked]:bg-sky-500";
const switchThumbClassName =
  "pointer-events-none block translate-x-0.5 rounded-full bg-white shadow-sm transition-transform";

/** Decorative state for a menu row that owns the checkbox interaction. */
export function SwitchIndicator({ checked, className }: { checked: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-checked={checked ? "" : undefined}
      className={cn(
        switchTrackClassName,
        "inline-flex items-center",
        SWITCH_SIZES.default.track,
        className,
      )}
    >
      <span
        data-checked={checked ? "" : undefined}
        className={cn(switchThumbClassName, SWITCH_SIZES.default.thumb)}
      />
    </span>
  );
}

export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ className, tone = "default", size = "default", ...props }, ref) => (
    <SwitchRoot
      ref={ref}
      data-slot="switch"
      className={cn(
        switchTrackClassName,
        "peer",
        size !== "lg" && "inline-flex cursor-pointer items-center",
        "focus-visible:outline-none focus-visible:ring-2 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60 data-[unchecked]:hover:bg-muted-foreground/30",
        SWITCH_SIZES[size].track,
        "data-[checked]:bg-sky-500 focus-visible:ring-sky-500/30",
        size === "lg" && tone === "default" && "focus-visible:ring-sky-500/35",
        className,
      )}
      {...props}
    />
  ),
);
Switch.displayName = "Switch";
