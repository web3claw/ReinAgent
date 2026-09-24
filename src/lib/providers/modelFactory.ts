import type { Model } from "@earendil-works/pi-ai";
import { getProviderMeta, type ProviderType, DEFAULT_PROVIDER } from "./catalog";

export interface ProviderConfig {
  provider?: ProviderType;
  apiKey: string;
  modelId: string;
  baseUrl?: string;
  hasEffort?: boolean;
}

/**
 * 清洗 Base URL：去除首尾空格、末尾多余斜杠、末尾的 /v1（大小写不敏感）
 * 例如：
 * "http://192.168.3.27:8787/v1/" -> "http://192.168.3.27:8787"
 * "http://192.168.3.27:8787///" -> "http://192.168.3.27:8787"
 */
export function cleanBaseUrl(raw: string | undefined | null): string {
  if (typeof raw !== "string") return "";
  let cleaned = raw.trim().replace(/\/+$/, "");
  if (cleaned.toLowerCase().endsWith("/v1")) {
    cleaned = cleaned.slice(0, -3).replace(/\/+$/, "");
  }
  return cleaned;
}

/**
 * 确保 Base URL 带有标准 /v1 前缀（用于向服务端发起实际请求）
 * 例如：
 * "http://192.168.3.27:8787" -> "http://192.168.3.27:8787/v1"
 * "http://192.168.3.27:8787/" -> "http://192.168.3.27:8787/v1"
 * "http://192.168.3.27:8787/v1" -> "http://192.168.3.27:8787/v1"
 */
export function ensureV1BaseUrl(raw: string | undefined | null): string {
  const cleaned = cleanBaseUrl(raw);
  if (!cleaned) return "";
  return `${cleaned}/v1`;
}

export function normalizeBaseUrl(raw: string | undefined): string | undefined {
  const cleaned = cleanBaseUrl(raw);
  return cleaned.length > 0 ? cleaned : undefined;
}

export function buildModel(config: ProviderConfig): Model<any> {
  const provider = config.provider || DEFAULT_PROVIDER;
  const meta = getProviderMeta(provider);
  const rawBaseUrl = normalizeBaseUrl(config.baseUrl) || meta.defaultBaseUrl;
  const modelId = config.modelId || meta.defaultModelId;

  // 针对 OpenAI 兼容（openai-completions / openai-responses）和 Anthropic 协议，自动补全 /v1
  let runtimeBaseUrl = rawBaseUrl;
  if (meta.api === "openai-completions" || meta.api === "anthropic-messages") {
    runtimeBaseUrl = ensureV1BaseUrl(rawBaseUrl);
  }

  // 推理能力（对齐 LiveAgent 乐观兜底）：优先取真实元数据（模型 effort 声明），
  // 未声明时乐观视为支持（请求带 reasoning_effort，服务端不支持时会自行忽略）。
  // 铁律红线仍在：上下文大小 / Token 上限 / 多模态严禁按名猜测——推理档位不在此列。
  const isReasoning = config.hasEffort !== false;

  return {
    id: modelId,
    name: modelId,
    api: meta.api,
    provider: provider,
    baseUrl: runtimeBaseUrl,
    reasoning: isReasoning,
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
