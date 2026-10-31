import { formatModelContextWindowLabel, type ProviderItem } from "../../components/settings/model-provider/types";

export const MODEL_KEY_DELIMITER = ":::";

/**
 * 格式化存储用的服务商与模型 Key。
 * 使用 ::: 作为安全分隔符，避免某些服务商或模型 ID 中自带的 "/" 导致解析截断（如 workbuddy/deepseek-v4.1-flash）。
 */
export function formatModelKey(providerId: string, modelId: string): string {
  return `${providerId}${MODEL_KEY_DELIMITER}${modelId}`;
}

/**
 * 解析存储的模型 Key。
 * 支持新版 ::: 分隔符，并向下兼容第一代包含单个或多个 / 的历史格式（安全截取第一个分隔符，保留后续完整 ID）。
 */
export function parseModelKey(key: string): { providerId: string; modelId: string } | null {
  if (!key || typeof key !== "string") return null;
  const trimmed = key.trim();
  if (!trimmed) return null;

  // 1. 优先尝试安全分隔符 :::
  const delimIdx = trimmed.indexOf(MODEL_KEY_DELIMITER);
  if (delimIdx !== -1) {
    const providerId = trimmed.slice(0, delimIdx).trim();
    const modelId = trimmed.slice(delimIdx + MODEL_KEY_DELIMITER.length).trim();
    if (!providerId && !modelId) return null;
    return { providerId, modelId };
  }

  // 2. 向下兼容历史单 / 格式（仅按第一个斜杠切分，防止模型 ID 自带斜杠被错误截断）
  const slashIdx = trimmed.indexOf("/");
  if (slashIdx !== -1) {
    const providerId = trimmed.slice(0, slashIdx).trim();
    const modelId = trimmed.slice(slashIdx + 1).trim();
    if (!providerId && !modelId) return null;
    return { providerId, modelId };
  }

  // 3. 既无 ::: 也无 /，回退为单模型 ID
  return { providerId: "", modelId: trimmed };
}

export interface ResolvedModelInfo {
  providerId: string;
  modelId: string;
  displayName: string;
  ctxLabel: string | null;
  supportsImage: boolean;
  isExplicitlySelected: boolean;
  providerName: string;
}

/**
 * 综合解析当前生效的模型配置与 UI 展示所需元数据。
 */
export function resolveActiveModelInfo(params: {
  selectedModelKey?: string | null;
  defaultProviderId?: string;
  defaultModelId?: string;
  providers?: ProviderItem[];
  defaultLabel?: string;
}): ResolvedModelInfo {
  const {
    selectedModelKey,
    defaultProviderId = "deepseek",
    defaultModelId = "",
    providers = [],
    defaultLabel = "默认模型",
  } = params;

  let targetProviderId = defaultProviderId;
  let targetModelId = defaultModelId;
  let isExplicitlySelected = false;

  if (selectedModelKey && selectedModelKey.trim()) {
    const parsed = parseModelKey(selectedModelKey);
    if (parsed) {
      if (parsed.providerId) targetProviderId = parsed.providerId;
      targetModelId = parsed.modelId;
      isExplicitlySelected = true;
    }
  }

  const prov = providers.find((p) => p.id === targetProviderId);
  const mod = prov?.models?.find((m) => m.id === targetModelId);

  // 显示名称：模型名 > 模型ID > 服务商名 > 默认文案
  const displayName =
    mod?.name ||
    targetModelId ||
    prov?.name ||
    targetProviderId ||
    defaultLabel;

  const rawCtx = formatModelContextWindowLabel(mod?.contextWindow);
  const ctxLabel = rawCtx && rawCtx.trim().length > 0 ? rawCtx : null;
  const supportsImage = Boolean(mod?.supportsImage);
  const providerName = prov?.name || targetProviderId;

  return {
    providerId: targetProviderId,
    modelId: targetModelId,
    displayName,
    ctxLabel,
    supportsImage,
    isExplicitlySelected,
    providerName,
  };
}
