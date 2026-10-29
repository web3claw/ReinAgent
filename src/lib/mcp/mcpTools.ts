/**
 * mcpTools —— 把 MCP 服务器的工具接入 Agent 工具循环（对齐 LiveAgent
 * createMcpTools 的枚举策略：一次 mcp_list_tools 传全量启用服务器列表，
 * 工具名加 `mcp__<serverId>__<tool>` 前缀避免冲突；执行经 `mcp_call_tool`
 * 按 serverId+toolName 透传）。失败的服务器由后端跳过、前端如实记录
 * （No-Fallback：不伪造工具）。
 */

import { invoke } from "@tauri-apps/api/core";
import { Type } from "typebox";
import type { McpServerConfig } from "../hub/mcpTypes";
import { isCuaDriverServer } from "../hub/mcpServerDefaults";
import { resolveCuaSelfGuard } from "./cuaSelfGuard";
import { getCuaAllowSelf, getCuaPolicy } from "./cuaDriverForm";

/** 后端 mcp_list_tools 的条目（LA McpToolInfo 同构） */
export interface McpToolEntry {
  serverId: string;
  serverLabel: string;
  name: string;
  description: string;
  inputSchema: unknown;
}

/** 组装 toApiMessages 用的 text 结果 */
function textResult(text: string, isError: boolean) {
  return {
    content: [{ type: "text", text }],
    details: { mcp: true, isError },
  };
}

import { resolveAssistantMcpServers } from "../assistants/assistantToolFilter";

/**
 * 枚举助手勾选且全局启用的 MCP 服务器工具，转成 pi-agent-core 工具体。
 * 每个工具有独立的 execute：调用时按 serverId+toolName 透传 `mcp_call_tool`。
 * 运行期单次枚举（发送时冻结），服务器增删在下一轮发送生效。
 *
 * @param allowedServerIds 当前助手勾选的 MCP 服务 ID 清单。若未传或为空，直接返回 []（0 个工具）。
 */
export async function createMcpTools(allowedServerIds?: string[]): Promise<unknown[]> {
  if (!Array.isArray(allowedServerIds) || allowedServerIds.length === 0) {
    return [];
  }
  let servers: McpServerConfig[] = [];
  try {
    servers = await invoke<McpServerConfig[]>("mcp_list_servers");
  } catch (err) {
    console.warn("[mcp] list servers failed (web mode?):", err);
    return [];
  }
  const enabled = resolveAssistantMcpServers(servers, allowedServerIds);
  if (enabled.length === 0) return [];

  let entries: McpToolEntry[];
  try {
    entries = await invoke<McpToolEntry[]>("mcp_list_tools", { servers: enabled });
  } catch (err) {
    // 全部启用服务器都失败（后端部分失败跳过、全失败才 Err）：如实告知用户
    // 「启用了却没带上」，不能只留在 console（No-Fallback 铁律）
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[mcp] list tools failed (skipped):", err);
    try {
      const { useHubSettings } = await import("../../store/hubSettingsStore");
      useHubSettings
        .getState()
        .setMcpEnumNotice(`MCP 工具枚举失败，本轮未带上 MCP 工具：${message}`);
    } catch {
      // store 不可达（极端场景）时保留 console 告警
    }
    return [];
  }

  const byServerId = new Map(enabled.map((s) => [s.id, s]));
  const tools: unknown[] = [];
  for (const tool of entries) {
    const server = byServerId.get(tool.serverId);
    if (!server || !tool.name) continue;
    tools.push(buildMcpTool(server, tool));
  }
  return tools;
}

/** 单个 MCP 工具 → pi-agent-core 工具体（name 前缀 mcp__<serverId>__<tool>） */
export function buildMcpTool(server: McpServerConfig, tool: McpToolEntry) {
  const prefixedName = `mcp__${server.id}__${tool.name}`;
  const description =
    `[MCP:${tool.serverLabel || server.id}] ${tool.description || tool.name}`.slice(0, 500);
  return {
    name: prefixedName,
    label: tool.name,
    description,
    // 直接透传 MCP 服务器返回的 JSON Schema；pi-ai 对无 typebox 标记的
    // schema 会走 coerceWithJsonSchema 校验路径，天然支持标准 JSON Schema
    parameters:
      tool.inputSchema && typeof tool.inputSchema === "object"
        ? (tool.inputSchema as Record<string, unknown>)
        : Type.Object({}, { additionalProperties: true }),
    execute: async (_toolCallId: string, args: unknown) => {
      if (isCuaDriverServer(server)) {
        const policy = getCuaPolicy();
        if (policy === "deny") {
          return textResult("该调用已被工具审批策略拒绝（策略已设置为「拒绝」）。", true);
        }
        const guard = await resolveCuaSelfGuard(getCuaAllowSelf());
        if (guard) {
          const refusal = await guard.refuse(tool.name, args as Record<string, unknown>);
          if (refusal) {
            return textResult(refusal, true);
          }
        }
      }

      try {
        const result = await invoke<Record<string, unknown>>("mcp_call_tool", {
          serverId: server.id,
          toolName: tool.name,
          arguments: args ?? {},
        });
        const isError = result.isError === true;
        const content = Array.isArray(result.content) ? result.content : [];
        let text = content
          .map((block) => {
            const record = block as { type?: string; text?: string };
            return record.type === "text" && typeof record.text === "string" ? record.text : "";
          })
          .filter(Boolean)
          .join("\n") || JSON.stringify(result);

        if (isCuaDriverServer(server) && !getCuaAllowSelf()) {
          const guard = await resolveCuaSelfGuard(false);
          if (guard) {
            text = guard.strip(text);
          }
        }

        return textResult(isError ? `MCP 工具报告失败：\n${text}` : text, isError);
      } catch (err) {
        throw new Error(
          `MCP 调用失败（${tool.serverLabel || server.id}/${tool.name}）: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
  };
}
