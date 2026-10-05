import type { Model } from "@earendil-works/pi-ai";
import { getProviderMeta, type ProviderType, DEFAULT_PROVIDER } from "./catalog";

export type ApiFormatType =
  | "openai-chat-completions"
  | "openai-completions"
  | "anthropic-messages"
  | "openai-responses"
  | "google-generative-ai";

/**
 * provider_config.json 的 apiFormat（设置页「API 格式」所选）→ pi-ai 线上协议。
 * openai-chat-completions 与遗留 openai-completions 都走 Chat Completions 适配器；
 * openai-responses 走 OpenAI Responses 适配器（POST {base}/v1/responses）。
 */
export const API_FORMAT_TO_WIRE: Record<ApiFormatType, string> = {
  "openai-chat-completions": "openai-completions",
  "openai-completions": "openai-completions",
  "anthropic-messages": "anthropic-messages",
  "openai-responses": "openai-responses",
  "google-generative-ai": "google-generative-ai",
};

export interface ProviderConfig {
  provider?: ProviderType;
  apiKey: string;
  modelId: string;
  baseUrl?: string;
  hasEffort?: boolean;
  /**
   * 设置页所选 API 格式（provider_config.json 的 apiFormat）。决定真实线上协议，
   * 缺省/未知值回落 catalog 的 provider meta（旧行为）。
   */
  apiFormat?: ApiFormatType;
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
 * 模型元数据未声明最大输出时的**请求级 max_tokens 兜底**（文档语义：非元数据，
 * UI 不展示）。取值 32000：与 LiveAgent MAX_OUTPUT_TOKEN_CAP / OpenCode
 * OUTPUT_TOKEN_MAX 同值，足以容纳长回答。
 *
 * ⚠ 为什么未知时也必须有值并发送（不能省略）：实测（2026-10-05，用户反馈
 * GonkaRouter 流式经常半途无声截断）——不发 max_tokens 时上游套用自家默认输出
 * 上限（GonkaRouter 实测 3072 tokens 即 finish=length，回复半途被掐且无错误行）。
 * 该值的实际发送由 `runAgentTurn.ts` 的 `resolveMaxTokens` 在流式调用时注入
 * （openai/responses 适配器只认 options.maxTokens；anthropic 适配器自身兜底，
 * 见 D1 定稿 2026-10-05：照 LiveAgent「未知也发」设计）。
 */
export const ANTHROPIC_REQUIRED_MAX_TOKENS = 32_000;

export function buildModel(config: ProviderConfig): Model<any> {
  const provider = config.provider || DEFAULT_PROVIDER;
  const meta = getProviderMeta(provider);
  const rawBaseUrl = normalizeBaseUrl(config.baseUrl) || meta.defaultBaseUrl;
  const modelId = config.modelId || meta.defaultModelId;

  // 真实线上协议：优先取设置页所选 apiFormat（provider_config.json），未知/缺省回落 catalog meta
  const api =
    (config.apiFormat && API_FORMAT_TO_WIRE[config.apiFormat]) || meta.api;

  // ⚠ 两个 SDK 的 baseURL 约定不同，绝不能统一补 /v1：
  // - OpenAI SDK：baseURL 必须含 /v1，SDK 自行追加 /chat/completions 或 /responses
  //   （baseURL 不带 /v1 → POST /chat/completions → 404）；
  // - Anthropic SDK：baseURL 必须不带 /v1，SDK 自身追加 /v1/messages
  //   （baseURL 带 /v1 → POST /v1/v1/messages → 404 page not found，2026-10-05 实测）。
  let runtimeBaseUrl = rawBaseUrl;
  if (api === "openai-completions" || api === "openai-responses") {
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
  // 最大输出：真实值必须为正有限数。未知时发 32000 请求级兜底常量——
  // anthropic-messages 协议 max_tokens 必填（0 会被 pi-ai 兜成 1 token 截成 1）；
  // openai / responses 协议由 runAgentTurn 的 resolveMaxTokens 注入后真实发送
  //（不发则网关套用自家过小默认导致半途截断，见 ANTHROPIC_REQUIRED_MAX_TOKENS 注释）。
  // 它**不是模型元数据**：UI（模型设置/容量面板）仍按未提供显示「未知」，绝不伪装成真实值。
  const knownMaxTokens =
    typeof config.maxOutputTokens === "number" &&
    Number.isFinite(config.maxOutputTokens) &&
    config.maxOutputTokens > 0
      ? config.maxOutputTokens
      : undefined;
  const maxTokens = knownMaxTokens ?? ANTHROPIC_REQUIRED_MAX_TOKENS;
  // 多模态：只有明确 true 才声明 image（未声明/未知一律纯文本，不臆测）。
  const input: ("text" | "image")[] = config.supportsImage === true ? ["text", "image"] : ["text"];

  return {
    id: modelId,
    name: modelId,
    api,
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
