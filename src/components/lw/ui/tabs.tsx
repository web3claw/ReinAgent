// LiveAgent 移植：crates/agent-ui/src/components/ui/tabs.tsx
// 适配：@base-ui/react Tabs → @radix-ui/react-tabs；类名 data-[active]: → data-[state=active]:（Radix 状态属性）。
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../lib/utils";

export const Tabs = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Root ref={ref} data-slot="tabs" className={cn(className)} {...props} />
));
Tabs.displayName = "Tabs";

const tabsListVariants = cva(
  "inline-flex h-8 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground",
  {
    variants: {
      variant: {
        default: "",
        plain: "",
        segmented: "h-9 gap-0.5 rounded-xl bg-segmented-track p-1 ring-1 ring-foreground/5",
        filter:
          "flex h-auto max-w-full flex-wrap justify-start gap-1 rounded-none bg-transparent p-0 pb-0.5",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export const TabsList = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & VariantProps<typeof tabsListVariants>
>(({ className, variant, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    data-slot="tabs-list"
    className={cn(variant !== "plain" && tabsListVariants({ variant }), className)}
    {...props}
  />
));
TabsList.displayName = "TabsList";

export const TabsTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> & {
    variant?: "default" | "plain" | "segmented";
  }
>(({ className, variant = "default", ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    data-slot="tabs-trigger"
    className={cn(
      variant !== "plain" && [
        "inline-flex min-h-6 items-center justify-center whitespace-nowrap rounded-md px-3 py-1",
        "text-sm font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm",
      ],
      variant === "segmented" && [
        "h-7 min-w-9 rounded-lg px-2.5 py-0 text-xs font-normal text-muted-foreground",
        "hover:bg-control-surface hover:text-foreground",
        "data-[state=active]:bg-segmented-selected data-[state=active]:font-medium data-[state=active]:text-foreground",
        "dark:data-[state=active]:[&_.text-muted-foreground]:text-foreground/75",
        "data-[state=active]:shadow-none",
      ],
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = "TabsTrigger";

export const TabsContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    data-slot="tabs-content"
    className={cn(
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=inactive]:hidden",
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = "TabsContent";
