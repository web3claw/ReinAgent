// LiveAgent 移植：crates/agent-ui/src/components/chat/ConversationViewTabs.tsx
// 适配：Tabs primitives → 普通按钮（同视觉/语义）；useLocale → useTranslation；
// IconSet → lucide-react（与 LA 同款图标：对话=MessageSquareText，轨迹=Waypoints）。
import { MessageSquareText, Waypoints } from "lucide-react";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import type { ConversationViewId } from "../../lib/trajectory/conversationViewState";

export type { ConversationViewId } from "../../lib/trajectory/conversationViewState";

export function ConversationViewTabs(props: {
  active: ConversationViewId;
  onChange: (view: ConversationViewId) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const tabs = [
    {
      id: "conversation",
      labelKey: "trajectory.tab.conversation",
      icon: MessageSquareText,
    },
    { id: "trajectory", labelKey: "trajectory.tab.trajectory", icon: Waypoints },
  ] as const;

  return (
    <div
      role="tablist"
      className={cn(
        "flex shrink-0 items-center gap-0.5",
        "rounded-lg border border-border/60 bg-muted/40 p-0.5",
        props.className,
      )}
    >
      {tabs.map((tab) => {
        const selected = props.active === tab.id;
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => {
              if (tab.id !== props.active) props.onChange(tab.id);
            }}
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-md px-2 text-xs transition-colors",
              "text-muted-foreground hover:bg-background/70 hover:text-foreground",
              selected && "bg-background font-medium text-foreground shadow-sm",
            )}
          >
            <Icon className="size-3.5" />
            <span>{t(tab.labelKey)}</span>
          </button>
        );
      })}
    </div>
  );
}
