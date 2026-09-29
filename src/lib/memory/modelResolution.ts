/**
 * modelResolution.ts —— 记忆管线独立模型解析（P2 尾巴 #6）。
 *
 * 「记忆整理」独立模型（MemorySettings.organizerModel，记忆设置抽屉选择）对两条
 * 记忆管线统一生效：
 * - Organizer 编排批（App 层 resolveModelDeps，原逻辑收编于此）；
 * - 聊天后 Extraction 抽取（pool.maybeExtractMemory——原先无条件用主对话模型，
 *   独立模型配置被无视）。
 *
 * 未配置（或供应商不存在/已删）返回 null，调用方回落主对话模型（LA fallback 语义）。
 * 供应商存在但 API Key 为空 → 抛错（No-Fallback：不静默换模型）。
 */

import type { MemorySettings } from "../../store/hubSettingsStore";
import type { ProviderItem } from "../../components/settings/model-provider/types";
import type { ExtractionModelDeps } from "./extraction/extractionEngine";

const API_FORMAT_TO_TYPE: Record<string, string> = {
  "openai-chat-completions": "openai",
  "openai-completions": "openai",
  "openai-responses": "openai",
  "anthropic-messages": "anthropic",
  "google-generative-ai": "gemini",
};

export async function resolveIndependentMemoryModelDeps(
  memory: Pick<MemorySettings, "organizerModel">,
  providers: ProviderItem[],
): Promise<ExtractionModelDeps | null> {
  const providerId = memory.organizerModel?.customProviderId?.trim() ?? "";
  const modelId = memory.organizerModel?.model?.trim() ?? "";
  if (!providerId || !modelId) return null;

  const provider = providers.find((item) => item.id === providerId);
  if (!provider) return null;
  if (!provider.apiKey.trim()) {
    throw new Error(`记忆整理模型供应商 API Key 为空：${provider.name || provider.id}`);
  }

  const { buildModel } = await import("../providers/modelFactory");
  const { getStreamFnForApi } = await import("../providers/runAgentTurn");
  const model = buildModel({
    provider: (API_FORMAT_TO_TYPE[provider.apiFormat] ?? "openai") as never,
    apiKey: provider.apiKey,
    modelId,
    baseUrl: provider.baseUrl,
  });
  const stream = await getStreamFnForApi(model.api);
  return {
    model,
    stream,
    api: model.api,
    label: `${provider.id}/${modelId}`,
    getApiKey: () => provider.apiKey,
    thinkingLevel: undefined,
  };
}
