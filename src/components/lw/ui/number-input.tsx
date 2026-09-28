// LiveAgent 移植：crates/agent-ui/src/components/ui/number-input.tsx
// 适配：@base-ui/react NumberField → 自写受控 input[type=text]（数字过滤）+ 步进按钮。
// 保留 LA 的 value: number | null、onValueChange(number | null) 与 min/max/step 语义。
import { ChevronDown, ChevronUp, Minus, Plus } from "lucide-react";
import * as React from "react";

import { cn } from "../lib/utils";

export type NumberInputProps = {
  value?: number | null;
  /** Uncontrolled initial value. */
  defaultValue?: number | null;
  onValueChange?: (value: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  name?: string;
  variant?: "chevrons" | "plus-minus";
  className?: string;
  inputClassName?: string;
  rootClassName?: string;
  placeholder?: string;
  "aria-label"?: string;
  "aria-invalid"?: boolean;
  incrementLabel?: string;
  decrementLabel?: string;
};

const clampValue = (value: number, min: number | undefined, max: number | undefined) => {
  let next = value;
  if (min !== undefined) next = Math.max(min, next);
  if (max !== undefined) next = Math.min(max, next);
  return next;
};

export const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  (
    {
      value,
      defaultValue,
      onValueChange,
      min,
      max,
      step = 1,
      disabled,
      id,
      name,
      variant = "chevrons",
      className,
      inputClassName,
      rootClassName,
      placeholder,
      "aria-label": ariaLabel,
      "aria-invalid": ariaInvalid,
      incrementLabel = "Increase value",
      decrementLabel = "Decrease value",
      ...props
    },
    ref,
  ) => {
    const [internal, setInternal] = React.useState<number | null>(defaultValue ?? null);
    const current = value !== undefined ? value : internal;
    const [draft, setDraft] = React.useState<string | null>(null);
    const commit = React.useCallback(
      (next: number | null) => {
        const clamped =
          next === null || Number.isNaN(next) ? null : clampValue(next, min, max);
        if (value === undefined) setInternal(clamped);
        setDraft(null);
        onValueChange?.(clamped);
      },
      [max, min, onValueChange, value],
    );
    const displayed = draft ?? (current === null || current === undefined ? "" : String(current));
    const canDecrement = !disabled && current !== null && (min === undefined || current - step >= min);
    const canIncrement = !disabled && current !== null && (max === undefined || current + step <= max);
    const stepBy = (direction: 1 | -1) => {
      const base = current ?? clampValue(0, min, max) ?? 0;
      commit(clampValue(base + direction * step, min, max));
    };

    const stepButtonClassName = cn(
      "flex items-center justify-center",
      "text-muted-foreground transition-colors",
      "hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
    );

    return (
      <div
        data-slot="number-input"
        className={cn("w-full", rootClassName)}
        data-disabled={disabled ? "" : undefined}
        {...props}
      >
        <div
          className={cn(
            "relative inline-flex h-9 w-full items-stretch overflow-hidden",
            "whitespace-nowrap rounded-md border border-input bg-background text-sm shadow-xs outline-none",
            "transition-[color,box-shadow]",
            "focus-within:border-input focus-within:outline-hidden focus-within:ring-0 focus-within:ring-offset-0",
            "data-[invalid]:border-destructive data-[invalid]:ring-3 data-[invalid]:ring-destructive/20 dark:data-[invalid]:ring-destructive/40",
            "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
            className,
          )}
          data-disabled={disabled ? "" : undefined}
          data-invalid={ariaInvalid ? "" : undefined}
        >
          {variant === "plus-minus" ? (
            <button
              type="button"
              aria-label={decrementLabel}
              disabled={!canDecrement}
              className={cn(
                stepButtonClassName,
                "w-9 shrink-0",
                "border-r border-input",
              )}
              onClick={() => stepBy(-1)}
            >
              <Minus className="size-4" aria-hidden="true" />
            </button>
          ) : null}
          <input
            ref={ref}
            id={id}
            name={name}
            type="text"
            inputMode="numeric"
            aria-label={ariaLabel}
            aria-invalid={ariaInvalid}
            placeholder={placeholder}
            disabled={disabled}
            value={displayed}
            onChange={(event) => {
              const raw = event.target.value.trim();
              // 只放行可解析的数字形态；空串按 null（清空）处理。
              if (raw === "") {
                setDraft("");
                return;
              }
              setDraft(raw);
              const parsed = Number(raw);
              if (!Number.isNaN(parsed)) commit(parsed);
            }}
            onBlur={() => {
              if (draft !== null) {
                const parsed = Number(draft);
                commit(draft === "" || Number.isNaN(parsed) ? null : parsed);
              }
            }}
            className={cn(
              "min-w-0 flex-1 bg-transparent px-3 py-2 text-foreground tabular-nums outline-none",
              variant === "plus-minus" && "text-center",
              inputClassName,
            )}
          />
          {variant === "plus-minus" ? (
            <button
              type="button"
              aria-label={incrementLabel}
              disabled={!canIncrement}
              className={cn(
                stepButtonClassName,
                "w-9 shrink-0",
                "border-l border-input",
              )}
              onClick={() => stepBy(1)}
            >
              <Plus className="size-4" aria-hidden="true" />
            </button>
          ) : (
            <div className="flex w-7 shrink-0 flex-col border-l border-input">
              <button
                type="button"
                aria-label={incrementLabel}
                disabled={!canIncrement}
                className={cn(
                  stepButtonClassName,
                  "min-h-0 flex-1",
                  "border-b border-input",
                )}
                onClick={() => stepBy(1)}
              >
                <ChevronUp className="size-3" aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={decrementLabel}
                disabled={!canDecrement}
                className={cn(stepButtonClassName, "min-h-0 flex-1")}
                onClick={() => stepBy(-1)}
              >
                <ChevronDown className="size-3" aria-hidden="true" />
              </button>
            </div>
          )}
        </div>
      </div>
    );
  },
);

NumberInput.displayName = "NumberInput";
