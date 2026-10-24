/**
 * 知识库 embedding 绑定解析：hubSettings.knowledge {providerId, modelId} →
 * provider_config.json 中的实际服务商配置 → EmbeddingTarget。
 *
 * No-Fallback：未绑定 / 服务商不存在 / baseUrl 缺失一律抛错（调用方区分
 * 「合法空态」与「配置错误」），绝不猜测兜底。
 */

import { loadProvidersConfigFromDisk, type ProviderItem } from "../../components/settings/model-provider/types";
import { ensureV1BaseUrl } from "../providers/modelFactory";
import { useHubSettings, type KnowledgeSettings } from "../../store/hubSettingsStore";
import type { EmbeddingTarget } from "./embeddingClient";

export function getKnowledgeSettings(): KnowledgeSettings {
  return useHubSettings.getState().settings.knowledge;
}

export function isKnowledgeConfigured(settings?: KnowledgeSettings): boolean {
  const s = settings ?? getKnowledgeSettings();
  return s.providerId.trim() !== "" && s.modelId.trim() !== "";
}

/** 解析绑定的服务商配置；找不到/未启用/缺 baseUrl 时抛错（原文含具体原因）。 */
export async function resolveKnowledgeEmbeddingProvider(
  settings?: KnowledgeSettings,
): Promise<{ provider: ProviderItem; modelId: string }> {
  const s = settings ?? getKnowledgeSettings();
  if (s.providerId.trim() === "" || s.modelId.trim() === "") {
    throw new Error("知识库未配置 embedding 服务商（设置 ▸ 知识库 中绑定）");
  }
  const providers = await loadProvidersConfigFromDisk();
  const provider = providers.find((p) => p.id === s.providerId);
  if (!provider) {
    throw new Error(`知识库绑定的服务商不存在（id: ${s.providerId}）——请在设置 ▸ 知识库 重新绑定`);
  }
  if (!provider.enabled) {
    throw new Error(`知识库绑定的服务商已停用（${provider.name}）——请启用后重试`);
  }
  if (!provider.baseUrl || provider.baseUrl.trim() === "") {
    throw new Error(`知识库绑定的服务商缺少 Base URL（${provider.name}）`);
  }
  return { provider, modelId: s.modelId };
}

/** → embeddingClient 的请求目标（baseUrl 归一化到 /v1）。 */
export async function resolveKnowledgeEmbeddingTarget(): Promise<EmbeddingTarget> {
  const { provider, modelId } = await resolveKnowledgeEmbeddingProvider();
  return {
    baseUrl: ensureV1BaseUrl(provider.baseUrl),
    apiKey: (provider.apiKey || "").trim(),
    model: modelId,
  };
}
