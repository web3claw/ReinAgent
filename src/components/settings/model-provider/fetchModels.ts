import type { ProviderItem, ModelItem } from "./types";
import { cleanBaseUrl, ensureV1BaseUrl } from "../../../lib/providers/modelFactory";
import { proxiedFetch } from "../../../lib/web/proxiedFetch";

export interface FetchModelsResult {
  success: boolean;
  models?: ModelItem[];
  newCount?: number;
  totalCount?: number;
  error?: string;
}

/**
 * 完整、真实解析服务端 API 返回的原始数据，绝不伪造或瞎猜任何参数
 */
export function parseProviderRawModels(data: unknown): ModelItem[] {
  if (!data) return [];
  let rawList: unknown[] = [];
  if (Array.isArray(data)) {
    rawList = data;
  } else if (typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.data)) {
      rawList = obj.data;
    } else if (Array.isArray(obj.models)) {
      rawList = obj.models;
    }
  }

  const result: ModelItem[] = [];
  const seenIds = new Set<string>();

  for (const item of rawList) {
    if (typeof item === "string") {
      const cleanId = item.trim();
      if (cleanId && !seenIds.has(cleanId)) {
        seenIds.add(cleanId);
        result.push({
          id: cleanId,
          name: cleanId,
          enabled: true,
          isCustom: false,
        });
      }
    } else if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      const rawId = obj.id ?? obj.name ?? obj.model;
      if (typeof rawId === "string") {
        let cleanId = rawId.trim();
        // 如果是 Gemini 格式，去除 "models/" 前缀
        if (cleanId.startsWith("models/")) {
          cleanId = cleanId.slice("models/".length);
        }
        if (!cleanId || seenIds.has(cleanId)) continue;
        seenIds.add(cleanId);

        // 显示名称：优先取服务端提供的 displayName 或 name
        const displayName =
          typeof obj.displayName === "string" && obj.displayName.trim()
            ? obj.displayName.trim()
            : typeof obj.name === "string" && obj.name !== rawId && obj.name.trim()
              ? obj.name.trim()
              : cleanId;

        // 上下文大小解析：读取各种官方常见客观字段（如 context_window, context_length, inputTokenLimit 等）
        let contextWindow: number | undefined = undefined;
        const rawContext =
          obj.context_window ??
          obj.context_length ??
          obj.max_context_length ??
          obj.inputTokenLimit ??
          obj.input_token_limit;
        if (typeof rawContext === "number" && Number.isFinite(rawContext) && rawContext > 0) {
          contextWindow = rawContext;
        }

        // 最大输出 Tokens 解析
        let maxOutputTokens: number | undefined = undefined;
        const rawOutput =
          obj.max_output_tokens ??
          obj.outputTokenLimit ??
          obj.output_token_limit ??
          obj.max_tokens;
        if (typeof rawOutput === "number" && Number.isFinite(rawOutput) && rawOutput > 0) {
          maxOutputTokens = rawOutput;
        }

        // 视觉 / 多模态能力解析：读取 supports_images, supports_image, input_modalities 或 modalities
        let supportsImage: boolean | undefined = undefined;
        if (typeof obj.supports_images === "boolean") {
          supportsImage = obj.supports_images;
        } else if (typeof obj.supports_image === "boolean") {
          supportsImage = obj.supports_image;
        } else {
          const modalities = obj.input_modalities ?? obj.modalities;
          if (Array.isArray(modalities)) {
            supportsImage = modalities.some(
              (m) => typeof m === "string" && m.toLowerCase().includes("image")
            );
          }
        }

        // 推理等级 (Effort) 真实解析：读取 effort.supported_levels 与 effort.default_level
        let effort: import("./types").ModelEffortConfig | undefined = undefined;
        if (obj.effort && typeof obj.effort === "object") {
          const effortObj = obj.effort as Record<string, unknown>;
          const rawLevels = effortObj.supported_levels ?? effortObj.supportedLevels;
          if (Array.isArray(rawLevels)) {
            const validLevels = ["default", "low", "medium", "high", "xhigh", "max"] as const;
            const supportedLevels = rawLevels
              .map((l) => String(l).toLowerCase().trim())
              .filter((l): l is import("./types").EffortLevel => validLevels.includes(l as any));
            if (supportedLevels.length > 0) {
              let defaultLevel: import("./types").EffortLevel | undefined = undefined;
              const rawDefault = String(effortObj.default_level ?? effortObj.defaultLevel ?? "")
                .toLowerCase()
                .trim();
              if (validLevels.includes(rawDefault as any)) {
                defaultLevel = rawDefault as import("./types").EffortLevel;
              } else {
                defaultLevel = supportedLevels[0];
              }
              effort = { supportedLevels, defaultLevel };
            }
          }
        }

        result.push({
          id: cleanId,
          name: displayName,
          enabled: false,
          isCustom: false,
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
          ...(supportsImage !== undefined ? { supportsImage } : {}),
          ...(effort !== undefined ? { effort } : {}),
        });
      }
    }
  }

  return result;
}

/**
 * 增量合并新拉取的模型：
 * 绝不使用臆测兜底填充未返回的字段
 */
export function mergeFetchedModels(
  existing: ModelItem[],
  fetchedModels: Array<ModelItem | string>
): { merged: ModelItem[]; newCount: number } {
  const existingMap = new Map(existing.map((m) => [m.id, m]));
  const merged: ModelItem[] = [...existing];
  let newCount = 0;

  for (const raw of fetchedModels) {
    const fetched: ModelItem =
      typeof raw === "string"
        ? { id: raw, name: raw, enabled: false, isCustom: false }
        : raw;

    const existingModel = existingMap.get(fetched.id);
    if (!existingModel) {
      merged.push({ ...fetched });
      existingMap.set(fetched.id, fetched);
      newCount++;
    } else {
      // 已有模型：保留用户开关和名称，如果官方接口带来了真实元数据则如实更新
      let updated = false;
      const next = { ...existingModel };
      if (existingModel.contextWindow === undefined && fetched.contextWindow !== undefined) {
        next.contextWindow = fetched.contextWindow;
        updated = true;
      }
      if (existingModel.supportsImage === undefined && fetched.supportsImage !== undefined) {
        next.supportsImage = fetched.supportsImage;
        updated = true;
      }
      if (existingModel.maxOutputTokens === undefined && fetched.maxOutputTokens !== undefined) {
        next.maxOutputTokens = fetched.maxOutputTokens;
        updated = true;
      }
      if (existingModel.effort === undefined && fetched.effort !== undefined) {
        next.effort = fetched.effort;
        updated = true;
      }
      if (updated) {
        const idx = merged.findIndex((m) => m.id === fetched.id);
        if (idx >= 0) merged[idx] = next;
      }
    }
  }

  return { merged, newCount };
}

export async function fetchProviderModels(
  provider: ProviderItem
): Promise<FetchModelsResult> {
  const cleanedBase = cleanBaseUrl(provider.baseUrl);
  const apiKey = (provider.apiKey || "").trim();

  if (!cleanedBase) {
    return { success: false, error: "Base URL is required" };
  }

  if (provider.id !== "ollama" && !apiKey) {
    return { success: false, error: "API Key is required" };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    let res: Response | null = null;

    // 1. Ollama 服务商
    if (provider.id === "ollama") {
      try {
        const tagsRes = await proxiedFetch(`${cleanedBase}/api/tags`, { signal: controller.signal });
        if (tagsRes.ok) {
          res = tagsRes;
        }
      } catch {
        // 请求失败，尝试 /v1/models
      }
      if (!res || !res.ok) {
        res = await proxiedFetch(`${ensureV1BaseUrl(cleanedBase)}/models`, { signal: controller.signal });
      }
    }
    // 2. Anthropic Messages 协议（标准请求 /v1/models）
    else if (provider.apiFormat === "anthropic-messages") {
      const endpoint = `${ensureV1BaseUrl(cleanedBase)}/models`;
      res = await proxiedFetch(endpoint, {
        method: "GET",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: controller.signal,
      });
    }
    // 3. Google Generative AI 协议
    else if (provider.apiFormat === "google-generative-ai") {
      const endpoint = `${cleanedBase}/models?key=${apiKey}`;
      res = await proxiedFetch(endpoint, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });
    }
    // 4. OpenAI 兼容协议（openai-chat-completions / openai-responses 等）：直接请求 /v1/models，不搞智能容错
    else {
      const targetUrl = `${ensureV1BaseUrl(cleanedBase)}/models`;
      res = await proxiedFetch(targetUrl, {
        method: "GET",
        headers: {
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        signal: controller.signal,
      });
    }

    clearTimeout(timeoutId);

    if (!res.ok) {
      let errMsg = `HTTP ${res.status} ${res.statusText}`;
      try {
        const errJson = await res.json();
        if (errJson && typeof errJson === "object") {
          const detail =
            errJson.error?.message ||
            errJson.message ||
            errJson.error ||
            JSON.stringify(errJson);
          if (detail && typeof detail === "string") errMsg = `${errMsg}: ${detail}`;
        }
      } catch {
        // ignore json parse error
      }
      return { success: false, error: errMsg };
    }

    const data = await res.json();
    const fetchedModels = parseProviderRawModels(data);

    if (fetchedModels.length === 0) {
      return {
        success: false,
        error: "未在服务商接口响应中解析到可用模型列表 (No models returned from API)",
      };
    }

    const { merged, newCount } = mergeFetchedModels(provider.models, fetchedModels);

    return {
      success: true,
      models: merged,
      newCount,
      totalCount: merged.length,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      return { success: false, error: "请求超时 (Request Timeout)" };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
