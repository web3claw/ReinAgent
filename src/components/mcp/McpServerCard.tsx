// LiveAgent 移植：crates/agent-ui/src/pages/mcp-hub/McpServerCard.tsx
// 适配：
// - 一期裁剪 OAuth：OauthControls / isOauthServer 徽章与 Connect 按钮不渲染，
//   删除时也不再清理 keychain 凭据。TODO(phase2)：按 LA 原样恢复
//   mcpOauthStatus/authorize/clear 接线。
// - 一期裁剪工具策略：LA 卡片上的 ToolPolicyToggle（policy/onPolicyChange props）
//   不渲染 —— 本项目无 settings.system.toolPolicies 存储切片，静默丢失写入不可
//   接受；操作列由 grid-cols-mcp-actions（3 列）改为同视觉的 flex 两列。
//   TODO(phase2)：引入策略存储后恢复三态切换列。
// - LA removeWorkspaceResourceReferences（删除 server 时清理工作区引用）在本项目
//   无对应体系，删除仅移除 server 本身。TODO(phase2)。
import { memo, useState } from "react";
import { ExternalLink, PlugZap, Settings, Trash2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { ResourceActivationSwitch } from "../lw/resources/ResourceActivationSwitch";
import { Badge } from "../lw/ui/badge";
import { Button } from "../lw/ui/button";
import { ConfirmDeletePopover } from "../lw/ui/confirm-action-popover";
import { SearchHighlight } from "../lw/ui/search-highlight";
import { useHubTranslation } from "./i18n";
import { resolveMcpDocsHref } from "../../lib/hub/mcpServerMetadata";
import type { McpServerConfig } from "../../lib/hub/mcpTypes";
import type { HubAppSettings } from "../../store/hubSettingsStore";
import { cn } from "../lw/lib/utils";
import { updateMcp } from "./hubSettingsAdapter";
import { getMcpTransportMeta } from "./McpTransportMeta";

type SetMcpSettingsFn = (updater: (prev: HubAppSettings) => HubAppSettings) => void;

function ConfigurationCount(props: { count: number; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-full bg-settings-active px-2",
        "text-tiny text-muted-foreground",
      )}
    >
      <span className="font-semibold tabular-nums text-foreground">{props.count}</span>
      <span>{props.label}</span>
    </span>
  );
}

export const McpServerCard = memo(function McpServerCard(props: {
  server: McpServerConfig;
  idx: number;
  searchQuery: string;
  setSettings: SetMcpSettingsFn;
  onEdit: () => void;
}) {
  const { server, idx, searchQuery, setSettings, onEdit } = props;
  const { t } = useHubTranslation();
  const transport = server.transport || "stdio";
  const isStdio = transport === "stdio";
  const isHttp = transport === "http";
  const { label: transportLabel } = getMcpTransportMeta(transport);
  const enabled = server.enabled;
  const displayName = server.id || `Server ${idx + 1}`;

  // 连接诊断（ReinAgent 增量）：调用 mcp_test_server 实测握手+工具枚举，
  // 如实显示工具数或失败 phase/原因——枚举失败只进 console 的话用户无从得知
  // 「启用了却没带上」的原因（No-Fallback：成功/失败都展示真实结果）。
  const [testState, setTestState] = useState<{
    loading: boolean;
    ok?: boolean;
    toolsCount?: number;
    durationMs?: number;
    error?: string;
  } | null>(null);
  const runTest = async () => {
    setTestState({ loading: true });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{
        ok: boolean;
        phase?: string;
        toolsCount?: number;
        durationMs?: number;
        error?: string;
      }>("mcp_test_server", { server, persist: true });
      setTestState({
        loading: false,
        ok: result.ok === true,
        toolsCount: result.toolsCount,
        durationMs: result.durationMs,
        error: result.ok ? undefined : [result.error, result.phase ? `（phase: ${result.phase}）` : ""].filter(Boolean).join(" "),
      });
    } catch (err) {
      setTestState({
        loading: false,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const patchServer = (patch: Partial<McpServerConfig>) => {
    setSettings((prev) =>
      updateMcp(prev, {
        servers: prev.mcp.servers.map((item, index) =>
          index === idx ? { ...item, ...patch } : item,
        ),
      }),
    );
  };

  const previewLine = isStdio
    ? [server.command, ...(server.args ?? [])].filter(Boolean).join(" ")
    : server.url || "";
  const previewLabel = isStdio
    ? t("mcpHub.command")
    : isHttp
      ? t("mcpHub.urlHttp")
      : t("mcpHub.urlSse");
  const detailLine = [server.description, previewLine ? `${previewLabel}: ${previewLine}` : null]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
  const argsCount = (server.args ?? []).filter(Boolean).length;
  const envCount = server.env ? Object.keys(server.env).length : 0;
  const headerCount = server.headers ? Object.keys(server.headers).length : 0;
  const docsLink = resolveMcpDocsHref(server.docsUrl);

  return (
    // 容器查询挂在 article 上:行宽 < 520px(手机、或桌面侧栏占位后的窄内容区)
    // 时把 计数/编辑/删除 整组换到第二行。此前几组里只有名称列可收缩,
    // 其余全是 shrink-0,窄屏下名称列被挤成 0 宽,文字溢出到徽章底下(重叠)。
    <article
      className={cn(
        "group @container flex min-h-16 w-full flex-wrap items-center gap-3",
        "rounded-xl bg-settings-tile px-4 py-3 text-left transition-colors",
        "hover:bg-settings-tile-hover",
      )}
    >
      <ResourceActivationSwitch
        checked={enabled}
        compact
        label={`${displayName}: ${enabled ? t("settings.disable") : t("settings.enable")}`}
        onCheckedChange={(checked) => patchServer({ enabled: checked })}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-1.5 @max-[520px]:flex-wrap">
          {/* truncate 必须落在 button 自身:SearchHighlight 渲出的是 inline span,
              overflow/text-overflow 对 inline 盒无效,文字会越过 button 边界。 */}
          <button
            type="button"
            onClick={onEdit}
            title={t("settings.edit")}
            className="min-w-0 truncate rounded-sm text-left outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            <SearchHighlight
              text={displayName}
              query={searchQuery}
              className="text-sm font-semibold text-foreground"
            />
          </button>
          {docsLink ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-5 shrink-0 text-muted-foreground"
              title={t("mcpHub.storeOpenExternal")}
              aria-label={t("mcpHub.storeOpenExternal")}
              onClick={() => void openUrl(docsLink)}
            >
              <ExternalLink aria-hidden="true" className="size-3" />
            </Button>
          ) : null}
          <Badge variant="muted" className="h-5 px-1.5 text-tiny uppercase tracking-wide">
            <SearchHighlight text={transportLabel} query={searchQuery} />
          </Badge>
        </div>
        {detailLine ? (
          <button
            type="button"
            onClick={onEdit}
            title={detailLine}
            className={cn(
              "mt-1 min-w-0 truncate rounded-sm text-left text-xs text-muted-foreground outline-hidden",
              "focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            <SearchHighlight text={detailLine} query={searchQuery} />
          </button>
        ) : null}
      </div>

      {/* 窄行时 basis-full 强制整组换行:计数靠左、操作靠右(ml-auto);宽行时
          还是原来的一行几组。计数组自身允许折行,不再用 max-w-48 硬夹。 */}
      <div className="flex shrink-0 items-center gap-3 @max-[520px]:basis-full @max-[520px]:flex-wrap">
        {argsCount > 0 || envCount > 0 || headerCount > 0 ? (
          <div className="flex min-w-0 max-w-48 flex-wrap justify-end gap-1 @max-[520px]:max-w-none @max-[520px]:justify-start">
            {argsCount > 0 ? (
              <ConfigurationCount count={argsCount} label={t("mcpHub.previewArgs")} />
            ) : null}
            {envCount > 0 ? (
              <ConfigurationCount count={envCount} label={t("mcpHub.previewEnv")} />
            ) : null}
            {headerCount > 0 ? (
              <ConfigurationCount count={headerCount} label={t("mcpHub.previewHeaders")} />
            ) : null}
          </div>
        ) : null}

        <div className="flex shrink-0 items-center gap-1.5 @max-[520px]:ml-auto">
          {enabled ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => void runTest()}
              disabled={testState?.loading === true}
              title={t("mcpTest")}
              className="text-muted-foreground"
            >
              <PlugZap
                className={cn("size-3.5", testState?.loading && "animate-pulse")}
                aria-hidden="true"
              />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onEdit}
            title={t("settings.edit")}
            className="text-muted-foreground"
          >
            <Settings className="size-3.5" />
          </Button>
          <ConfirmDeletePopover
            name={server.id || `Server ${idx + 1}`}
            title={t("settings.deleteConfirm")}
            confirmLabel={t("settings.delete")}
            cancelLabel={t("settings.cancel")}
            description={(name) => (
              <>
                {t("settings.deleteConfirmYes")}{" "}
                <span className="font-medium text-foreground">{name}</span>？
                {t("settings.deleteConfirmDesc")}
              </>
            )}
            onConfirm={() => {
              setSettings((prev) =>
                updateMcp(prev, {
                  servers: prev.mcp.servers.filter((_, index) => index !== idx),
                }),
              );
            }}
          >
            {(open) => (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={open}
                className="text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                title={t("settings.delete")}
              >
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </ConfirmDeletePopover>
        </div>
      </div>

      {/* 连接诊断结果行：成功显示工具数/耗时，失败如实显示错误原文（不吞不猜） */}
      {testState && !testState.loading ? (
        <div className="basis-full">
          {testState.ok ? (
            <span className="text-xs text-success">
              {t("mcpHub.cardTestOk").replace("{n}", String(testState.toolsCount ?? 0))}
              {typeof testState.durationMs === "number"
                ? ` · ${(testState.durationMs / 1000).toFixed(1)}s`
                : ""}
            </span>
          ) : (
            <span
              className="line-clamp-2 w-full break-all text-xs text-destructive"
              title={testState.error}
            >
              {testState.error || t("mcpHub.cardTestFailed")}
            </span>
          )}
        </div>
      ) : null}
    </article>
  );
});
