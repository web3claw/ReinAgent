// LiveAgent 移植：crates/agent-ui/src/pages/mcp-hub/McpHubPage.tsx
// 适配：
// - props 形态：LA 的 settings/setSettings/isAgentMode props → 无 props 包装组件
//   `McpHubPage()`（App 以 <McpHubPage /> 使用），内部从 useHubSettings 取
//   settings/setSettings，再渲染 1:1 移植的 McpHubPageInner；isAgentMode 恒 true、
//   embedded 不传（LA 本页组件体仅消费 embedded，isAgentMode 未使用）。
// - 主题作用域：根 div 追加 hub-scope（弹层 Portal 内容在各自文件里单独追加）。
import { useMemo, useState } from "react";
import { Cloud, Download, Plus, Search, Server, AlertTriangle } from "lucide-react";

import { HubHeader } from "../lw/hub/HubChrome";
import { Badge } from "../lw/ui/badge";
import { Button } from "../lw/ui/button";
import { Input } from "../lw/ui/input";
import { Tabs, TabsContent } from "../lw/ui/tabs";
import { ResourceTabsList } from "../lw/resources/ResourceTabsList";
import { useHubTranslation } from "./i18n";
import { isHubHiddenServerId } from "../../lib/hub/mcpServerDefaults";
import type { McpServerConfig } from "../../lib/hub/mcpTypes";
import { useHubSettings, type HubAppSettings } from "../../store/hubSettingsStore";
import { cn } from "../lw/lib/utils";
import { McpImportView } from "./McpImportView";
import { McpRegistryBrowser } from "./McpRegistryBrowser";
import { McpServerEditModal, McpServersForm } from "./McpServersForm";
import { updateMcp } from "./hubSettingsAdapter";

type McpHubView = "installed" | "store" | "import";

type EditingState = { mode: "add" } | { mode: "edit"; idx: number; server: McpServerConfig };

function isMcpHubView(value: unknown): value is McpHubView {
  return value === "installed" || value === "store" || value === "import";
}

function McpHubPageInner(props: {
  settings: HubAppSettings;
  setSettings: (updater: (prev: HubAppSettings) => HubAppSettings) => void;
}) {
  const { settings, setSettings } = props;
  const { t } = useHubTranslation();
  const [view, setView] = useState<McpHubView>("installed");
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [searchQueries, setSearchQueries] = useState<Record<McpHubView, string>>({
    installed: "",
    store: "",
    import: "",
  });

  // 与 McpServersForm 的列表口径一致：由专属设置页托管的 server 不计入
  // Hub 的徽章，否则会出现「0 个 server 却显示 1/1 已启用」。
  const visibleServers = useMemo(
    () => settings.mcp.servers.filter((server) => !isHubHiddenServerId(server.id)),
    [settings.mcp.servers],
  );
  const serverCount = visibleServers.length;
  const enabledCount = visibleServers.filter((server) => server.enabled).length;
  const activeSearchQuery = searchQueries[view];
  const searchPlaceholder =
    view === "store"
      ? t("mcpHub.storeSearchPlaceholder")
      : view === "import"
        ? t("mcpHub.importSearchPlaceholder")
        : t("mcpHub.searchInstalled");

  function openAdd() {
    setView("installed");
    setEditing({ mode: "add" });
  }

  function openEdit(server: McpServerConfig, idx: number) {
    setEditing({ mode: "edit", idx, server });
  }

  function handleModalSave(server: McpServerConfig) {
    setSettings((prev) => {
      if (editing?.mode === "edit") {
        const targetIdx = editing.idx;
        return updateMcp(prev, {
          servers: prev.mcp.servers.map((item, index) => (index === targetIdx ? server : item)),
        });
      }
      return updateMcp(prev, {
        servers: [...prev.mcp.servers, server],
      });
    });
  }

  return (
    <div
      className={cn(
        "hub-page hub-scope relative flex h-full min-h-0 flex-1 flex-col overflow-hidden",
        "bg-background",
      )}
    >
      <div className="relative z-10 flex h-full min-h-0 flex-col overflow-hidden">
        <HubHeader
          title="MCP Hub"
          subtitle={t("mcpHub.subtitle")}
          prominent
          actions={
            <div className="flex items-center gap-2">
              <Badge
                variant={enabledCount > 0 ? "success" : "muted"}
                className="hidden h-7 gap-1 tabular-nums sm:inline-flex"
              >
                {serverCount > 0
                  ? `${enabledCount}/${serverCount} ${t("mcpHub.enabled")}`
                  : t("mcpHub.statusEmpty")}
              </Badge>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 px-3"
                onClick={openAdd}
                title={t("mcpHub.add")}
              >
                <Plus className="size-3.5" />
                <span className="hidden whitespace-nowrap sm:inline">{t("mcpHub.add")}</span>
              </Button>
            </div>
          }
        />

        <div className="hub-scroll min-h-0 flex-1 overflow-hidden px-5 pb-6 sm:px-6 lg:px-8 xl:px-10">
          <div className="hub-content-stage mx-auto flex size-full min-h-0 max-w-1320px flex-col">
            <Tabs
              value={view}
              onValueChange={(nextView) => {
                if (isMcpHubView(nextView)) setView(nextView);
              }}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="relative mb-5">
                <Search className="pointer-events-none absolute left-4 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  value={activeSearchQuery}
                  onChange={(event) => {
                    const nextQuery = event.currentTarget.value;
                    setSearchQueries((current) => ({ ...current, [view]: nextQuery }));
                  }}
                  placeholder={searchPlaceholder}
                  aria-label={searchPlaceholder}
                  className={cn(
                    "h-11 rounded-full border-border bg-background pl-11 pr-4 text-sm shadow-none",
                    "placeholder:text-muted-foreground",
                  )}
                />
              </div>

              <div className="flex min-h-11 items-center justify-between gap-3 max-sm:items-stretch">
                <ResourceTabsList
                  variant="segmented"
                  value={view}
                  items={[
                    {
                      value: "installed" as const,
                      label: t("mcpHub.tabInstalled"),
                      icon: Server,
                      countLabel: serverCount > 0 ? `${enabledCount}/${serverCount}` : null,
                    },
                    {
                      value: "store" as const,
                      label: t("mcpHub.tabStore"),
                      icon: Cloud,
                    },
                    {
                      value: "import" as const,
                      label: t("mcpHub.tabImport"),
                      icon: Download,
                    },
                  ]}
                  ariaLabel="MCP Hub"
                />
              </div>

              <div className="min-h-0 flex-1 overflow-hidden pt-4">
                <TabsContent value="installed" className="h-full min-h-0">
                  <McpServersForm
                    settings={settings}
                    setSettings={setSettings}
                    query={searchQueries.installed}
                    onAddServer={openAdd}
                    onEditServer={openEdit}
                  />
                </TabsContent>
                <TabsContent value="store" className="h-full min-h-0">
                  <McpRegistryBrowser
                    settings={settings}
                    setSettings={setSettings}
                    query={searchQueries.store}
                  />
                </TabsContent>
                <TabsContent value="import" className="h-full min-h-0">
                  <McpImportView
                    settings={settings}
                    setSettings={setSettings}
                    query={searchQueries.import}
                  />
                </TabsContent>
              </div>
            </Tabs>
          </div>
        </div>
      </div>

      {editing ? (
        <McpServerEditModal
          mode={editing.mode}
          initialServer={editing.mode === "edit" ? editing.server : null}
          existingServers={settings.mcp.servers}
          onClose={() => setEditing(null)}
          onSave={handleModalSave}
        />
      ) : null}
    </div>
  );
}

/**
 * 无 props 包装组件（App 以 <McpHubPage /> 挂载）：settings / setSettings 来自
 * hubSettingsStore。LA 的 isAgentMode 在本页组件体中未参与渲染，恒 true 语义
 * 由「页面即 Agent 模式」的项目形态直接承载。
 */
export function McpHubPage() {
  const settings = useHubSettings((s) => s.settings);
  const setSettings = useHubSettings((s) => s.setSettings);
  const mcpDegradedError = useHubSettings((s) => s.mcpDegradedError);
  // F19：MCP 配置读取失败 → 顶部醒目错误横幅，明确告知未覆盖磁盘配置。
  const degradedBanner = mcpDegradedError ? (
    <div className="mx-5 mt-3 flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-xs text-red-600 dark:text-red-400 sm:mx-6 lg:mx-8 xl:mx-10">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div className="flex flex-col gap-0.5">
        <span className="font-medium">
          读取 MCP 配置失败，已停止自动写盘以保护现有配置
        </span>
        <span className="text-muted-foreground break-all">
          ~/.ReinAgent/mcp_servers.json 可能已损坏；请修复文件后重启应用。当前不会用空列表覆盖它。
        </span>
        <span className="font-mono opacity-80 break-all">{mcpDegradedError}</span>
      </div>
    </div>
  ) : null;
  return (
    <>
      {degradedBanner}
      <McpHubPageInner settings={settings} setSettings={setSettings} />
    </>
  );
}
