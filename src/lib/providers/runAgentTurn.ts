import type { Message } from "@earendil-works/pi-ai";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { runTurn } from "../agent/agentRuntime";
import type { RunTurnResult } from "../agent/agentRuntime";
import { DEFAULT_MAX_STEPS, getTools } from "../agent/tools";
import { buildModel } from "./modelFactory";
import type { ProviderConfig } from "./modelFactory";
import { getFauxAgentSource } from "./fauxSource";
import type { ProviderType } from "./catalog";

export type AgentSource = ProviderType | "faux";

export const DEFAULT_SYSTEM_PROMPT =
  "You are ReinAgent, an autonomous AI programming workbench assistant. You can read, write and edit files, execute commands in the terminal, and help users with coding tasks. One-off scripts, analysis artifacts and other temporary files must be placed under `.ReinAgent/temp/` at the workspace root — never scattered in the project; files there are considered disposable and may be cleaned up. Notes, memories and other persistent reference material you produce for later use must be saved under `.ReinAgent/` as well (each kind in its own subdirectory), never in the project root.";

export interface RunAgentTurnParams {
  source: AgentSource;
  config: ProviderConfig;
  messages: Message[];
  systemPrompt?: string;
  maxSteps?: number;
  workspaceRoot?: string;
  signal?: AbortSignal;
  thinkingLevel?: import("../agent/agentRuntime").RunTurnDeps["thinkingLevel"];
  onEvent: (ev: AgentEvent, signal?: AbortSignal) => void | Promise<void>;
}

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

export async function runAgentTurn(params: RunAgentTurnParams): Promise<RunTurnResult> {
  const { source, config, messages, systemPrompt, signal, onEvent, maxSteps, workspaceRoot, thinkingLevel } = params;

  const tools = getTools(workspaceRoot ? { workspaceRoot } : undefined);
  const prompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const effectiveSystemPrompt = workspaceRoot
    ? `${prompt}\n\nCurrent workspace root: ${workspaceRoot}. Relative paths in tool calls will automatically resolve against this root directory.`
    : prompt;

  const base = {
    systemPrompt: effectiveSystemPrompt,
    messages,
    tools,
    maxSteps: maxSteps ?? DEFAULT_MAX_STEPS,
    signal,
    onEvent,
    thinkingLevel,
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
