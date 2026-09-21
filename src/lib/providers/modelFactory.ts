/**
 * 模型对象工厂 + 配置校验。
 *
 * 负责把「用户配置」（apiKey / modelId / baseUrl）转成 pi-ai 需要的 `Model` 对象，
 * 并在发送前做最小校验。（apiKey 不进入 Model，它是 stream() 的 options。）
 */

import type { Model } from "@earendil-works/pi-ai";
import { CATALOG, defaultCatalogEntry, findCatalogEntry } from "./catalog";

/** 供应商运行时配置（S2 只放内存，持久化留给 S3）。 */
export interface ProviderConfig {
  apiKey: string;
  modelId: string;
  baseUrl?: string;
}

/** 归一化 baseUrl：去空白、去尾部斜杠；空值返回 undefined。 */
export function normalizeBaseUrl(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.replace(/\/+$/, "");
}

/**
 * 构造 `Model<"openai-completions">`。
 * - modelId 命中目录 → 用该目录项；否则退化到默认项。
 * - baseUrl 有覆盖时返回浅拷贝，避免污染常量目录。
 */
export function buildModel(config: ProviderConfig): Model<"openai-completions"> {
  const base = findCatalogEntry(config.modelId) ?? defaultCatalogEntry();
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (baseUrl === undefined || baseUrl === base.baseUrl) return base;
  return { ...base, baseUrl };
}

/**
 * 校验配置。返回 null 表示合法，否则返回可读的中文错误信息。
 * S2 只校验 baseUrl 形状（apiKey 是否缺失由调用方决定走 faux 还是真实路径）。
 */
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

/** 供 UI 使用的模型选项列表。 */
export function catalogOptions(): { id: string; name: string }[] {
  return CATALOG.map((model) => ({ id: model.id, name: model.name }));
}
