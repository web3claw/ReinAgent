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
 * 供应商或所选模型被禁用 → 抛错（F7：禁用的条目不可用于整理任务，与发送链路同源）。
 */

import type { MemorySettings } from "../../store/hubSettingsStore";
import type { ProviderItem } from "../../components/settings/model-provider/types";
import { providerAllowsMissingApiKey } from "../../components/settings/model-provider/types";
import type { ExtractionModelDeps } from "./extraction/extractionEngine";

/** provider apiFormat → pi-ai model type（子代理模型钉选解析共用）。 */
export const API_FORMAT_TO_TYPE: Record<string, string> = {
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
  // F7：运行时复查 enabled（禁用不该只体现在下拉菜单里）。
  if (!provider.enabled) {
    throw new Error(`记忆整理模型供应商已被禁用：${provider.name || provider.id}`);
  }
  // 模型必须属于该供应商且处于启用态（未声明的模型 id 视为已删/不可用）。
  const modelItem = provider.models.find((m) => m.id === modelId);
  if (!modelItem || modelItem.enabled === false) {
    throw new Error(`记忆整理模型不可用（已禁用或已删除）：${provider.id}/${modelId}`);
  }
  // 免 Key 本地网关（Ollama/自定义本地端点）缺 Key 属正常，不抛错。
  if (!provider.apiKey.trim() && !providerAllowsMissingApiKey(provider)) {
    throw new Error(`记忆整理模型供应商 API Key 为空：${provider.name || provider.id}`);
  }

  const { buildModel } = await import("../providers/modelFactory");
  const { getStreamFnForApi } = await import("../providers/runAgentTurn");
  const model = buildModel({
    provider: (API_FORMAT_TO_TYPE[provider.apiFormat] ?? "openai") as never,
    apiKey: provider.apiKey,
    modelId,
    baseUrl: provider.baseUrl,
    apiFormat: provider.apiFormat,
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
