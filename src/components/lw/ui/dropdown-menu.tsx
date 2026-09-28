// LiveAgent 移植：crates/agent-ui/src/components/ui/dropdown-menu.tsx
// 适配：@base-ui/react Menu → @radix-ui/react-dropdown-menu。
// - data-[open]/data-[closed] → data-[state=open]/data-[state=closed]；
// - Base UI `data-[popup-open]`（子菜单展开态）→ Radix SubTrigger 的 data-[state=open]；
// - Item 的 onSelect 映射 Radix onSelect（点击 / Enter 均触发）；closeOnClick=false
//   通过 preventDefault 保持菜单展开（Radix 语义）；
// - anchor / positionMethod / portalContainer 为 Base UI 专有形参，本层不透传。
import * as MenuPrimitive from "@radix-ui/react-dropdown-menu";
import * as React from "react";
import { cn } from "../lib/utils";
import { floatingSurfaceClassName, menuSurfaceClassName } from "./menu-surface";
import { useZoneFontScaleStyle } from "./zone-font-scale";

export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;
export const DropdownMenuSub = MenuPrimitive.Sub;

type MenuVariant = "default" | "soft";
const MenuVariantContext = React.createContext<MenuVariant>("default");
const softMenuClassName = cn(menuSurfaceClassName, "p-1.5");
const softItemClassName =
  "rounded-lg px-2.5 data-[highlighted]:bg-settings-active data-[highlighted]:text-foreground";

const popupClassName = cn(
  // LA 浮层层级：无显式 z-index 会被带 z-* 的页面容器压住
  "layer-popover",
  "min-w-48 max-h-select-popup overflow-x-hidden overflow-y-auto",
  floatingSurfaceClassName,
  "p-1",
  "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2",
  "data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
);

type MenuContentBaseProps = {
  variant?: MenuVariant;
  side?: React.ComponentPropsWithoutRef<typeof MenuPrimitive.Content>["side"];
  align?: React.ComponentPropsWithoutRef<typeof MenuPrimitive.Content>["align"];
  sideOffset?: number;
  collisionPadding?: number;
};

type MenuSubContentBaseProps = {
  variant?: MenuVariant;
  /** Radix SubContent 无 side 形参（跟随触发器方向）。 */
  align?: "start" | "end";
  sideOffset?: number;
  collisionPadding?: number;
};

type DropdownMenuContentProps = React.ComponentPropsWithoutRef<typeof MenuPrimitive.Content> &
  MenuContentBaseProps;

export const DropdownMenuContent = React.forwardRef<HTMLDivElement, DropdownMenuContentProps>(
  (
    {
      className,
      variant = "default",
      side,
      align,
      sideOffset = 4,
      collisionPadding,
      style,
      children,
      ...props
    },
    ref,
  ) => {
    const zoneStyle = useZoneFontScaleStyle();
    return (
      <MenuPrimitive.Portal>
        <MenuPrimitive.Content
          ref={ref}
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={collisionPadding}
          className={cn(popupClassName, variant === "soft" && softMenuClassName, className)}
          style={{ ...zoneStyle, ...style }}
          {...props}
        >
          <MenuVariantContext.Provider value={variant}>{children}</MenuVariantContext.Provider>
        </MenuPrimitive.Content>
      </MenuPrimitive.Portal>
    );
  },
);
DropdownMenuContent.displayName = "DropdownMenuContent";

export const DropdownMenuLabel = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("px-2 py-1.5 text-sm font-semibold", className)} {...props} />
));
DropdownMenuLabel.displayName = "DropdownMenuLabel";

export const DropdownMenuSeparator = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <MenuPrimitive.Separator ref={ref} className={cn("-mx-1 my-1 h-px bg-muted", className)} {...props} />
));
DropdownMenuSeparator.displayName = "DropdownMenuSeparator";

type DropdownMenuSubTriggerProps = React.ComponentPropsWithoutRef<typeof MenuPrimitive.SubTrigger> & {
  /** Menu-button style trigger（如 "⋯" 图标按钮）：禁用悬停展开。 */
  clickToggle?: boolean;
};

export const DropdownMenuSubTrigger = React.forwardRef<HTMLDivElement, DropdownMenuSubTriggerProps>(
  ({ className, clickToggle: _clickToggle, ...props }, ref) => (
    <MenuPrimitive.SubTrigger
      ref={ref}
      className={cn(
        "relative flex cursor-default select-none items-center rounded-xs px-2 py-1.5",
        "text-sm outline-hidden transition-colors",
        "data-[disabled]:pointer-events-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground data-[disabled]:opacity-50",
        React.useContext(MenuVariantContext) === "soft" && softItemClassName,
        className,
      )}
      {...props}
    />
  ),
);
DropdownMenuSubTrigger.displayName = "DropdownMenuSubTrigger";

export const DropdownMenuSubContent = React.forwardRef<HTMLDivElement, Omit<DropdownMenuContentProps, "side" | "align"> & MenuSubContentBaseProps>(
  (
    {
      className,
      variant = "default",
      children,
      align = "start",
      sideOffset = 6,
      collisionPadding,
      style,
      ...props
    },
    ref,
  ) => {
    const zoneStyle = useZoneFontScaleStyle();
    return (
      <MenuPrimitive.Portal>
        <MenuPrimitive.SubContent
          ref={ref}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={collisionPadding}
          className={cn(popupClassName, variant === "soft" && softMenuClassName, className)}
          style={{ ...zoneStyle, ...style }}
          {...props}
        >
          <MenuVariantContext.Provider value={variant}>{children}</MenuVariantContext.Provider>
        </MenuPrimitive.SubContent>
      </MenuPrimitive.Portal>
    );
  },
);
DropdownMenuSubContent.displayName = "DropdownMenuSubContent";

type DropdownMenuItemProps = React.ComponentPropsWithoutRef<typeof MenuPrimitive.Item> & {
  /** Base UI 语义：false 时选择后保持菜单展开。 */
  closeOnClick?: boolean;
};

export const DropdownMenuItem = React.forwardRef<HTMLDivElement, DropdownMenuItemProps>(
  ({ className, onSelect, closeOnClick, ...props }, ref) => (
    <MenuPrimitive.Item
      ref={ref}
      className={cn(
        "relative flex cursor-default select-none items-center rounded-xs px-2 py-1.5",
        "text-sm outline-hidden transition-colors",
        "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        React.useContext(MenuVariantContext) === "soft" && softItemClassName,
        className,
      )}
      {...props}
      onSelect={(event) => {
        if (closeOnClick === false) event.preventDefault();
        onSelect?.(event);
      }}
    />
  ),
);
DropdownMenuItem.displayName = "DropdownMenuItem";

export const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup;
export const DropdownMenuRadioItem = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => (
  <MenuPrimitive.RadioItem
    ref={ref}
    className={cn(
      "flex cursor-default items-center justify-between gap-3 rounded-md px-3 py-2",
      "text-sm outline-none data-[highlighted]:bg-accent data-[disabled]:opacity-50",
      React.useContext(MenuVariantContext) === "soft" && softItemClassName,
      className,
    )}
    {...props}
  >
    {children}
    <MenuPrimitive.ItemIndicator aria-hidden="true">✓</MenuPrimitive.ItemIndicator>
  </MenuPrimitive.RadioItem>
));
DropdownMenuRadioItem.displayName = "DropdownMenuRadioItem";
