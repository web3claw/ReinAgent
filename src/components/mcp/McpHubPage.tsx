/**
 * McpHubPage —— MCP 服务器管理页（照抄 LiveAgent McpHubPage 一期子集：
 * 服务器卡片列表 + 添加/编辑弹窗（名称/transport stdio|http/command|url/args/env/
 * headers/timeout）+ 测试连接 + 启停开关 + 删除；商店/导入 tab 二期）。
 * 配置存 `~/.ReinAgent/mcp_servers.json`（Rust `mcp_*` 命令）。
 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Pencil, Play, Plug, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "../../i18n";

interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: "stdio" | "http";
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  timeoutMs?: number | null;
}

interface McpListToolsResult {
  serverId: string;
  tools: { name: string; description: string; inputSchema: unknown }[];
}

const EMPTY_SERVER: McpServerConfig = {
  id: "",
  name: "",
  enabled: true,
  transport: "stdio",
  command: "",
  args: [],
  env: {},
  url: "",
  headers: {},
  timeoutMs: null,
};

export function McpHubPage() {
  const { t } = useTranslation();
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [editing, setEditing] = useState<McpServerConfig | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  const reload = () => {
    void invoke<McpServerConfig[]>("mcp_list_servers")
      .then(setServers)
      .catch((err) => console.error("[mcp] list failed:", err));
  };

  useEffect(reload, []);

  const persist = async (next: McpServerConfig[]) => {
    setServers(next);
    await invoke("mcp_save_servers", { servers: next }).catch((err) =>
      console.error("[mcp] save failed:", err),
    );
  };

  const handleTest = async (server: McpServerConfig) => {
    setTestingId(server.id);
    try {
      const res = await invoke<McpListToolsResult>("mcp_test_server", { server });
      setTestResult((r) => ({
        ...r,
        [server.id]: t("mcpTestOk").replace("{count}", String(res.tools.length)),
      }));
    } catch (err) {
      setTestResult((r) => ({
        ...r,
        [server.id]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setTestingId(null);
    }
  };

  const handleSave = async (server: McpServerConfig) => {
    const next = server.id
      ? servers.map((s) => (s.id === server.id ? server : s))
      : [...servers, { ...server, id: `mcp-${Date.now()}` }];
    await persist(next);
    setEditing(null);
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden text-[var(--text)]">
      <div className="flex flex-shrink-0 items-center justify-between border-b border-[var(--border)] px-6 pb-4 pt-5">
        <div className="flex items-center gap-2">
          <h1 className="text-ui-lg font-semibold text-[var(--text)]">{t("navMcp")}</h1>
        </div>
        <button
          type="button"
          onClick={() => setEditing({ ...EMPTY_SERVER })}
          className="flex items-center gap-1.5 rounded-full bg-[var(--brand)] px-4 py-1.5 text-ui-sm font-medium text-white transition-colors hover:bg-[var(--accent)] cursor-pointer"
        >
          <Plus className="h-4 w-4" />
          <span>{t("mcpAddServer")}</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {servers.length === 0 ? (
          <div className="flex h-[226px] w-full flex-col items-center justify-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] px-4">
            <Plug className="h-8 w-8 text-[var(--text-dim)]" />
            <p className="text-ui-sm font-medium text-[var(--text)]">{t("mcpEmptyTitle")}</p>
            <p className="text-ui-xs text-[var(--text-dim)]">{t("mcpEmptyDesc")}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {servers.map((s) => (
              <div
                key={s.id}
                className={`flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3 ${
                  s.enabled ? "" : "opacity-60"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-ui-sm font-medium text-[var(--text)]">
                    {s.name || s.id}
                  </span>
                  <div className="flex flex-shrink-0 items-center gap-1">
                    <button
                      type="button"
                      title={t("mcpTest")}
                      disabled={testingId === s.id}
                      onClick={() => void handleTest(s)}
                      className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] cursor-pointer disabled:opacity-40"
                    >
                      <Play className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      title={t("automationsRefresh")}
                      onClick={() => setEditing(s)}
                      className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] cursor-pointer"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      title={t("automationsDelete")}
                      onClick={() => void persist(servers.filter((x) => x.id !== s.id))}
                      className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--danger)] cursor-pointer"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={s.enabled}
                      onClick={() => void persist(servers.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x)))}
                      className={`relative h-4 w-8 flex-shrink-0 rounded-full transition-colors cursor-pointer ${
                        s.enabled ? "bg-[var(--brand)]" : "bg-[var(--border)]"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all ${
                          s.enabled ? "left-[18px]" : "left-0.5"
                        }`}
                      />
                    </button>
                  </div>
                </div>
                <p className="min-w-0 truncate text-ui-xs text-[var(--text-dim)]">
                  {s.transport === "http" ? s.url : `${s.command} ${s.args.join(" ")}`}
                </p>
                {testResult[s.id] ? (
                  <p
                    className={`text-ui-xs ${
                      testResult[s.id].startsWith(t("mcpTestOk").split(" ")[0])
                        ? "text-[var(--status-ok)]"
                        : "text-[var(--danger)]"
                    }`}
                  >
                    {testResult[s.id]}
                  </p>
                ) : null}
                <div className="mt-auto flex items-center gap-2">
                  <span className="rounded-md bg-[var(--brand-dim)] px-1.5 py-0.5 text-xs text-[var(--brand)]">
                    {s.transport}
                  </span>
                  <span className="text-xs text-[var(--text-dim)]">
                    {s.enabled ? t("automationsFilterActive") : t("automationsPausedLabel")}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing ? (
        <McpServerEditModal
          server={editing}
          onCancel={() => setEditing(null)}
          onSave={(s) => void handleSave(s)}
        />
      ) : null}
    </div>
  );
}

/** 编辑弹窗（对齐 LiveAgent McpServerEditModal 的一期字段集）。 */
function McpServerEditModal({
  server,
  onCancel,
  onSave,
}: {
  server: McpServerConfig;
  onCancel: () => void;
  onSave: (server: McpServerConfig) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<McpServerConfig>(server);
  const [argsText, setArgsText] = useState(server.args.join(" "));
  const [envText, setEnvText] = useState(
    Object.entries(server.env).map(([k, v]) => `${k}=${v}`).join("\n"),
  );

  const handleSave = () => {
    const env: Record<string, string> = {};
    for (const line of envText.split("\n")) {
      const idx = line.indexOf("=");
      if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    onSave({
      ...draft,
      name: draft.name.trim() || draft.id || "MCP Server",
      args: argsText.trim() ? argsText.trim().split(/\s+/) : [],
      env,
    });
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50">
      <div className="w-[520px] max-w-[92vw] rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-5 shadow-2xl">
        <h2 className="text-ui-base font-semibold text-[var(--text)]">
          {server.id ? t("mcpEditTitle") : t("mcpAddTitle")}
        </h2>
        <div className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-ui-xs text-[var(--text-dim)]">
            {t("mcpFieldName")}
            <input
              type="text"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className="h-9 rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-3 text-ui-sm text-[var(--text)] focus:border-[var(--brand)] focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1 text-ui-xs text-[var(--text-dim)]">
            {t("mcpFieldTransport")}
            <select
              value={draft.transport}
              onChange={(e) => setDraft({ ...draft, transport: e.target.value as "stdio" | "http" })}
              className="h-9 appearance-none rounded-lg border-0 bg-[var(--bg-hover)] px-3 text-ui-sm text-[var(--text)] focus:outline-none"
            >
              <option value="stdio">stdio</option>
              <option value="http">http</option>
            </select>
          </label>
          {draft.transport === "stdio" ? (
            <>
              <label className="flex flex-col gap-1 text-ui-xs text-[var(--text-dim)]">
                {t("mcpFieldCommand")}
                <input
                  type="text"
                  value={draft.command}
                  placeholder="npx"
                  onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                  className="h-9 rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-3 font-mono text-ui-xs text-[var(--text)] focus:border-[var(--brand)] focus:outline-none"
                />
              </label>
              <label className="flex flex-col gap-1 text-ui-xs text-[var(--text-dim)]">
                {t("mcpFieldArgs")}
                <input
                  type="text"
                  value={argsText}
                  placeholder="-y @modelcontextprotocol/server-filesystem /path"
                  onChange={(e) => setArgsText(e.target.value)}
                  className="h-9 rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-3 font-mono text-ui-xs text-[var(--text)] focus:border-[var(--brand)] focus:outline-none"
                />
              </label>
              <label className="flex flex-col gap-1 text-ui-xs text-[var(--text-dim)]">
                {t("mcpFieldEnv")}
                <textarea
                  value={envText}
                  rows={2}
                  placeholder="KEY=value"
                  onChange={(e) => setEnvText(e.target.value)}
                  className="resize-y rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-2 font-mono text-ui-xs text-[var(--text)] focus:border-[var(--brand)] focus:outline-none"
                />
              </label>
            </>
          ) : (
            <label className="flex flex-col gap-1 text-ui-xs text-[var(--text-dim)]">
              URL
              <input
                type="text"
                value={draft.url}
                placeholder="https://example.com/mcp"
                onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                className="h-9 rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-3 font-mono text-ui-xs text-[var(--text)] focus:border-[var(--brand)] focus:outline-none"
              />
            </label>
          )}
        </div>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-[var(--border)] px-5 py-1.5 text-ui-sm text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] cursor-pointer"
          >
            {t("automationsCancel")}
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="rounded-full bg-[var(--brand)] px-6 py-1.5 text-ui-sm font-medium text-white transition-colors hover:bg-[var(--accent)] cursor-pointer"
          >
            {t("automationsSave")}
          </button>
        </div>
      </div>
    </div>
  );
}
