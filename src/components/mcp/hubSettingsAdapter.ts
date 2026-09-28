// LiveAgent 移植适配层：LA 的 updateMcp(prev, patch) 助手（@liveagent/app/lib/settings）
// 在本项目的同形实现 —— 对 HubAppSettings 的 mcp 切片做浅合并，其余切片原样保留。
// 调用形态与 LA 完全一致：setSettings((prev) => updateMcp(prev, { servers: ... }))。
import type { McpSettings } from "../../lib/hub/mcpTypes";
import type { HubAppSettings } from "../../store/hubSettingsStore";

export function updateMcp(prev: HubAppSettings, patch: Partial<McpSettings>): HubAppSettings {
  return { ...prev, mcp: { ...prev.mcp, ...patch } };
}
