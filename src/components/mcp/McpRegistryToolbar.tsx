// LiveAgent 移植：crates/agent-ui/src/pages/mcp-hub/McpRegistryToolbar.tsx
// 适配：Base UI data-[active] → Radix data-[state=active]（lw/ui/tabs 同规则）。
import { KeyRound, RefreshCw } from "lucide-react";

import { RefreshButton } from "../lw/ui/button";
import { Tabs, TabsList, TabsTrigger } from "../lw/ui/tabs";
import { useHubTranslation } from "./i18n";
import {
  MCP_REGISTRY_SOURCE_OPTIONS,
  type McpRegistrySource,
} from "../../lib/mcpRegistry/index";
import { cn } from "../lw/lib/utils";

export function McpRegistryToolbar(props: {
  source: McpRegistrySource;
  loading: boolean;
  loadingMore: boolean;
  onSourceChange: (source: McpRegistrySource) => void;
  onRefresh: () => void;
  /** 打开 Glama API Key 配置弹窗（ReinAgent 增量；省略时不渲染入口） */
  onOpenApiKey?: () => void;
}) {
  const { t } = useHubTranslation();

  return (
    <div className="flex items-center justify-between gap-3">
      <Tabs
        value={props.source}
        onValueChange={(value) => {
          const nextSource = MCP_REGISTRY_SOURCE_OPTIONS.find(
            (option) => option.value === value,
          )?.value;
          if (nextSource) props.onSourceChange(nextSource);
        }}
        className="min-w-0 max-w-full"
      >
        <TabsList aria-label={t("mcpHub.tabStore")} variant="filter">
          {MCP_REGISTRY_SOURCE_OPTIONS.map((option) => (
            <TabsTrigger
              key={option.value}
              value={option.value}
              className={cn(
                "shrink-0 rounded-md border border-transparent px-2.5",
                "text-xs font-medium text-muted-foreground shadow-none",
                "hover:bg-muted/60 hover:text-foreground data-[state=active]:bg-muted data-[state=active]:text-foreground data-[state=active]:shadow-none",
              )}
            >
              {option.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {props.onOpenApiKey ? (
        <button
          type="button"
          onClick={props.onOpenApiKey}
          title={t("mcpHub.glamaApiKey")}
          aria-label={t("mcpHub.glamaApiKey")}
          className="inline-flex size-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border px-0 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:w-auto sm:px-3"
        >
          <KeyRound className="size-3.5" />
          <span className="hidden sm:inline">{t("mcpHub.glamaApiKey")}</span>
        </button>
      ) : null}

      <RefreshButton
        aria-busy={props.loading}
        size="sm"
        variant="outline"
        type="button"
        className="size-8 shrink-0 rounded-lg px-0 sm:w-auto sm:gap-1.5 sm:px-3"
        disabled={props.loading || props.loadingMore}
        onClick={props.onRefresh}
        title={t("mcpHub.storeRefresh")}
        aria-label={t("mcpHub.storeRefresh")}
      >
        <RefreshCw data-refresh-icon className={cn("size-3.5", props.loading && "animate-spin")} />
        <span className="hidden sm:inline">{t("mcpHub.storeRefresh")}</span>
      </RefreshButton>
    </div>
  );
}
