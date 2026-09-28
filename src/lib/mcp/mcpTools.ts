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

/** 后端 mcp_list_tools 的条目（LA McpToolInfo 同构） */
interface McpToolEntry {
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

/**
 * 枚举全部启用服务器上的 MCP 工具，转成 pi-agent-core 工具体。
 * 每个工具有独立的 execute：调用时按 serverId+toolName 透传 `mcp_call_tool`。
 * 运行期单次枚举（发送时冻结），服务器增删在下一轮发送生效。
 */
export async function createMcpTools(): Promise<unknown[]> {
  let servers: McpServerConfig[] = [];
  try {
    servers = await invoke<McpServerConfig[]>("mcp_list_servers");
  } catch (err) {
    console.warn("[mcp] list servers failed (web mode?):", err);
    return [];
  }
  const enabled = servers.filter((s) => s.enabled);
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
function buildMcpTool(server: McpServerConfig, tool: McpToolEntry) {
  const prefixedName = `mcp__${server.id}__${tool.name}`;
  const description =
    `[MCP:${tool.serverLabel || server.id}] ${tool.description || tool.name}`.slice(0, 500);
  return {
    name: prefixedName,
    label: tool.name,
    description,
    // MCP 工具自带 JSON Schema；无法静态表达 → any 兜底（库侧仍会校验参数合法性）
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: async (_toolCallId: string, args: unknown) => {
      try {
        const result = await invoke<Record<string, unknown>>("mcp_call_tool", {
          serverId: server.id,
          toolName: tool.name,
          arguments: args ?? {},
        });
        const isError = result.isError === true;
        const content = Array.isArray(result.content) ? result.content : [];
        const text = content
          .map((block) => {
            const record = block as { type?: string; text?: string };
            return record.type === "text" && typeof record.text === "string" ? record.text : "";
          })
          .filter(Boolean)
          .join("\n") || JSON.stringify(result);
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
