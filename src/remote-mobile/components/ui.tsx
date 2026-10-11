/** UI 基建 —— ZCode components/ui/button + dropdown-menu 的移动端最小同款（Radix 直用）。 */
import { forwardRef, type ButtonHTMLAttributes } from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { cn } from "../lib/cn";

type ButtonVariant = "ghost" | "outline" | "default" | "destructive";
type ButtonSize = "icon-sm" | "sm" | "default";

const variantClasses: Record<ButtonVariant, string> = {
  ghost: "hover:bg-surface-hover text-foreground",
  outline: "border border-border bg-card hover:bg-surface-hover text-foreground",
  default: "bg-brand text-white hover:opacity-90",
  destructive: "bg-destructive text-destructive-foreground hover:opacity-90",
};

const sizeClasses: Record<ButtonSize, string> = {
  "icon-sm": "size-7 p-0 rounded-md",
  sm: "h-8 px-2.5 gap-1.5 rounded-md text-ui-sm inline-flex items-center justify-center",
  default: "h-9 px-3 rounded-lg text-ui-base inline-flex items-center justify-center gap-1.5",
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }
>(function Button({ className, variant = "ghost", size = "default", type = "button", ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex items-center justify-center transition-colors disabled:pointer-events-none disabled:opacity-50 select-none",
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...props}
    />
  );
});

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

export function DropdownMenuContent({
  children,
  align = "end",
  className,
}: {
  children: React.ReactNode;
  align?: "start" | "center" | "end";
  className?: string;
}) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        align={align}
        sideOffset={6}
        data-slot="rc-popover-content"
        className={cn(
          "z-[100] min-w-[8rem] rounded-lg border border-popover-border bg-popover p-1 text-popover-foreground shadow-lg",
          className,
        )}
      >
        {children}
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  );
}

export function DropdownMenuLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-2 py-1.5 text-ui-xs font-medium text-foreground-subtle">{children}</div>;
}

export function DropdownMenuSeparator() {
  return <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />;
}

export function DropdownMenuRadioItem({
  value,
  children,
  onSelect,
  className,
}: {
  value: string;
  children: React.ReactNode;
  onSelect?: () => void;
  className?: string;
}) {
  return (
    <DropdownMenuPrimitive.RadioItem
      value={value}
      onSelect={onSelect}
      className={cn(
        "flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-ui-base outline-none data-[highlighted]:bg-surface-hover data-[state=checked]:text-foreground",
        className,
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <span className="size-1.5 rounded-full bg-brand" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

export function DropdownMenuItem({
  children,
  onSelect,
  className,
  destructive,
}: {
  children: React.ReactNode;
  onSelect?: () => void;
  className?: string;
  destructive?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.Item
      onSelect={onSelect}
      className={cn(
        "flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-ui-base outline-none data-[highlighted]:bg-surface-hover",
        destructive && "text-destructive",
        className,
      )}
    >
      {children}
    </DropdownMenuPrimitive.Item>
  );
}
