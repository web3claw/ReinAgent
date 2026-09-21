import type { Model } from "@earendil-works/pi-ai";
import { getProviderMeta, type ProviderType, DEFAULT_PROVIDER } from "./catalog";

export interface ProviderConfig {
  provider?: ProviderType;
  apiKey: string;
  modelId: string;
  baseUrl?: string;
}

export function normalizeBaseUrl(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.replace(/\/+$/, "");
}

export function buildModel(config: ProviderConfig): Model<any> {
  const provider = config.provider || DEFAULT_PROVIDER;
  const meta = getProviderMeta(provider);
  const baseUrl = normalizeBaseUrl(config.baseUrl) || meta.defaultBaseUrl;
  const modelId = config.modelId || meta.defaultModelId;

  return {
    id: modelId,
    name: modelId,
    api: meta.api,
    provider: provider,
    baseUrl,
    reasoning: modelId.includes("r1") || modelId.includes("reasoner") || modelId.includes("o1") || modelId.includes("o3"),
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };
}

export function validateProviderConfig(config: Partial<ProviderConfig>): string | null {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (config.baseUrl && config.baseUrl.trim().length > 0 && baseUrl === undefined) {
    return "baseUrl 无效";
  }
  if (baseUrl !== undefined && !/^https?:\/\//i.test(baseUrl)) {
    return "baseUrl 必须以 http:// 或 https:// 开头";
  }
  return null;
}
