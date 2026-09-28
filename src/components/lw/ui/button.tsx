// LiveAgent 移植：crates/agent-ui/src/components/ui/button.tsx
// 适配：@base-ui/react useRender → 原生 button + 轻量 render 透传（cloneElement 合并 props/className/ref）。
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-6",
        icon: "size-9",
        "icon-sm": "size-8",
        "icon-xs": "size-7",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type ButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className"> &
  VariantProps<typeof buttonVariants> & {
    className?: string;
    /**
     * Base UI composition: replace the host element（仅支持 ReactElement 形态；
     * LA 三个 Hub 页面只用了这种形态，如 Button render={<a href/>}）。
     */
    render?: React.ReactElement;
  };

export const Button = React.forwardRef<HTMLElement, ButtonProps>(
  ({ className, variant, size, render, type = "button", ...props }, ref) => {
    const classes = cn(buttonVariants({ variant, size }), className);
    if (render) {
      // Base UI 语义：宿主元素替换，className 合并（宿主类名在外），ref 透传（React 19 ref-as-prop）。
      return React.cloneElement(render, {
        ...props,
        className: cn(classes, (render.props as { className?: string }).className),
        ref,
      } as React.HTMLAttributes<HTMLElement> & { ref: React.Ref<HTMLElement> });
    }
    return (
      <button
        {...(props as React.ButtonHTMLAttributes<HTMLButtonElement>)}
        type={type}
        ref={ref as React.Ref<HTMLButtonElement>}
        className={classes}
      />
    );
  },
);

Button.displayName = "Button";

/** Manual refresh feedback only; data and error handling remain with the caller. */
export const RefreshButton = React.forwardRef<HTMLElement, ButtonProps>(
  ({ className, onClick, disabled, ...props }, ref) => {
    const [minimumPending, setMinimumPending] = React.useState(false);
    const feedbackTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    React.useEffect(
      () => () => {
        if (feedbackTimer.current !== null) clearTimeout(feedbackTimer.current);
      },
      [],
    );
    const refreshing =
      minimumPending || props["aria-busy"] === true || props["aria-busy"] === "true";
    return (
      <Button
        {...props}
        ref={ref}
        disabled={disabled || refreshing}
        aria-busy={refreshing}
        className={cn(
          refreshing &&
            "[&_[data-refresh-icon]]:animate-spin motion-reduce:[&_[data-refresh-icon]]:animate-none",
          className,
        )}
        onClick={(event) => {
          if (disabled || refreshing || feedbackTimer.current !== null) return;
          setMinimumPending(true);
          feedbackTimer.current = setTimeout(() => {
            feedbackTimer.current = null;
            setMinimumPending(false);
          }, 500);
          onClick?.(event);
        }}
      />
    );
  },
);
RefreshButton.displayName = "RefreshButton";

export { buttonVariants };
