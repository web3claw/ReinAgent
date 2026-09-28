// LiveAgent 移植：crates/agent-ui/src/pages/mcp-hub/McpServersForm.tsx
//        + crates/agent-ui/src/pages/mcp-hub/McpServerEditModal.tsx（含 McpServerEditModal 导出）
// 适配：
// - AppSettings → HubAppSettings；updateMcp 用本地 hubSettingsAdapter 同形助手。
// - 一期裁剪：server 工具策略（LA 的 settings.system.toolPolicies +
//   effectiveServerPolicyDefault / ToolPolicyToggle）在本项目无 system 设置切片，
//   不渲染策略切换。TODO(phase2)：引入策略存储后按 LA 原样恢复
//   serverPolicyKey("server:<id>") 写回逻辑。
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Blocks, Plug, Plus, Save, Server } from "lucide-react";

import { Button } from "../lw/ui/button";
import { useHubTranslation } from "./i18n";
import { isHubHiddenServerId } from "../../lib/hub/mcpServerDefaults";
import type { McpServerConfig } from "../../lib/hub/mcpTypes";
import type { HubAppSettings } from "../../store/hubSettingsStore";
import { rankFuzzySearchResults } from "../lw/lib/fuzzySearch";
import { cn } from "../lw/lib/utils";
import { McpServerCard } from "./McpServerCard";

type SetMcpSettingsFn = (updater: (prev: HubAppSettings) => HubAppSettings) => void;

type McpServersFormProps = {
  settings: HubAppSettings;
  setSettings: SetMcpSettingsFn;
  query: string;
  onAddServer?: () => void;
  onEditServer?: (server: McpServerConfig, idx: number) => void;
};

export function McpServersForm(props: McpServersFormProps) {
  const { settings, setSettings, query, onAddServer, onEditServer } = props;
  const { t } = useHubTranslation();
  // 由专属设置页托管的 server 不在 Hub 里露面（ReinAgent 无受管条目，过滤恒全量）。
  // 过滤后仍需拿到原始下标：McpServerCard 的编辑/删除都按 settings.mcp.servers 的
  // 位置写回。
  const servers = useMemo(
    () =>
      settings.mcp.servers
        .map((server, idx) => ({ server, idx }))
        .filter(({ server }) => !isHubHiddenServerId(server.id)),
    [settings.mcp.servers],
  );
  const serverCount = servers.length;

  const filtered = useMemo(() => {
    return rankFuzzySearchResults(servers, query, ({ server }) => [
      server.id,
      server.description,
      server.docsUrl,
      server.command,
      server.url,
      server.transport,
      ...(server.args ?? []),
      ...Object.keys(server.env ?? {}),
      ...Object.keys(server.headers ?? {}),
    ]);
  }, [query, servers]);

  return (
    <div className="h-full min-h-0 overflow-y-auto px-0.5 pb-4 pr-1 pt-1.5">
      <div className="flex flex-col gap-4">
        {serverCount === 0 ? (
          <div className={cn("rounded-xl bg-settings-tile px-6 py-12 text-center")}>
            <div
              className={cn(
                "mx-auto flex size-14 items-center justify-center",
                "rounded-xl bg-settings-active text-foreground",
              )}
            >
              <Server className="size-6" />
            </div>
            <p className="mt-4 text-sm font-medium text-foreground">{t("mcpHub.noServers")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t("mcpHub.noServersHint")}</p>
            {onAddServer ? (
              <Button variant="outline" size="sm" className="mt-4 gap-1.5" onClick={onAddServer}>
                <Plus className="size-3.5" />
                {t("mcpHub.add")}
              </Button>
            ) : null}
          </div>
        ) : null}

        {query.trim() && filtered.length === 0 && serverCount > 0 ? (
          <div className="rounded-xl bg-settings-tile px-6 py-8 text-center">
            <Plug className="mx-auto size-5 text-muted-foreground" />
            <p className="mt-3 text-sm text-muted-foreground">{t("mcpHub.noMatchInstalled")}</p>
          </div>
        ) : null}

        {filtered.length > 0 ? (
          <div className="space-y-1.5">
            {filtered.map(({ server, idx }) => (
              <McpServerCard
                key={`${server.id}:${idx}`}
                server={server}
                idx={idx}
                searchQuery={query}
                setSettings={setSettings}
                onEdit={() => onEditServer?.(server, idx)}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// McpServerEditModal
// ---------------------------------------------------------------------------

// LiveAgent 移植：crates/agent-ui/src/pages/mcp-hub/McpServerEditModal.tsx
// 适配：
// - 一期裁剪 OAuth：authType/authScope/authClientId 字段不渲染，保存恒 auth:
//   undefined（与 lib/hub/mcpTypes「auth 仅保留类型定义，不产出 OAuth UI」一致）。
//   TODO(phase2)：按 LA 原样恢复鉴权方式字段组。
// - LA IconSet McpLogo（gravity-ui/logo-mcp）→ lucide Blocks（纯装饰性图标）。
// - DialogContent 追加 hub-scope（Radix Portal 挂 body，需自持作用域变量）。
import { SettingsNotice } from "../lw/settings/SettingsNotice";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../lw/ui/dialog";
import { Input } from "../lw/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../lw/ui/select";
import { Textarea } from "../lw/ui/textarea";
import { FormField, FormFieldDescription, FormFieldLabel } from "./FormField";

type ServerDraft = {
  id: string;
  description: string;
  docsUrl: string;
  transport: McpServerConfig["transport"];
  timeoutMs: string;
  command: string;
  cwd: string;
  argsText: string;
  envText: string;
  url: string;
  messageUrl: string;
  headersText: string;
};

function formatKeyValueRecord(input: Record<string, string> | undefined) {
  return input
    ? Object.entries(input)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n")
    : "";
}

function parseLineList(input: string) {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseKeyValueDraft(input: string, errorPrefix: string) {
  const out: Record<string, string> = {};
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      throw new Error(`${errorPrefix}${trimmed}`);
    }
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!key || !value) {
      throw new Error(`${errorPrefix}${trimmed}`);
    }
    out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function suggestServerName(existing: string[]): string {
  const taken = new Set(existing.map((id) => id.trim()).filter(Boolean));
  let idx = existing.length + 1;
  let name = `MCP Server ${idx}`;
  while (taken.has(name)) {
    idx += 1;
    name = `MCP Server ${idx}`;
  }
  return name;
}

function blankDraft(existingIds: string[]): ServerDraft {
  return {
    id: suggestServerName(existingIds),
    description: "",
    docsUrl: "",
    transport: "stdio",
    timeoutMs: "60000",
    command: "",
    cwd: "",
    argsText: "",
    envText: "",
    url: "",
    messageUrl: "",
    headersText: "",
  };
}

function draftFromServer(server: McpServerConfig): ServerDraft {
  const transport: McpServerConfig["transport"] = server.transport ?? "stdio";
  return {
    id: server.id,
    description: server.description ?? "",
    docsUrl: server.docsUrl ?? "",
    transport,
    timeoutMs: String(server.timeoutMs ?? 60_000),
    command: server.command ?? "",
    cwd: server.cwd ?? "",
    argsText: (server.args ?? []).join("\n"),
    envText: formatKeyValueRecord(server.env),
    url: server.url ?? "",
    messageUrl: server.messageUrl ?? "",
    headersText: formatKeyValueRecord(server.headers),
  };
}

function buildServerFromDraft(
  draft: ServerDraft,
  base: McpServerConfig | null,
  existingIds: string[],
  t: (key: string) => string,
): McpServerConfig {
  const id = draft.id.trim();
  if (!id) {
    throw new Error(t("mcpHub.invalidName"));
  }
  if (existingIds.includes(id)) {
    throw new Error(t("mcpHub.duplicateName"));
  }

  const parsedTimeout = Number(draft.timeoutMs);
  const timeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? Math.floor(parsedTimeout) : 60_000;

  if (draft.transport === "stdio") {
    const command = draft.command.trim();
    if (!command) {
      throw new Error(t("mcpHub.invalidCommand"));
    }
    return {
      ...(base ?? {}),
      id,
      description: draft.description.trim() || undefined,
      docsUrl: draft.docsUrl.trim() || undefined,
      enabled: base?.enabled ?? true,
      transport: "stdio",
      command,
      args: parseLineList(draft.argsText),
      cwd: draft.cwd.trim() || undefined,
      env: parseKeyValueDraft(draft.envText, `${t("mcpHub.invalidKeyValue")} `),
      url: "",
      messageUrl: undefined,
      headers: undefined,
      timeoutMs,
      // TODO(phase2)：OAuth 鉴权配置一期裁剪，恢复 LA 的 auth 字段装配。
      auth: undefined,
    };
  }

  const url = draft.url.trim();
  if (!url) {
    throw new Error(t("mcpHub.invalidUrl"));
  }
  return {
    ...(base ?? {}),
    id,
    description: draft.description.trim() || undefined,
    docsUrl: draft.docsUrl.trim() || undefined,
    enabled: base?.enabled ?? true,
    transport: draft.transport,
    command: "",
    args: [],
    url,
    messageUrl: draft.transport === "sse" ? draft.messageUrl.trim() || undefined : undefined,
    headers: parseKeyValueDraft(draft.headersText, `${t("mcpHub.invalidKeyValue")} `),
    cwd: undefined,
    env: undefined,
    timeoutMs,
    // TODO(phase2)：OAuth 鉴权配置一期裁剪，恢复 LA 的 auth 字段装配。
    auth: undefined,
  };
}

export function McpServerEditModal(props: {
  mode: "add" | "edit";
  initialServer: McpServerConfig | null;
  existingServers: McpServerConfig[];
  onClose: () => void;
  onSave: (server: McpServerConfig) => void;
}) {
  const { mode, initialServer, existingServers, onClose, onSave } = props;
  const { t } = useHubTranslation();

  const existingIdsExcludingCurrent = useMemo(() => {
    return existingServers
      .filter((server) => mode !== "edit" || server.id !== initialServer?.id)
      .map((server) => server.id);
  }, [existingServers, initialServer, mode]);

  const [draft, setDraft] = useState<ServerDraft>(() =>
    initialServer ? draftFromServer(initialServer) : blankDraft(existingIdsExcludingCurrent),
  );
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(
      initialServer ? draftFromServer(initialServer) : blankDraft(existingIdsExcludingCurrent),
    );
    setFormError(null);
  }, [existingIdsExcludingCurrent, initialServer]);

  function updateDraft(patch: Partial<ServerDraft>) {
    setFormError(null);
    setDraft((prev) => ({ ...prev, ...patch }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const server = buildServerFromDraft(draft, initialServer, existingIdsExcludingCurrent, t);
      onSave(server);
      onClose();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    }
  }

  const isStdio = draft.transport === "stdio";
  const isSse = draft.transport === "sse";
  const title = mode === "add" ? t("mcpHub.addTitle") : t("mcpHub.editTitle");
  const subtitleRaw =
    mode === "add"
      ? t("mcpHub.addSubtitle")
      : t("mcpHub.editSubtitle").replace("{name}", initialServer?.id ?? "");
  const submitLabel = mode === "add" ? t("mcpHub.modalAdd") : t("mcpHub.modalSave");

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="hub-scope flex h-[min(48rem,calc(100dvh-2rem))] max-w-xl flex-col p-0"
        closeLabel={t("settings.cancel")}
        layout="fullscreen-mobile"
        showCloseButton
      >
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader className="flex-row items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Blocks className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription className="mt-0.5 truncate text-xs" title={subtitleRaw}>
                {subtitleRaw}
              </DialogDescription>
            </div>
          </DialogHeader>

          <DialogBody>
            <div className="space-y-6">
              <section aria-labelledby="mcp-edit-basics-heading" className="space-y-3">
                <h3
                  id="mcp-edit-basics-heading"
                  className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  {t("mcpHub.basicSettings")}
                </h3>
                <div className="grid gap-x-3 gap-y-4">
                  <FormField density="compact">
                    <FormFieldLabel htmlFor="mcp-edit-id" size="compact">
                      {t("mcpHub.serverName")}
                    </FormFieldLabel>
                    <Input
                      variant="plain"
                      id="mcp-edit-id"
                      value={draft.id}
                      placeholder={t("mcpHub.serverNamePlaceholder")}
                      aria-describedby="mcp-edit-id-hint"
                      onChange={(event) => updateDraft({ id: event.currentTarget.value })}
                    />
                    <FormFieldDescription id="mcp-edit-id-hint">
                      {t("mcpHub.serverNameHint")}
                    </FormFieldDescription>
                  </FormField>
                  <FormField density="compact">
                    <FormFieldLabel htmlFor="mcp-edit-transport" size="compact">
                      {t("mcpHub.transport")}
                    </FormFieldLabel>
                    <Select
                      value={draft.transport}
                      onValueChange={(value) => {
                        const transport =
                          value === "http" ? "http" : value === "sse" ? "sse" : "stdio";
                        updateDraft({ transport });
                      }}
                    >
                      <SelectTrigger variant="plain" id="mcp-edit-transport">
                        <SelectValue placeholder={t("mcpHub.selectTransport")} />
                      </SelectTrigger>
                      <SelectContent className="hub-scope">
                        <SelectItem value="stdio">{t("mcpHub.stdio")}</SelectItem>
                        <SelectItem value="http">{t("mcpHub.http")}</SelectItem>
                        <SelectItem value="sse">{t("mcpHub.sse")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormField>
                  <FormField density="compact">
                    <FormFieldLabel htmlFor="mcp-edit-timeout" size="compact">
                      {t("mcpHub.timeout")}
                    </FormFieldLabel>
                    <Input
                      variant="plain"
                      id="mcp-edit-timeout"
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={draft.timeoutMs}
                      placeholder="60000"
                      onChange={(event) => updateDraft({ timeoutMs: event.currentTarget.value })}
                    />
                  </FormField>
                </div>
              </section>

              <section
                aria-labelledby="mcp-edit-connection-heading"
                className="space-y-3 border-t border-border/60 pt-5"
              >
                <h3
                  id="mcp-edit-connection-heading"
                  className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  {t("mcpHub.connectionSettings")}
                </h3>
                {isStdio ? (
                  <div className="space-y-4">
                    <div className="grid gap-3">
                      <FormField density="compact">
                        <FormFieldLabel htmlFor="mcp-edit-command" size="compact">
                          {t("mcpHub.command")}
                        </FormFieldLabel>
                        <Input
                          variant="plain"
                          id="mcp-edit-command"
                          value={draft.command}
                          placeholder="npx"
                          className="font-mono text-xs"
                          onChange={(event) => updateDraft({ command: event.currentTarget.value })}
                        />
                      </FormField>
                      <FormField density="compact">
                        <FormFieldLabel htmlFor="mcp-edit-cwd" size="compact">
                          {t("mcpHub.cwd")}
                        </FormFieldLabel>
                        <Input
                          variant="plain"
                          id="mcp-edit-cwd"
                          value={draft.cwd}
                          placeholder={t("mcpHub.cwdDefault")}
                          className="font-mono text-xs"
                          onChange={(event) => updateDraft({ cwd: event.currentTarget.value })}
                        />
                      </FormField>
                    </div>
                    <div className="grid gap-3">
                      <FormField density="compact">
                        <FormFieldLabel htmlFor="mcp-edit-args" size="compact">
                          {t("mcpHub.args")}
                        </FormFieldLabel>
                        <Textarea
                          variant="plain"
                          id="mcp-edit-args"
                          rows={4}
                          value={draft.argsText}
                          placeholder={"-y\n@modelcontextprotocol/server-time"}
                          className="resize-y font-mono text-xs"
                          onChange={(event) => updateDraft({ argsText: event.currentTarget.value })}
                        />
                      </FormField>
                      <FormField density="compact">
                        <FormFieldLabel htmlFor="mcp-edit-env" size="compact">
                          {t("mcpHub.env")}
                        </FormFieldLabel>
                        <Textarea
                          variant="plain"
                          id="mcp-edit-env"
                          rows={4}
                          value={draft.envText}
                          placeholder={"BRAVE_API_KEY=...\nHTTP_PROXY=..."}
                          className="resize-y font-mono text-xs"
                          onChange={(event) => updateDraft({ envText: event.currentTarget.value })}
                        />
                      </FormField>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <FormField density="compact">
                      <FormFieldLabel htmlFor="mcp-edit-url" size="compact">
                        {draft.transport === "http" ? t("mcpHub.urlHttp") : t("mcpHub.urlSse")}
                      </FormFieldLabel>
                      <Input
                        variant="plain"
                        id="mcp-edit-url"
                        value={draft.url}
                        placeholder={
                          draft.transport === "http"
                            ? "http://127.0.0.1:3000/mcp"
                            : "http://127.0.0.1:3000/sse"
                        }
                        className="font-mono text-xs"
                        onChange={(event) => updateDraft({ url: event.currentTarget.value })}
                      />
                    </FormField>
                    {isSse ? (
                      <FormField density="compact">
                        <FormFieldLabel htmlFor="mcp-edit-message-url" size="compact">
                          {t("mcpHub.messageUrl")}
                        </FormFieldLabel>
                        <Input
                          variant="plain"
                          id="mcp-edit-message-url"
                          value={draft.messageUrl}
                          placeholder="http://127.0.0.1:3000/message"
                          className="font-mono text-xs"
                          onChange={(event) =>
                            updateDraft({
                              messageUrl: event.currentTarget.value,
                            })
                          }
                        />
                      </FormField>
                    ) : null}
                    <FormField density="compact">
                      <FormFieldLabel htmlFor="mcp-edit-headers" size="compact">
                        {t("mcpHub.headers")}
                      </FormFieldLabel>
                      <Textarea
                        variant="plain"
                        id="mcp-edit-headers"
                        rows={4}
                        value={draft.headersText}
                        placeholder={"Authorization=Bearer ...\nX-API-Key=..."}
                        className="resize-y font-mono text-xs"
                        onChange={(event) =>
                          updateDraft({
                            headersText: event.currentTarget.value,
                          })
                        }
                      />
                    </FormField>
                  </div>
                )}
              </section>

              <section
                aria-labelledby="mcp-edit-details-heading"
                className="space-y-3 border-t border-border/60 pt-5"
              >
                <h3
                  id="mcp-edit-details-heading"
                  className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  {t("mcpHub.optionalDetails")}
                </h3>
                <div className="grid gap-3">
                  <FormField density="compact">
                    <FormFieldLabel htmlFor="mcp-edit-description" size="compact">
                      {t("mcpHub.description")}
                    </FormFieldLabel>
                    <Textarea
                      variant="plain"
                      id="mcp-edit-description"
                      rows={3}
                      value={draft.description}
                      placeholder={t("mcpHub.descriptionPlaceholder")}
                      className="resize-y text-sm"
                      onChange={(event) => updateDraft({ description: event.currentTarget.value })}
                    />
                  </FormField>

                  <FormField density="compact">
                    <FormFieldLabel htmlFor="mcp-edit-docs-url" size="compact">
                      {t("mcpHub.docsUrl")}
                    </FormFieldLabel>
                    <Input
                      variant="plain"
                      id="mcp-edit-docs-url"
                      value={draft.docsUrl}
                      placeholder={t("mcpHub.docsUrlPlaceholder")}
                      className="font-mono text-xs"
                      onChange={(event) => updateDraft({ docsUrl: event.currentTarget.value })}
                    />
                  </FormField>
                </div>
              </section>

              {formError ? (
                <SettingsNotice variant="validation">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <span>{formError}</span>
                </SettingsNotice>
              ) : null}
            </div>
          </DialogBody>

          <DialogFooter className="flex-row flex-wrap">
            <Button size="sm" type="button" variant="outline" onClick={onClose}>
              {t("settings.cancel")}
            </Button>
            <Button size="sm" type="submit" className="gap-1.5">
              {mode === "add" ? <Plus className="size-3.5" /> : <Save className="size-3.5" />}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
