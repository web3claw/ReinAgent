/**
 * ChatLoading —— 轮末加载指示器（完整移植 ZCode chat-loading.tsx）：
 * lucide LoaderIcon + animate-spin，弱化前景色；size="sm"（16px）用于回合尾部，
 * size="default"（24px）为通用尺寸。loading=false 时不渲染。
 */

import type { ComponentPropsWithoutRef } from "react";
import { LoaderIcon } from "lucide-react";
import { cn } from "../../preview/components/lib/utils";
import { useTranslation } from "../../i18n";

export interface ChatLoadingProps extends ComponentPropsWithoutRef<"div"> {
  loading: boolean;
  size?: "default" | "sm";
  className?: string;
}

export function ChatLoading({ loading, size = "default", className, ...props }: ChatLoadingProps) {
  const { t } = useTranslation();

  if (!loading) {
    return null;
  }

  const sizeClasses = size === "sm" ? "size-4 text-ui-base" : "size-6";

  return (
    <div
      aria-label={t("statusStreaming")}
      {...props}
      data-chat-loading="true"
      role="status"
      className={cn("flex items-center", className)}
    >
      <div className="flex size-4 items-center justify-center">
        <LoaderIcon
          aria-hidden="true"
          className={cn("animate-spin text-[var(--text-dim)]", sizeClasses)}
        />
      </div>
    </div>
  );
}
