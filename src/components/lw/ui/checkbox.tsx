// LiveAgent 移植：crates/agent-ui/src/components/ui/checkbox.tsx
// 适配：@base-ui/react Checkbox → 自写无依赖 button[role="checkbox"]；
// data-checked / data-indeterminate / data-unchecked 状态属性对齐 Base UI。
import { Check, Minus } from "lucide-react";
import * as React from "react";

type CheckboxProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "checked"> & {
  checked?: boolean;
  /** Uncontrolled initial state. */
  defaultChecked?: boolean;
  indeterminate?: boolean;
  onCheckedChange?: (checked: boolean, event: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  readOnly?: boolean;
};

export const Checkbox = React.forwardRef<HTMLButtonElement, CheckboxProps>(
  (
    {
      className,
      checked: checkedProp,
      defaultChecked = false,
      indeterminate = false,
      onCheckedChange,
      disabled,
      readOnly,
      onClick,
      ...props
    },
    ref,
  ) => {
    const [internal, setInternal] = React.useState(defaultChecked);
    const checked = checkedProp ?? internal;
    const active = indeterminate ? true : checked;
    return (
      <button
        type="button"
        role="checkbox"
        aria-checked={indeterminate ? "mixed" : checked}
        aria-disabled={disabled || undefined}
        disabled={disabled}
        ref={ref}
        data-checked={active ? "" : undefined}
        data-unchecked={!active ? "" : undefined}
        data-indeterminate={indeterminate ? "" : undefined}
        data-disabled={disabled ? "" : undefined}
        {...props}
        onClick={(event) => {
          onClick?.(event);
          if (event.defaultPrevented || readOnly || disabled) return;
          if (checkedProp === undefined) setInternal((prev) => !prev);
          onCheckedChange?.(!checked, event);
        }}
      >
        <span className="flex items-center justify-center data-[unchecked]:hidden" data-checked={active ? "" : undefined} data-unchecked={!active ? "" : undefined}>
          {indeterminate ? <Minus className="size-3" /> : <Check className="size-3" />}
        </span>
      </button>
    );
  },
);

Checkbox.displayName = "Checkbox";
