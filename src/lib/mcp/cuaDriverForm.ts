import type { McpServerConfig } from "../hub/mcpTypes";
import { kvGet, kvSet } from "../storage/db";
import {
  CUA_DRIVER_SERVER_ID,
  effectiveServerPolicyDefault,
  isCuaDriverServerId,
  serverPolicyKeyCandidates,
  type ToolPolicy,
} from "../hub/mcpServerDefaults";

export { CUA_DRIVER_SERVER_ID };

const KEY_CUA_ALLOW_SELF = "reinagent-cua-allow-self";
const KEY_CUA_POLICY = "reinagent-cua-policy";

export function getCuaAllowSelf(): boolean {
  try {
    return kvGet(KEY_CUA_ALLOW_SELF) === "true";
  } catch {
    return false;
  }
}

export function setCuaAllowSelf(value: boolean): void {
  try {
    kvSet(KEY_CUA_ALLOW_SELF, value ? "true" : "false");
  } catch {}
}

export function getCuaPolicy(): ToolPolicy {
  try {
    const p = kvGet(KEY_CUA_POLICY);
    return p === "allow" || p === "deny" ? p : "ask";
  } catch {
    return "ask";
  }
}

export function setCuaPolicy(policy: ToolPolicy): void {
  try {
    kvSet(KEY_CUA_POLICY, policy);
  } catch {}
}

export type CuaProbe = {
  installed: boolean;
  path?: string | null;
  version?: string | null;
  mcpCommand?: string | null;
  mcpArgs?: string[];
  /** 本平台是否有系统授权门槛。只有 macOS 为 true。 */
  permissionsRequired?: boolean;
  error?: string | null;
};

export type CuaPermissions = {
  supported: boolean;
  accessibility: boolean;
  screenRecording: boolean;
  attributedTo?: string | null;
  error?: string | null;
};

export type CuaInstallPreview = {
  program: string;
  args: string[];
  display: string;
  sourceUrl: string;
};

export type CuaInstallProgress = { stream: string; line: string };

export const CUA_DEFAULT_TIMEOUT_MS = 60_000;
export const CUA_MAX_TIMEOUT_MS = 600_000;
export const CUA_MIN_TIMEOUT_MS = 1_000;
export const CUA_INSTALL_PROGRESS_EVENT = "cua_driver_install_progress";
export const CUA_MAX_LOG_LINES = 200;
export const CUA_UPSTREAM_REPO_URL = "https://github.com/trycua/cua";

/** 找出受管的那条 cua-driver 条目（大小写与空白不敏感）。 */
export function findCuaDriverServer(servers: readonly McpServerConfig[]): McpServerConfig | undefined {
  return servers.find((server) => isCuaDriverServerId(server.id));
}

/** 同上，返回下标——写回时按原位置改。找不到返回 -1。 */
export function findCuaDriverServerIndex(servers: readonly McpServerConfig[]): number {
  return servers.findIndex((server) => isCuaDriverServerId(server.id));
}

export function cuaPolicyKeyCandidates(entry: McpServerConfig | undefined): string[] {
  return serverPolicyKeyCandidates(entry?.id.trim() || CUA_DRIVER_SERVER_ID);
}

export function cuaServerPolicyKey(entry: McpServerConfig | undefined): string {
  return cuaPolicyKeyCandidates(entry)[0];
}

export function cuaDefaultPolicy(entry: McpServerConfig | undefined): ToolPolicy {
  return effectiveServerPolicyDefault(entry ?? { id: CUA_DRIVER_SERVER_ID });
}

export function readCuaPolicy(
  policies: Record<string, ToolPolicy> | undefined,
  entry: McpServerConfig | undefined,
): ToolPolicy {
  for (const key of cuaPolicyKeyCandidates(entry)) {
    const policy = policies?.[key];
    if (policy) return policy;
  }
  return cuaDefaultPolicy(entry);
}

export function applyCuaPolicy(
  policies: Record<string, ToolPolicy> | undefined,
  entry: McpServerConfig | undefined,
  next: ToolPolicy,
): Record<string, ToolPolicy> | undefined {
  const current = { ...(policies ?? {}) };
  for (const key of cuaPolicyKeyCandidates(entry)) delete current[key];
  if (next !== cuaDefaultPolicy(entry)) current[cuaServerPolicyKey(entry)] = next;
  return Object.keys(current).length > 0 ? current : undefined;
}

/** 由探测结果生成受管条目。 */
export function buildCuaServerConfig(probe: CuaProbe): McpServerConfig {
  return {
    id: CUA_DRIVER_SERVER_ID,
    description: "trycua/cua — CUA 驱动（跨平台桌面操作）",
    docsUrl: CUA_UPSTREAM_REPO_URL,
    enabled: true,
    transport: "stdio",
    // 绝对路径而非裸命令：MCP 子进程继承窄 PATH
    command: probe.mcpCommand || probe.path || "cua-driver",
    args: probe.mcpArgs?.length ? probe.mcpArgs : ["mcp"],
    url: "",
    timeoutMs: CUA_DEFAULT_TIMEOUT_MS,
  };
}

export function clampCuaTimeoutMs(draft: string, fallback: number): number {
  const parsed = Number.parseInt(draft.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(parsed, CUA_MIN_TIMEOUT_MS), CUA_MAX_TIMEOUT_MS);
}

export function cuaCommandDrift(
  entry: McpServerConfig | undefined,
  probe: CuaProbe | null,
): { configured: string; probed: string } | null {
  const configured = entry?.command?.trim();
  const probed = (probe?.mcpCommand || probe?.path || "").trim();
  if (!configured || !probed || configured === probed) return null;
  return { configured, probed };
}

export function cuaDisplayCommand(
  entry: McpServerConfig | undefined,
  probe: CuaProbe | null,
): string | null {
  return entry?.command?.trim() || probe?.path?.trim() || null;
}

export function realignCuaServerConfig(entry: McpServerConfig, probe: CuaProbe): McpServerConfig {
  const fresh = buildCuaServerConfig(probe);
  return { ...entry, command: fresh.command, args: fresh.args };
}

export const CUA_PROBE_CACHE_TTL_MS = 60_000;

type CuaProbeCache = { at: number; probe: CuaProbe; permissions: CuaPermissions | null };

let probeCache: CuaProbeCache | null = null;

export function readCuaProbeCache(now = Date.now()): CuaProbeCache | null {
  if (!probeCache) return null;
  return now - probeCache.at <= CUA_PROBE_CACHE_TTL_MS ? probeCache : null;
}

export function writeCuaProbeCache(
  probe: CuaProbe,
  permissions: CuaPermissions | null,
  now = Date.now(),
) {
  probeCache = { at: now, probe, permissions };
}

export function patchCuaProbeCachePermissions(permissions: CuaPermissions) {
  if (probeCache) probeCache = { ...probeCache, permissions };
}

export function resetCuaProbeCache() {
  probeCache = null;
}
