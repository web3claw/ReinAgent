/**
 * assistantToolFilter —— 助手 MCP 工具与 Skill 技能联动与白名单解析器。
 *
 * 核心逻辑（对齐 2026-10-29 用户定稿）：
 * 1. 助手页面展示联动：
 *    - MCP 选项：仅展示全局已启用的 MCP 服务（enabled === true）；
 *    - Skill 选项：仅展示全局已启用的技能（skills.enabled && selected.includes(name)）。
 * 2. 对话执行精准注入：
 *    - MCP 工具：仅加载当前助手勾选且全局启用的 MCP 服务；未勾选则完全不带 MCP（0 个工具）；
 *    - Skill 提示词：仅注入当前助手勾选且全局启用的 Skill；未勾选则完全不注入（0 个技能）。
 */

import type { McpServerConfig } from "../hub/mcpTypes";

export interface GlobalSkillsSettingsSubset {
  enabled: boolean;
  selected: string[];
}

/**
 * 依据助手勾选的 mcpServers 与全局 MCP 服务状态，解析当前会话应启用的 MCP 服务。
 * 铁律：若助手未勾选任何 MCP（undefined 或空数组），绝对返回空数组 []，不带任何 MCP 工具。
 */
export function resolveAssistantMcpServers(
  allServers: McpServerConfig[],
  assistantMcpIds?: string[],
): McpServerConfig[] {
  if (!Array.isArray(assistantMcpIds) || assistantMcpIds.length === 0) {
    return [];
  }
  const allowedSet = new Set(assistantMcpIds);
  return allServers.filter((s) => s.enabled && allowedSet.has(s.id));
}

/**
 * 依据助手勾选的 skills 与全局技能设置，解析当前会话应激活的 Skill 名称列表。
 * 铁律：若助手未勾选任何 Skill（undefined 或空数组），绝对返回空数组 []，不注入任何技能。
 */
export function resolveAssistantSkills(
  discoveredSkills: { name: string }[],
  globalSettings: GlobalSkillsSettingsSubset,
  assistantSkills?: string[],
): string[] {
  if (!Array.isArray(assistantSkills) || assistantSkills.length === 0) {
    return [];
  }
  if (!globalSettings || !globalSettings.enabled || !Array.isArray(globalSettings.selected) || globalSettings.selected.length === 0) {
    return [];
  }
  const globalSelectedSet = new Set(globalSettings.selected);
  const assistantSet = new Set(assistantSkills);
  // 必须既在助手勾选列表中，又在全局选中列表中，且在真实发现的技能列表中
  return discoveredSkills
    .map((s) => s.name)
    .filter((name) => assistantSet.has(name) && globalSelectedSet.has(name));
}

/**
 * 助手编辑页面可供勾选的 MCP 候选列表：仅展示全局 enabled: true 的服务器。
 */
export function getAssistantMcpOptions(
  allServers: McpServerConfig[],
): { id: string; label: string; description?: string }[] {
  return allServers
    .filter((s) => s.enabled === true)
    .map((s) => ({
      id: s.id,
      label: (s as { label?: string }).label || s.id,
      description: (s as { description?: string }).description,
    }));
}

/**
 * 助手编辑页面可供勾选的 Skill 候选列表：仅展示全局开启且已选中的技能。
 */
export function getAssistantSkillOptions(
  discoveredSkills: { name: string; description?: string }[],
  globalSettings: GlobalSkillsSettingsSubset,
): { id: string; name: string; description?: string }[] {
  if (!globalSettings || !globalSettings.enabled || !Array.isArray(globalSettings.selected) || globalSettings.selected.length === 0) {
    return [];
  }
  const selectedSet = new Set(globalSettings.selected);
  return discoveredSkills
    .filter((s) => selectedSet.has(s.name))
    .map((s) => ({
      id: s.name,
      name: s.name,
      description: s.description,
    }));
}
