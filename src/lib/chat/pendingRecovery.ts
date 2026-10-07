/**
 * pendingRecovery —— 挂起审批/提问的「重载恢复」纯逻辑（2026-10-06 用户定稿完整版）。
 *
 * 背景：审批/提问挂起是内存态（agent 循环停在等待用户决策上），刷新即丢。
 * 修复 = 挂起时持久化（conversationPool 经 controller 钩子写 kv）+ 重载后横幅重放。
 *
 * 恢复语义（与"真续跑"的差别如实声明）：重载后原 agent 循环已不存在，且 toApiMessages
 * 的 B-2/R13 消毒会把中断的 assistant 链从发送视图中剔除——所以恢复**不是**续跑原循环，
 * 而是「代为执行/收集回答 → 组合一条续接用户消息 → 走正常发送」。模型拿到的信息完整
 * （工具结果或问答对），语义等价；消息会以「（续接：…）」前缀如实标注中断事实。
 */

import type { PendingApproval } from "./conversationModel";
import { getTools } from "../agent/tools";

export interface RecoveryExecutionResult {
  ok: boolean;
  resultText: string;
}

const ARGS_JSON_MAX = 2000;
const RESULT_TEXT_MAX = 8000;

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…[截断]` : value;
}

function argsJson(args: unknown): string {
  try {
    return JSON.stringify(args ?? {}, null, 2);
  } catch {
    return String(args);
  }
}

/** 从 content 块数组拼文本（text 块；其余类型如实标注）。 */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  const parts: string[] = [];
  for (const raw of content) {
    const block = raw as { type?: unknown; text?: unknown };
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "image") parts.push("[image]");
    else parts.push(`[${String(block.type ?? "unknown")}]`);
  }
  return parts.join("\n");
}

/**
 * 恢复期真实执行工具（横幅「允许并继续」路径；用户的点击即本次批准）。
 * - 注册表工具：经 getTools 查找并 execute（真实执行，结果即 toolResult 语义）；
 * - MCP 工具（mcp__<serverId>__<name>）：路由到 mcp_call_tool；
 * - 找不到/执行抛错：如实返回失败文本（绝不静默），由模型在下轮自行调整。
 */
export async function executeRecoveryTool(
  toolName: string,
  args: unknown,
  workspaceRoot?: string,
): Promise<RecoveryExecutionResult> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    if (toolName.startsWith("mcp__")) {
      const rest = toolName.slice("mcp__".length);
      const sep = rest.indexOf("__");
      if (sep <= 0) return { ok: false, resultText: `无法解析 MCP 工具名：${toolName}` };
      const serverId = rest.slice(0, sep);
      const mcpToolName = rest.slice(sep + 2);
      const result = (await invoke("mcp_call_tool", {
        serverId,
        toolName: mcpToolName,
        arguments: (args ?? {}) as Record<string, unknown>,
      })) as { content?: unknown; isError?: boolean };
      return { ok: result.isError !== true, resultText: contentToText(result.content) };
    }
    const tools = getTools(workspaceRoot ? { workspaceRoot } : {}) as {
      name: string;
      execute: (toolCallId: string, params: unknown) => Promise<{ content?: unknown; isError?: boolean }>;
    }[];
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (!tool) {
      return {
        ok: false,
        resultText: `工具 ${toolName} 不在当前注册表中（可能为 MCP 工具或已变更），无法代为执行。`,
      };
    }
    const result = await tool.execute(`recovery-${Date.now()}`, args);
    return { ok: result?.isError !== true, resultText: contentToText(result?.content) };
  } catch (err) {
    return { ok: false, resultText: `执行失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 续接消息统一前缀（如实告知中断事实）。 */
const RECOVERY_PREFIX = "（续接：上一个会话中有一项待处理操作因应用重启而中断，以下为该操作与我的处理。）";

/** 提问恢复：问题 + 回答对 → 续接用户消息。 */
export function composeQuestionRecoveryMessage(
  questions: { question: string }[],
  answers: { question: string; answer: string }[],
): string {
  const lines: string[] = [RECOVERY_PREFIX, "你当时的提问与我的回答："];
  answers.forEach((entry, index) => {
    lines.push(`${index + 1}. 问：${entry.question}`);
    lines.push(`   答：${entry.answer}`);
  });
  if (answers.length < questions.length) {
    lines.push("（部分问题未作答，按跳过处理。）");
  }
  lines.push("请基于以上回答继续之前的工作。");
  return lines.join("\n");
}

/** 审批恢复（允许）：工具已代为执行 → 结果作为续接消息。 */
export function composeApprovalAllowMessage(
  toolName: string,
  args: unknown,
  execution: RecoveryExecutionResult,
): string {
  return [
    RECOVERY_PREFIX,
    `你当时请求执行工具 \`${toolName}\`，我已批准并代为执行。参数：`,
    clip(argsJson(args), ARGS_JSON_MAX),
    "执行结果如下：",
    "",
    clip(execution.resultText || "（无输出）", RESULT_TEXT_MAX),
    "",
    execution.ok
      ? "请基于以上执行结果继续之前的工作。"
      : "执行如上失败了；请分析原因并调整方案继续。",
  ].join("\n");
}

/** 审批恢复（拒绝）：告知模型请求被拒。 */
export function composeApprovalRejectMessage(toolName: string, args: unknown): string {
  return [
    RECOVERY_PREFIX,
    `你当时请求执行工具 \`${toolName}\`，参数如下：`,
    "",
    clip(argsJson(args), ARGS_JSON_MAX),
    "",
    "我拒绝了该请求。请调整方案继续；如有必要请先向我说明该操作的目的。",
  ].join("\n");
}

/** 从挂起请求里取提问列表（ask_user_question 的 args.questions；无则空数组）。 */
export function questionsOf(pending: PendingApproval): { question: string }[] {
  const questions = (pending.args as { questions?: unknown } | undefined)?.questions;
  return Array.isArray(questions) ? (questions as { question: string }[]) : [];
}
