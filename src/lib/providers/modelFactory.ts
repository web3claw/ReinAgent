import type { Model } from "@earendil-works/pi-ai";
import { getProviderMeta, type ProviderType, DEFAULT_PROVIDER } from "./catalog";

export interface ProviderConfig {
  provider?: ProviderType;
  apiKey: string;
  modelId: string;
  baseUrl?: string;
  hasEffort?: boolean;
  /**
   * 模型真实元数据（来自服务商配置 / 上游 /v1/models 解析结果）。
   * No-Fallback 铁律：缺省/非法即为「未知」，绝不按模型名猜数。
   */
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  /** true=声明支持图片输入；false/缺省=未声明（不臆测多模态）。 */
  supportsImage?: boolean | null;
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

/**
 * Anthropic Messages 协议的 `max_tokens` 是必填字段；当模型元数据未声明最大输出时，
 * 用它作为**请求级上限**（文档语义：非元数据，UI 不展示）。
 * 取值 32000：足以容纳长回答，同时避免某些服务端对「无上限」的畸形处理。
 */
export const ANTHROPIC_REQUIRED_MAX_TOKENS = 32_000;

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

  // ---- 真实元数据（No-Fallback 铁律，2026-09-28 整改 A2）----
  // 上下文窗口：真实值必须为正有限数；未知传 0 —— pi-ai 的
  // clampMaxTokensToContext 对 `contextWindow <= 0` 显式跳过钳制（未知语义），
  // 我们自己的容量面板同样以 <=0 判定「不渲染」，绝不显示假上限。
  const contextWindow =
    typeof config.contextWindow === "number" &&
    Number.isFinite(config.contextWindow) &&
    config.contextWindow > 0
      ? config.contextWindow
      : 0;
  // 最大输出：真实值必须为正有限数。未知时的处理按协议区分——
  // - openai-completions / google：传 0（pi-ai 适配器 `if (options?.maxTokens)` 才写
  //   max_tokens 字段，0 即不发送），由服务端按模型原生上限执行；
  // - anthropic-messages：`max_tokens` 是协议**必填**字段，pi-ai 会
  //   `Math.max(1, …)` 兜底成 1（会把回复截成 1 token），因此未知时发送一个
  //   明确的「请求级上限」常量。它**不是模型元数据**：UI（模型设置/容量面板）
  //   仍按未提供显示「未知」，绝不伪装成真实值。
  const knownMaxTokens =
    typeof config.maxOutputTokens === "number" &&
    Number.isFinite(config.maxOutputTokens) &&
    config.maxOutputTokens > 0
      ? config.maxOutputTokens
      : undefined;
  const maxTokens =
    knownMaxTokens ?? (meta.api === "anthropic-messages" ? ANTHROPIC_REQUIRED_MAX_TOKENS : 0);
  // 多模态：只有明确 true 才声明 image（未声明/未知一律纯文本，不臆测）。
  const input: ("text" | "image")[] = config.supportsImage === true ? ["text", "image"] : ["text"];

  return {
    id: modelId,
    name: modelId,
    api: meta.api,
    provider: provider,
    baseUrl: runtimeBaseUrl,
    reasoning: isReasoning,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
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
