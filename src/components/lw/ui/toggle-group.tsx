// LiveAgent 移植：crates/agent-ui/src/components/ui/toggle-group.tsx
// 适配：@base-ui/react Toggle/ToggleGroup → 自写无依赖实现。
// 语义对齐 Base UI：value 为数组（可多选），点击切换成员，onValueChange 回传新数组；
// 条目状态属性 data-pressed 与 Base UI 一致。
import * as React from "react";

import { cn } from "../lib/utils";

type ToggleGroupProps = Omit<React.HTMLAttributes<HTMLDivElement>, "onChange" | "value"> & {
  value?: string[];
  defaultValue?: string[];
  onValueChange?: (groupValue: string[]) => void;
  disabled?: boolean;
};

type ToggleGroupContextValue = {
  pressed: ReadonlySet<string>;
  toggle: (value: string) => void;
  disabled: boolean;
};

const ToggleGroupContext = React.createContext<ToggleGroupContextValue | null>(null);

export const ToggleGroup = React.forwardRef<HTMLDivElement, ToggleGroupProps>(
  (
    { value, defaultValue, onValueChange, disabled = false, className, ...props },
    ref,
  ) => {
    const [internal, setInternal] = React.useState<ReadonlySet<string>>(
      () => new Set(defaultValue ?? []),
    );
    const pressed = value !== undefined ? new Set(value) : internal;
    const toggle = React.useCallback(
      (itemValue: string) => {
        const next = new Set(pressed);
        if (next.has(itemValue)) next.delete(itemValue);
        else next.add(itemValue);
        if (value === undefined) setInternal(next);
        onValueChange?.(Array.from(next));
      },
      [onValueChange, pressed, value],
    );
    const context = React.useMemo<ToggleGroupContextValue>(
      () => ({ pressed, toggle, disabled }),
      [disabled, pressed, toggle],
    );
    return (
      <ToggleGroupContext.Provider value={context}>
        <div
          ref={ref}
          data-slot="toggle-group"
          role="group"
          className={cn("flex items-center", className)}
          {...props}
        />
      </ToggleGroupContext.Provider>
    );
  },
);
ToggleGroup.displayName = "ToggleGroup";

type ToggleGroupItemProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  value: string;
  disabled?: boolean;
};

export const ToggleGroupItem = React.forwardRef<HTMLButtonElement, ToggleGroupItemProps>(
  ({ className, value, disabled, onClick, ...props }, ref) => {
    const group = React.useContext(ToggleGroupContext);
    const pressed = group?.pressed.has(value) ?? false;
    const itemDisabled = disabled ?? group?.disabled ?? false;
    return (
      <button
        ref={ref}
        type="button"
        data-slot="toggle-group-item"
        aria-pressed={pressed}
        disabled={itemDisabled}
        data-pressed={pressed ? "" : undefined}
        data-disabled={itemDisabled ? "" : undefined}
        className={cn(
          "inline-flex items-center justify-center",
          "whitespace-nowrap rounded-md text-sm font-medium transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[pressed]:bg-accent data-[pressed]:text-accent-foreground",
          className,
        )}
        {...props}
        onClick={(event) => {
          onClick?.(event);
          if (event.defaultPrevented || itemDisabled) return;
          group?.toggle(value);
        }}
      />
    );
  },
);
ToggleGroupItem.displayName = "ToggleGroupItem";
