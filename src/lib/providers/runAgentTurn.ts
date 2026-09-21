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
  "You are ReinAgent, an autonomous AI programming workbench assistant. You can read, write and edit files, execute commands in the terminal, and help users with coding tasks.";

export interface RunAgentTurnParams {
  source: AgentSource;
  config: ProviderConfig;
  messages: Message[];
  systemPrompt?: string;
  signal?: AbortSignal;
  onEvent: (ev: AgentEvent, signal?: AbortSignal) => void | Promise<void>;
}

async function getStreamFnForApi(api: string) {
  if (api === "anthropic-messages") {
    const mod = await import("@earendil-works/pi-ai/api/anthropic-messages");
    return mod.stream;
  }
  if (api === "google-generative-ai") {
    const mod = await import("@earendil-works/pi-ai/api/google-generative-ai");
    return mod.stream;
  }
  const mod = await import("@earendil-works/pi-ai/api/openai-completions");
  return mod.stream;
}

export async function runAgentTurn(params: RunAgentTurnParams): Promise<RunTurnResult> {
  const { source, config, messages, systemPrompt, signal, onEvent } = params;

  const base = {
    systemPrompt: systemPrompt || DEFAULT_SYSTEM_PROMPT,
    messages,
    tools: getTools(),
    maxSteps: DEFAULT_MAX_STEPS,
    signal,
    onEvent,
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
