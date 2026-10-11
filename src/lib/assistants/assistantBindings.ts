/**
 * assistantBindings —— 助手绑定套用（2026-10-11 用户定稿：助手 = 一键预设包）。
 *
 * 语义（用户确认）：
 * - 应用助手的那一刻，绑定的模型/思考级别/技能/MCP 一次性套用；
 * - 之后用户在任务里手动改动以手动为准（不持续锁定）；
 * - 未绑定的维度维持现状不动（通用助手不绑 = 什么都不改）。
 *
 * 纯逻辑（可 node --test），副作用由调用方注入。
 */

import type { AssistantDef } from "./assistantDefs.ts";
// ThinkingLevel 从 useAppStore 以 type-only 引入（路径层级深一级）
import type { ThinkingLevel } from "../../store/useAppStore";

/** 合法思考等级（与 useAppStore ThinkingLevel 一致）。 */
const THINKING_LEVELS = new Set(["off", "default", "low", "medium", "high", "xhigh", "max"]);

/** "providerId/modelId" → { providerId, modelId }；形态非法返回 null（No-Fallback）。 */
export function parseAssistantModel(model: string | undefined): { providerId: string; modelId: string } | null {
  if (!model) return null;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash >= model.length - 1) return null;
  const providerId = model.slice(0, slash).trim();
  const modelId = model.slice(slash + 1).trim();
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}

export function isValidThinkingLevel(level: string | undefined): level is ThinkingLevel {
  return !!level && THINKING_LEVELS.has(level);
}

export interface AssistantBindingsPlan {
  /** 任务字段套用（未绑 = undefined，调用方跳过对应 update）。 */
  taskModel: { providerId: string; modelId: string } | undefined;
  taskThinkingLevel: ThinkingLevel | undefined;
  /** 技能启用子集（绑定了 skills 才有值；整组替换 skills.selected）。 */
  skillSelection: string[] | undefined;
  /** MCP 启用集合（绑定了 mcpServers 才有值：列表内 = 启用，列表外 = 禁用——整组替换语义）。 */
  mcpEnabledIds: string[] | undefined;
  /** 人类可读的套用摘要（toast 用；空绑定 = 空串）。 */
  summary: string;
}

/** 依据助手绑定产出套用计划；未绑定的维度为 undefined（调用方跳过）。 */
export function buildAssistantBindingsPlan(
  def: AssistantDef | null | undefined,
  allMcpServerIds: readonly string[],
): AssistantBindingsPlan {
  const taskModel = parseAssistantModel(def?.model);
  const taskThinkingLevel = isValidThinkingLevel(def?.thinkingLevel) ? def.thinkingLevel : undefined;
  const skillSelection = Array.isArray(def?.skills) && def.skills.length > 0 ? [...def.skills] : undefined;
  const mcpServers = def?.mcpServers;
  const mcpEnabledIds =
    Array.isArray(mcpServers) && mcpServers.length > 0
      ? // 整组替换：绑定清单内的启用；清单外的既有服务器全部禁用（保持原顺序）
        allMcpServerIds.filter((id) => mcpServers.includes(id))
      : undefined;

  const parts: string[] = [];
  if (taskModel) parts.push("模型");
  if (taskThinkingLevel) parts.push("思考级别");
  if (skillSelection) parts.push(`技能×${skillSelection.length}`);
  if (mcpEnabledIds) parts.push(`MCP×${mcpEnabledIds.length}`);
  return {
    taskModel: taskModel ?? undefined,
    taskThinkingLevel,
    skillSelection,
    mcpEnabledIds,
    summary: parts.length > 0 ? parts.join(" / ") : "",
  };
}
