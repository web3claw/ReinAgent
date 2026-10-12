/**
 * 「这条 MCP server 的工具面直接操作用户的机器」的唯一判定处。
 *
 * `cua-driver` 暴露的 60 个工具包含 kill_app、clipboard_write、type_text 等，
 * 默认策略为 ask，并且套上自指闸门（cuaSelfGuard.ts）。
 */

export type ServerIdentity = {
  id?: string | null;
  command?: string | null;
};

export type ToolPolicy = "allow" | "ask" | "deny";

export const CUA_DRIVER_SERVER_ID = "cua-driver";

const CUA_DRIVER_BINARY = "cua-driver";

export function canonicalServerId(serverId: string): string {
  return serverId.trim().toLowerCase();
}

function commandBasename(command: string): string {
  const trimmed = command.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) return "";
  const segments = trimmed.split(/[\\/]/);
  const last = segments[segments.length - 1] ?? "";
  return last.replace(/\.exe$/i, "").toLowerCase();
}

export function isCuaDriverServer(server: ServerIdentity | undefined | null): boolean {
  if (!server) return false;
  if (canonicalServerId(server.id ?? "") === CUA_DRIVER_SERVER_ID) return true;
  return commandBasename(server.command ?? "") === CUA_DRIVER_BINARY;
}

export const TOOL_SERVER_POLICY_PREFIX = "server:";

export function toolServerPolicyKey(serverId: string): string {
  return `${TOOL_SERVER_POLICY_PREFIX}${serverId}`;
}

export function serverPolicyKeyCandidates(serverId: string): string[] {
  const raw = toolServerPolicyKey(serverId.trim());
  const normalized = toolServerPolicyKey(canonicalServerId(serverId));
  return raw === normalized ? [raw] : [raw, normalized];
}

export function hardcodedServerPolicyDefault(
  server: ServerIdentity | undefined | null,
): ToolPolicy | undefined {
  return isCuaDriverServer(server) ? "ask" : undefined;
}

export function effectiveServerPolicyDefault(
  server: ServerIdentity | undefined | null,
): ToolPolicy {
  return hardcodedServerPolicyDefault(server) ?? "allow";
}

export function isHubHiddenServerId(serverId: string): boolean {
  return canonicalServerId(serverId) === CUA_DRIVER_SERVER_ID;
}

export function isCuaDriverServerId(serverId: string | undefined | null): boolean {
  return canonicalServerId(serverId ?? "") === CUA_DRIVER_SERVER_ID;
}
