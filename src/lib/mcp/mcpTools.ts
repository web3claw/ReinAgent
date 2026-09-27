/**
 * mcpTools —— 把 MCP 服务器的工具接入 Agent 工具循环（对齐 LiveAgent
 * createMcpTools 的枚举策略：所有 enabled 服务器各调一次 mcp_list_tools，
 * 工具名加 `mcp__<server>__` 前缀避免冲突；执行经 `mcp_call_tool` 透传）。
 * 失败的服务器如实跳过并在 console 记录（No-Fallback：不伪造工具）。
 */

import { invoke } from "@tauri-apps/api/core";
import { Type } from "typebox";

/** Rust `mcp.rs` 的 McpServerConfig（camelCase 一致） */
export interface McpServerConfig {
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

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: unknown;
}

interface McpListToolsResult {
  serverId: string;
  tools: McpToolInfo[];
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

  const tools: unknown[] = [];
  for (const server of servers.filter((s) => s.enabled)) {
    let result: McpListToolsResult;
    try {
      result = await invoke<McpListToolsResult>("mcp_list_tools", { server });
    } catch (err) {
      console.warn(`[mcp] list tools for ${server.id} failed (skipped):`, err);
      continue;
    }
    for (const tool of result.tools) {
      if (!tool.name) continue;
      tools.push(buildMcpTool(server, tool));
    }
  }
  return tools;
}

/** 单个 MCP 工具 → pi-agent-core 工具体（name 前缀 mcp__<serverId>__<tool>） */
function buildMcpTool(server: McpServerConfig, tool: McpToolInfo) {
  const prefixedName = `mcp__${server.id}__${tool.name}`;
  const description =
    `[MCP:${server.name || server.id}] ${tool.description || tool.name}`.slice(0, 500);
  return {
    name: prefixedName,
    label: tool.name,
    description,
    // MCP 工具自带 JSON Schema；无法静态表达 → any 兜底（库侧仍会校验参数合法性）
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: async (_toolCallId: string, args: unknown) => {
      try {
        const result = await invoke<Record<string, unknown>>("mcp_call_tool", {
          server,
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
          `MCP 调用失败（${server.name || server.id}/${tool.name}）: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
  };
}
