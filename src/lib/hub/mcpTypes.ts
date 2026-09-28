// LiveAgent 移植：
// - 类型：crates/agent-ui/src/lib/settings/types.ts（McpTransport / McpAuthType /
//   McpAuthConfig / McpServerConfig / McpSettings）
// - 归一化：crates/agent-ui/src/lib/settings/index.ts（normalizeMcpServerConfig /
//   normalizeMcpSettings 及其私有辅助）
// - Ops：crates/agent-gui/src/lib/settings/mcpOps.ts（applyMcpOps /
//   selectEnabledMcpServers；applyMcpOpsToAppSettings 依赖 LA 整体 AppSettings，
//   本项目无对应体系，不移植）
//
// auth 字段本期仅保留类型定义，不产出 OAuth UI。

export type McpTransport = "stdio" | "http" | "sse";

/**
 * MCP OAuth 鉴权配置（docs/design/mcp-oauth.md）。缺省 = "none"（现状，静态
 * headers 继续生效）。token 永不落 settings——只存 keychain（Rust 侧），
 * 因此该结构可安全进 Gateway 同步与 WebDAV 备份。
 */
export type McpAuthType = "none" | "oauth";

export type McpAuthConfig = {
  type: McpAuthType;
  /** 覆盖 PRM scopes_supported 的空格分隔 scope 列表。 */
  scope?: string;
  /** 静态 client_id（企业 AS）；缺省走 RFC 7591 动态注册。 */
  clientId?: string;
};

export type McpServerConfig = {
  id: string;
  description?: string;
  docsUrl?: string;
  enabled: boolean;
  transport: McpTransport;
  command: string;
  args: string[];
  url: string;
  env?: Record<string, string>;
  cwd?: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  messageUrl?: string;
  auth?: McpAuthConfig;
};

export type McpSettings = {
  servers: McpServerConfig[];
  selected: string[];
  /** 工具审批策略（server id → allow/ask/deny）；纯前端存储（不进 Rust JSON） */
  serverPolicy?: Record<string, "allow" | "ask" | "deny">;
};

// ---------------------------------------------------------------------------
// 归一化（settings/index.ts）
// ---------------------------------------------------------------------------

const DEFAULT_MCP_TIMEOUT_MS = 60_000;

export function normalizeStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
}

function normalizeRecordStringString(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== "object") return undefined;

  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const key = String(rawKey).trim();
    const value = typeof rawValue === "string" ? rawValue.trim() : String(rawValue ?? "").trim();
    if (!key || !value) continue;
    out[key] = value;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeMcpTransport(input: unknown): McpTransport {
  if (input === "http" || input === "sse" || input === "stdio") return input;
  return "stdio";
}

function normalizeMcpSelection(input: unknown, servers: McpServerConfig[]): string[] {
  const valid = new Set(servers.map((server) => server.id).filter(Boolean));
  const out: string[] = [];

  for (const item of normalizeStringArray(input)) {
    if (!valid.has(item)) continue;
    if (out.includes(item)) continue;
    out.push(item);
  }

  return out;
}

function normalizeTimeoutMs(input: unknown): number {
  const numeric =
    typeof input === "number" ? input : typeof input === "string" ? Number(input) : NaN;
  const timeoutMs = Number.isFinite(numeric) ? Math.floor(numeric) : DEFAULT_MCP_TIMEOUT_MS;
  return timeoutMs > 0 ? timeoutMs : DEFAULT_MCP_TIMEOUT_MS;
}

function normalizeMcpAuthConfig(input: unknown): McpAuthConfig | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  if (obj.type !== "oauth") return undefined; // "none"/未知值 = 现状，不存壳对象
  const scope = typeof obj.scope === "string" ? obj.scope.trim() : "";
  const clientId = typeof obj.clientId === "string" ? obj.clientId.trim() : "";
  return {
    type: "oauth",
    ...(scope ? { scope } : {}),
    ...(clientId ? { clientId } : {}),
  };
}

export function normalizeMcpServerConfig(input: unknown): McpServerConfig {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  const description = typeof obj.description === "string" ? obj.description.trim() : "";
  const docsUrl = typeof obj.docsUrl === "string" ? obj.docsUrl.trim() : "";
  const cwd = typeof obj.cwd === "string" ? obj.cwd.trim() : "";
  const messageUrl = typeof obj.messageUrl === "string" ? obj.messageUrl.trim() : "";
  const auth = normalizeMcpAuthConfig(obj.auth);

  return {
    id,
    ...(description ? { description } : {}),
    ...(docsUrl ? { docsUrl } : {}),
    enabled: Boolean(obj.enabled),
    transport: normalizeMcpTransport(obj.transport),
    command: typeof obj.command === "string" ? obj.command.trim() : "",
    args: normalizeStringArray(obj.args),
    url: typeof obj.url === "string" ? obj.url.trim() : "",
    env: normalizeRecordStringString(obj.env),
    cwd: cwd || undefined,
    headers: normalizeRecordStringString(obj.headers),
    timeoutMs: normalizeTimeoutMs(obj.timeoutMs),
    messageUrl: messageUrl || undefined,
    ...(auth ? { auth } : {}),
  };
}

export function normalizeMcpSettings(input: unknown): McpSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const servers = Array.isArray(obj.servers)
    ? obj.servers.map((server) => normalizeMcpServerConfig(server))
    : [];

  return {
    servers,
    selected: normalizeMcpSelection(obj.selected, servers),
  };
}

// ---------------------------------------------------------------------------
// Identity-keyed MCP settings operations（agent-gui mcpOps.ts）
// ---------------------------------------------------------------------------

/**
 * Identity-keyed MCP settings operations.
 *
 * All MCP settings writes (tool, UI, sync) must be expressed as ops and merged
 * through `applyMcpOps` inside a `setSettings(prev => ...)` updater. Ops merge
 * against `prev` by server id, so concurrent writers never clobber each other
 * the way whole-object replacement did.
 */
export type McpSettingsOp =
  | { kind: "upsert"; server: McpServerConfig }
  | { kind: "patch"; serverId: string; patch: Partial<McpServerConfig> }
  | { kind: "remove"; serverId: string }
  | { kind: "setEnabled"; serverIds: string[]; enabled: boolean };

function sameServerConfig(a: McpServerConfig, b: McpServerConfig) {
  // Both sides are produced by normalizeMcpServerConfig, which builds the
  // object with a fixed key order, so JSON equality is reliable here.
  return JSON.stringify(a) === JSON.stringify(b);
}

function applyOp(servers: McpServerConfig[], op: McpSettingsOp): McpServerConfig[] {
  switch (op.kind) {
    case "upsert": {
      const server = normalizeMcpServerConfig(op.server);
      if (!server.id) return servers;
      const index = servers.findIndex((item) => item.id === server.id);
      if (index < 0) return [...servers, server];
      if (sameServerConfig(servers[index], server)) return servers;
      return servers.map((item, i) => (i === index ? server : item));
    }
    case "patch": {
      const index = servers.findIndex((item) => item.id === op.serverId);
      if (index < 0) return servers;
      const merged = normalizeMcpServerConfig({
        ...servers[index],
        ...op.patch,
        id: servers[index].id,
      });
      if (sameServerConfig(servers[index], merged)) return servers;
      return servers.map((item, i) => (i === index ? merged : item));
    }
    case "remove": {
      if (!servers.some((item) => item.id === op.serverId)) return servers;
      return servers.filter((item) => item.id !== op.serverId);
    }
    case "setEnabled": {
      const ids = new Set(op.serverIds);
      if (!servers.some((item) => ids.has(item.id) && item.enabled !== op.enabled)) return servers;
      return servers.map((item) =>
        ids.has(item.id) && item.enabled !== op.enabled ? { ...item, enabled: op.enabled } : item,
      );
    }
  }
}

/**
 * Pure reducer: applies ops in order and returns `prev` identity when nothing
 * changed (App.setSettings short-circuits on identity). Never throws and has
 * no side effects, so React StrictMode double invocation is safe.
 */
export function applyMcpOps(prev: McpSettings, ops: McpSettingsOp[]): McpSettings {
  let servers = prev.servers;
  for (const op of ops) {
    servers = applyOp(servers, op);
  }
  if (servers === prev.servers) return prev;
  return normalizeMcpSettings({ servers, selected: prev.selected });
}

/** Servers eligible for dynamic mcp_* tool loading. */
export function selectEnabledMcpServers(settings: McpSettings): McpServerConfig[] {
  return settings.servers.filter((server) => server.enabled && server.id.trim());
}
