import type { Message } from "@earendil-works/pi-ai";
import type { AgentEvent, BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import { runTurn } from "../agent/agentRuntime";
import type { RunTurnResult } from "../agent/agentRuntime";
import { DEFAULT_MAX_STEPS, getTools, resolveToolPermissionKind } from "../agent/tools";
import { buildModel } from "./modelFactory";
import type { ProviderConfig } from "./modelFactory";
import { getFauxAgentSource } from "./fauxSource";
import type { ProviderType } from "./catalog";

export type AgentSource = ProviderType | "faux";

/** 审批模式（对齐 ZCode 用户可切面：build/edit/plan/yolo）。 */
export type ApprovalMode = "plan" | "ask" | "edit" | "full";

/** 一次待审批的工具调用请求（UI 渲染审批卡所需的全部信息）。 */
export interface ApprovalRequest {
  toolName: string;
  toolCallId: string;
  args: unknown;
}

/** 审批决策：allow=本次允许；always=本任务内该工具后续免审；reject=拒绝。 */
export type ApprovalDecision = "allow" | "always" | "reject";

/**
 * 审批协调器：由会话池按任务注入（「总是允许」集合是任务级内存态），
 * request 挂起等待 UI 决策、isAlwaysAllowed/allowAlways 维护免审集合。
 */
export interface ApprovalCoordinator {
  request: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  isAlwaysAllowed: (toolName: string) => boolean;
  allowAlways: (toolName: string) => void;
}

export const DEFAULT_SYSTEM_PROMPT =
  "You are ReinAgent, an autonomous AI programming workbench assistant. You can read, write and edit files, execute commands in the terminal, and help users with coding tasks. One-off scripts, analysis artifacts and other temporary files must be placed under `.ReinAgent/temp/` at the workspace root — never scattered in the project; files there are considered disposable and may be cleaned up. Notes, memories and other persistent reference material you produce for later use must be saved under `.ReinAgent/` as well (each kind in its own subdirectory), never in the project root.";

/** 计划模式的系统提示词约束：只读分析 + 输出计划，写入/执行一律被拦截。 */
export const PLAN_MODE_PROMPT =
  "\n\n[Plan Mode] The current task is in PLAN mode: you may ONLY use read-only tools (read_file / list_dir) to inspect the code. Writing or editing files and executing commands are BLOCKED by the approval gate. Do NOT retry blocked calls. Instead, finish your investigation and present a complete implementation plan (files to change, exact edits per file, and execution steps), then wait for the user to review and switch out of plan mode.";

export interface RunAgentTurnParams {
  source: AgentSource;
  config: ProviderConfig;
  messages: Message[];
  systemPrompt?: string;
  maxSteps?: number;
  workspaceRoot?: string;
  signal?: AbortSignal;
  thinkingLevel?: import("../agent/agentRuntime").RunTurnDeps["thinkingLevel"];
  /** 本轮审批模式（任务级，发送时冻结）。缺省 "full"（完全访问，零审批开销）。 */
  approvalMode?: ApprovalMode;
  /** 审批协调器（由会话池注入；缺省时不注入审批门，工具直通）。 */
  approval?: ApprovalCoordinator;
  onEvent: (ev: AgentEvent, signal?: AbortSignal) => void | Promise<void>;
}

/** 非完全访问模式的系统提示词补充：写入/执行可能需要用户批准，拒绝即用户否决。 */
const APPROVAL_HINT_PROMPT =
  "\n\n[Approval Gate] In this task, file writes/edits and command execution may require explicit user approval. A blocked tool call means the user DECLINED it — do not retry the same call; explain and continue.";

/**
 * 取各协议的流式入口。必须用 `streamSimple`（而非裸 `stream`）：
 * `streamSimple` 负责把会话层的 `reasoning`（思考等级）钳制变换为 `reasoningEffort`，
 * 并按协议组装思考开关（如 DeepSeek `thinking: {type: "enabled"}`）。
 * 裸 `stream` 只认已变换好的 `reasoningEffort` —— 传 `reasoning` 会被无视，
 * 且对 DeepSeek 等协议会落入「显式禁用思考」分支（thinking: disabled），
 * 导致模型永远不输出思考过程。
 */
async function getStreamFnForApi(api: string) {
  if (api === "anthropic-messages") {
    const mod = await import("@earendil-works/pi-ai/api/anthropic-messages");
    return mod.streamSimple ?? mod.stream;
  }
  if (api === "google-generative-ai") {
    const mod = await import("@earendil-works/pi-ai/api/google-generative-ai");
    return mod.streamSimple ?? mod.stream;
  }
  const mod = await import("@earendil-works/pi-ai/api/openai-completions");
  return mod.streamSimple ?? mod.stream;
}

/**
 * 组装审批门钩子（pi-agent-core `beforeToolCall`）。
 *
 * 语义对齐 ZCode 权限流：工具执行前裁决；需要批准时挂起等待（await 用户决策，
 * 循环不中止）；拒绝 → `{block:true, reason}` 产生错误工具结果（模型知道被拒）。
 * 模式矩阵：
 * - plan：write/exec 一律拦截（不发审批请求）；
 * - ask：write/exec 均需批准；edit：write 自动放行，exec 需批准；
 * - full：全部放行；read 类任何模式都放行；「总是允许」按任务内免审集合放行。
 *
 * 导出供无头测试直接驱动（faux 数据源只会调 read 类工具，覆盖不了 write/exec 矩阵）。
 */
export function createApprovalGate(
  approvalMode: ApprovalMode,
  approval: ApprovalCoordinator,
): (ctx: BeforeToolCallContext, signal?: AbortSignal) => Promise<{ block?: boolean; reason?: string } | undefined> {
  return async (ctx, signal) => {
    const toolName = ctx.toolCall.name;
    const kind = resolveToolPermissionKind(toolName);

    if (kind === "read" || approvalMode === "full") return undefined;
    if (approvalMode === "plan") {
      return {
        block: true,
        reason:
          "[Plan Mode] 已拦截：当前任务处于计划模式，禁止写入/修改文件与执行命令。请继续只读调研并输出实施计划，不要重试该调用。",
      };
    }
    if (approvalMode === "edit" && kind === "write") return undefined;
    if (approval.isAlwaysAllowed(toolName)) return undefined;

    // 挂起等待用户决策；abort 时以 reject 收场（钩子负责尊重 abort signal）。
    const decision = await new Promise<ApprovalDecision>((resolve) => {
      let settled = false;
      const settle = (value: ApprovalDecision) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => settle("reject");
      signal?.addEventListener("abort", onAbort, { once: true });
      approval
        .request({ toolName, toolCallId: ctx.toolCall.id, args: ctx.args })
        .then((d) => settle(d))
        .catch((err) => {
          console.error("[approval] request failed:", err);
          settle("reject");
        });
    });

    if (decision === "reject") {
      return {
        block: true,
        reason: `[Approval] 用户拒绝了本次 ${toolName} 调用。不要重试同样的调用；请说明意图或改用其它方案继续。`,
      };
    }
    if (decision === "always") approval.allowAlways(toolName);
    return undefined;
  };
}

export async function runAgentTurn(params: RunAgentTurnParams): Promise<RunTurnResult> {
  const {
    source,
    config,
    messages,
    systemPrompt,
    signal,
    onEvent,
    maxSteps,
    workspaceRoot,
    thinkingLevel,
    approvalMode = "full",
    approval,
  } = params;

  const tools = getTools(workspaceRoot ? { workspaceRoot } : undefined);
  const prompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;
  let effectiveSystemPrompt = workspaceRoot
    ? `${prompt}\n\nCurrent workspace root: ${workspaceRoot}. Relative paths in tool calls will automatically resolve against this root directory.`
    : prompt;
  if (approvalMode === "plan") {
    effectiveSystemPrompt += PLAN_MODE_PROMPT;
  } else if (approvalMode !== "full") {
    effectiveSystemPrompt += APPROVAL_HINT_PROMPT;
  }

  const base = {
    systemPrompt: effectiveSystemPrompt,
    messages,
    tools,
    maxSteps: maxSteps ?? DEFAULT_MAX_STEPS,
    signal,
    onEvent,
    thinkingLevel,
    // 审批门：非 full 模式（且有协调器）才注入；full 下零开销直通。
    beforeToolCall: approval && approvalMode !== "full" ? createApprovalGate(approvalMode, approval) : undefined,
  };

  if (source === "faux") {
    const faux = await getFauxAgentSource();
    return runTurn({
      model: faux.model,
      stream: faux.stream,
      api: faux.api,
      label: faux.label,
      ...base,
    });
  }

  const model = buildModel(config);
  const stream = await getStreamFnForApi(model.api);

  return runTurn({
    model,
    stream,
    api: model.api,
    label: model.provider || "openai-completions",
    getApiKey: () => config.apiKey.trim(),
    ...base,
  });
}
