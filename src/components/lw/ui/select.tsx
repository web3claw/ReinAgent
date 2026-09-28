// LiveAgent 移植：crates/agent-ui/src/components/ui/select.tsx
// 适配：@base-ui/react Select → 基于 @radix-ui/react-popover 的轻量 listbox。
// - Root/Trigger/Value/Content/Item 的 props 语义与 LA 保持一致（value/onValueChange/items/description...）；
// - 定位 prop（side/align/sideOffset/collisionPadding）直接映射 Radix Popover 同名 prop；
// - Base UI 的 ScrollUp/DownArrow 不再需要（Radix 内容区原生滚动）；
// - `min-w-(--anchor-width)`（Base UI 锚宽变量）→ `min-w-(--radix-popover-trigger-width)`。
import { Check, ChevronDown } from "lucide-react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as React from "react";
import { cn } from "../lib/utils";
import { floatingSurfaceClassName } from "./menu-surface";
import { useZoneFontScaleStyle } from "./zone-font-scale";

type SelectItemDescriptor = { value: string; label?: React.ReactNode; disabled?: boolean };

type SelectRootProps = {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Base UI 的 items 形态（对象数组 / 字符串数组 / Record），仅用于
   * SelectValue 未显式给 children 时的「值 → 标签」解析；列表渲染仍由
   * SelectContent 的 children（SelectItem）负责。
   */
  items?: readonly (SelectItemDescriptor | string)[] | Record<string, React.ReactNode>;
  children?: React.ReactNode;
};

type SelectContextValue = {
  value: string | undefined;
  setValue: (value: string) => void;
  setOpen: (open: boolean) => void;
  /** Radix Popover 的当前展开态；undefined 表示非受控。 */
  open: boolean | undefined;
  disabled: boolean;
};

const SelectContext = React.createContext<SelectContextValue | null>(null);

function collectItemLabels(node: React.ReactNode, map: Map<string, string>): void {
  React.Children.forEach(node, (child) => {
    if (!React.isValidElement(child)) return;
    const elementType = child.type as { displayName?: string } | string;
    const props = child.props as {
      value?: unknown;
      children?: React.ReactNode;
    };
    if (
      typeof elementType !== "string" &&
      elementType.displayName === "SelectItem" &&
      typeof props.value === "string"
    ) {
      // SelectItem 的字面 label（字符串/数字子内容）可作为触发器回显文案。
      if (typeof props.children === "string" || typeof props.children === "number") {
        map.set(props.value, String(props.children));
      }
    }
    collectItemLabels(props.children, map);
  });
}

function normalizeItems(items: SelectRootProps["items"]): Map<string, string> {
  const map = new Map<string, string>();
  if (!items) return map;
  if (Array.isArray(items)) {
    for (const entry of items) {
      if (typeof entry === "string") map.set(entry, entry);
      else if (entry && typeof entry.value === "string") {
        map.set(
          entry.value,
          typeof entry.label === "string" || typeof entry.label === "number"
            ? String(entry.label)
            : entry.value,
        );
      }
    }
  } else {
    for (const [key, label] of Object.entries(items)) {
      map.set(key, typeof label === "string" || typeof label === "number" ? String(label) : key);
    }
  }
  return map;
}

export function Select({
  value,
  defaultValue,
  onValueChange,
  disabled = false,
  open,
  onOpenChange,
  items,
  children,
}: SelectRootProps) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultValue);
  const current = value ?? uncontrolled;
  // 非受控时镜像 Radix 的展开态（供键盘导航 / 选项选择关闭弹层使用）。
  const [internalOpen, setInternalOpen] = React.useState(false);
  const effectiveOpen = open ?? internalOpen;
  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      setInternalOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  const scannedLabels = React.useRef(new Map<string, string>());
  // 每次渲染静态扫描 children 里的 SelectItem（value + 字面 label），
  // 弹层关闭（Radix 卸载内容）时触发器依然能解析文案。
  collectItemLabels(children, scannedLabels.current);
  const itemsLabels = React.useMemo(() => normalizeItems(items), [items]);

  const context = React.useMemo<SelectContextValue>(
    () => ({
      value: current,
      setValue: (next) => {
        if (value === undefined) setUncontrolled(next);
        onValueChange?.(next);
      },
      setOpen: handleOpenChange,
      open: effectiveOpen,
      disabled,
    }),
    [current, disabled, effectiveOpen, handleOpenChange, onValueChange, value],
  );

  // 首选标签解析：items prop 优先于静态扫描（调用方显式声明的数据更可信）。
  const resolvedLabel =
    current !== undefined
      ? (itemsLabels.get(current) ?? scannedLabels.current.get(current) ?? current)
      : undefined;
  const valueContext = React.useMemo(() => ({ resolvedLabel }), [resolvedLabel]);

  return (
    <SelectValueContext.Provider value={valueContext}>
      <PopoverPrimitive.Root open={open} onOpenChange={handleOpenChange}>
        <SelectContext.Provider value={context}>{children}</SelectContext.Provider>
      </PopoverPrimitive.Root>
    </SelectValueContext.Provider>
  );
}

const SelectValueContext = React.createContext<{ resolvedLabel: string | undefined }>({
  resolvedLabel: undefined,
});

type SelectValueProps = {
  placeholder?: React.ReactNode;
  children?: React.ReactNode | ((value: string | undefined) => React.ReactNode);
  className?: string;
  id?: string;
};

export const SelectValue = React.forwardRef<HTMLSpanElement, SelectValueProps>(
  ({ placeholder, children, className, ...props }, ref) => {
    const root = React.useContext(SelectContext);
    const { resolvedLabel } = React.useContext(SelectValueContext);
    const value = root?.value;
    let content: React.ReactNode;
    if (typeof children === "function") content = children(value);
    else if (children !== undefined && children !== null) content = children;
    else if (value !== undefined && value !== "") content = resolvedLabel ?? value;
    else content = placeholder ?? null;
    return (
      <span
        ref={ref}
        className={className}
        data-placeholder={value === undefined || value === "" ? "" : undefined}
        {...props}
      >
        {content}
      </span>
    );
  },
);
SelectValue.displayName = "SelectValue";

export const SelectTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<"button"> & { variant?: "default" | "plain" }
>(({ className, children, variant = "default", ...props }, ref) => (
  <PopoverPrimitive.Trigger ref={ref} asChild disabled={props.disabled}>
    <button
      type="button"
      data-slot="select-trigger"
      aria-haspopup="listbox"
      className={cn(
        "flex h-9 w-full items-center justify-between",
        "rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs",
        "placeholder:text-muted-foreground focus:border-input focus:outline-none focus:ring-0 focus:ring-offset-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0",
        "disabled:cursor-not-allowed disabled:opacity-50",
        variant === "plain" &&
          "border-0 bg-settings-tile-hover shadow-none focus-visible:ring-2 focus-visible:ring-ring/25",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronDown className="size-4 opacity-50" />
    </button>
  </PopoverPrimitive.Trigger>
));
SelectTrigger.displayName = "SelectTrigger";

type SelectContentProps = React.ComponentPropsWithoutRef<"div"> &
  Pick<
    React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>,
    "align" | "collisionPadding" | "side" | "sideOffset"
  > & {
    /** 仅兼容 Base UI 形参；本实现恒为 popper 定位。 */
    position?: "popper" | "item-aligned";
  };

type SelectContentInnerContextValue = {
  registerItem: (entry: { value: string; disabled: boolean; getId: () => string }) => () => void;
  highlightedValue: string | undefined;
  setHighlightedValue: (value: string | undefined) => void;
  select: (value: string) => void;
};

const SelectContentInnerContext = React.createContext<SelectContentInnerContextValue | null>(null);

export const SelectContent = React.forwardRef<HTMLDivElement, SelectContentProps>(
  (
    {
      align = "start",
      children,
      className,
      collisionPadding = 8,
      position: _position = "popper",
      side = "bottom",
      sideOffset = 4,
      style,
      ...props
    },
    ref,
  ) => {
    const zoneStyle = useZoneFontScaleStyle();
    return (
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          ref={ref}
          dir="ltr"
          align={align}
          side={side}
          sideOffset={sideOffset}
          collisionPadding={collisionPadding}
          data-slot="select-content"
          role="listbox"
          aria-orientation="vertical"
          className={cn(
            "layer-popover max-h-96 min-w-32 overflow-hidden",
            floatingSurfaceClassName,
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2",
            "data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
            // Base UI `min-w-(--anchor-width)`：弹出层至少与触发器同宽（调用方
            // 通过 className 传 min-w-* 时由 twMerge 优先保留调用方的）。
            "min-w-(--radix-popover-trigger-width)",
            className,
          )}
          style={{ ...zoneStyle, ...style }}
          {...props}
        >
          <SelectListBody>{children}</SelectListBody>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    );
  },
);
SelectContent.displayName = "SelectContent";

function SelectListBody({ children }: { children: React.ReactNode }) {
  const root = React.useContext(SelectContext);
  const [highlightedValue, setHighlightedValue] = React.useState<string | undefined>(undefined);
  const itemsRef = React.useRef<{ value: string; disabled: boolean; getId: () => string }[]>([]);

  const registerItem = React.useCallback(
    (entry: { value: string; disabled: boolean; getId: () => string }) => {
      itemsRef.current.push(entry);
      return () => {
        itemsRef.current = itemsRef.current.filter((item) => item !== entry);
      };
    },
    [],
  );

  const moveHighlight = React.useCallback(
    (delta: 1 | -1) => {
      const items = itemsRef.current.filter((item) => !item.disabled);
      if (items.length === 0) return;
      const index = items.findIndex((item) => item.value === highlightedValue);
      const next = items[(index + delta + items.length) % items.length];
      setHighlightedValue(next.value);
      document.getElementById(next.getId())?.scrollIntoView({ block: "nearest" });
    },
    [highlightedValue],
  );

  React.useEffect(() => {
    if (root?.open !== true) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveHighlight(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        moveHighlight(-1);
      } else if ((event.key === "Enter" || event.key === " ") && highlightedValue !== undefined) {
        event.preventDefault();
        root?.setValue(highlightedValue);
        root?.setOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [highlightedValue, moveHighlight, root]);

  const innerContext = React.useMemo<SelectContentInnerContextValue>(
    () => ({
      registerItem,
      highlightedValue,
      setHighlightedValue,
      select: (value) => {
        root?.setValue(value);
        root?.setOpen(false);
        setHighlightedValue(undefined);
      },
    }),
    [highlightedValue, registerItem, root],
  );

  return (
    <SelectContentInnerContext.Provider value={innerContext}>
      <div role="presentation" className="p-1 max-h-[inherit] overflow-y-auto">
        {children}
      </div>
    </SelectContentInnerContext.Provider>
  );
}

export const SelectItem = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div"> & {
    value: string;
    disabled?: boolean;
    /**
     * Optional secondary line rendered under the item label. Kept OUTSIDE the
     * label text on purpose: the plain label feeds the trigger's value
     * reflection, so rich item layouts go here.
     */
    description?: React.ReactNode;
  }
>(({ className, children, description, value, disabled = false, onClick, ...props }, ref) => {
  const content = React.useContext(SelectContentInnerContext);
  const elementId = React.useId();
  React.useEffect(
    () => content?.registerItem({ value, disabled, getId: () => elementId }),
    [content, disabled, elementId, value],
  );
  const highlighted = content?.highlightedValue === value;
  const selected = React.useContext(SelectContext)?.value === value;
  return (
    <div
      ref={ref}
      id={elementId}
      role="option"
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      data-highlighted={highlighted ? "" : undefined}
      data-selected={selected ? "" : undefined}
      data-disabled={disabled ? "" : undefined}
      tabIndex={-1}
      className={cn(
        "relative flex w-full cursor-default select-none items-center rounded-xs",
        "py-1.5 pl-2 pr-8 text-sm outline-hidden",
        "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
      onMouseEnter={() => content?.setHighlightedValue(value)}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || disabled) return;
        content?.select(value);
      }}
    >
      <span
        className={cn(
          "absolute right-2 flex size-3.5 items-center justify-center",
          description != null && "top-1/2 -translate-y-1/2",
        )}
      >
        {selected ? <Check className="size-4" /> : null}
      </span>
      {description == null ? (
        <span className="truncate">{children}</span>
      ) : (
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate">{children}</span>
          <span className="truncate text-tiny leading-tight text-muted-foreground/70">
            {description}
          </span>
        </span>
      )}
    </div>
  );
});
SelectItem.displayName = "SelectItem";
