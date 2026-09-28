// LiveAgent 移植：crates/agent-ui/src/pages/settings/memory/DrawerSelect.tsx
// 适配：Select 为 lw/ui/select（Radix Popover 轻量 listbox，props 语义同 LA）；
// data-[open] → data-[state=open]（Radix 状态属性）；
// data-[placeholder] 着色改子元素作用域 [&_[data-placeholder]]；
// 弹层 className 追加 hub-scope（Portal 渲染在页面作用域外，需自带 Hub 色板）；
// min-w-(--anchor-width)（Base UI 锚宽）由 SelectContent 内建
// min-w-(--radix-popover-trigger-width) 提供，不再重复传入。

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../lw/ui/select";
import { cn } from "../lw/lib/utils";

export type DrawerSelectOption = {
  value: string;
  label: string;
  description?: string;
};

export function DrawerSelect(props: {
  value: string;
  onValueChange: (value: string) => void;
  options: DrawerSelectOption[];
  ariaLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  variant?: "default" | "plain";
}) {
  const { value, onValueChange, options, ariaLabel, placeholder, disabled, className } = props;
  const triggerClass = cn(
    "group/drawer-select inline-flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-sm leading-none text-foreground/90 shadow-xs",
    "outline-none transition-colors duration-150",
    "hover:bg-accent/40",
    "data-[state=open]:bg-accent/50",
    "[&_[data-placeholder]]:text-muted-foreground",
    "focus-visible:outline-none focus-visible:ring-0",
    "disabled:cursor-not-allowed disabled:opacity-50",
    props.variant === "plain" &&
      cn(
        "border-0 bg-settings-tile-hover shadow-none",
        "hover:bg-settings-active data-[state=open]:bg-background",
        "focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring/25",
      ),
    className,
  );

  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled} items={options}>
      <SelectTrigger aria-label={ariaLabel} className={triggerClass} disabled={disabled}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        className="hub-scope text-sm"
      >
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            description={option.description}
            className="cursor-pointer py-1.5 text-sm leading-tight"
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
