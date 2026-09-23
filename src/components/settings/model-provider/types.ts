import type { Settings } from "../../../lib/settings/store";
import { cleanBaseUrl } from "../../../lib/providers/modelFactory";

export type ApiFormatType =
  | "openai-chat-completions"
  | "openai-completions"
  | "anthropic-messages"
  | "openai-responses"
  | "google-generative-ai";

export interface ApiFormatOption {
  value: ApiFormatType;
  label: string;
}

export const API_FORMAT_OPTIONS: ApiFormatOption[] = [
  { value: "openai-chat-completions", label: "Chat Completions (/v1/chat/completions)" },
  { value: "anthropic-messages", label: "Anthropic Messages (/v1/messages)" },
  { value: "openai-responses", label: "Responses (/responses)" },
  { value: "google-generative-ai", label: "Google Generative AI (/models)" },
];

export type EffortLevel = "default" | "low" | "medium" | "high" | "xhigh" | "max";

export const ALL_EFFORT_LEVELS: EffortLevel[] = ["default", "low", "medium", "high", "xhigh", "max"];

export interface ModelEffortConfig {
  supportedLevels: EffortLevel[];
  defaultLevel?: EffortLevel;
}

export interface ModelItem {
  id: string;
  name: string;
  enabled: boolean;
  isCustom?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsImage?: boolean;
  effort?: ModelEffortConfig;
}

export function formatModelContextWindowLabel(contextWindow?: number): string {
  if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return "";
  }
  // 技术规格紧凑格式化（>=1000 compact 如 1M, 128K, 32K）
  return new Intl.NumberFormat("en-US", {
    notation: contextWindow >= 1_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
  }).format(contextWindow);
}

export interface ProviderItem {
  id: string;
  name: string;
  apiFormat: ApiFormatType;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  models: ModelItem[];
  isCustom?: boolean;
  apiKeyUrl?: string;
  defaultModelId: string;
}

export const PRESET_PROVIDERS: ProviderItem[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    apiFormat: "openai-chat-completions",
    baseUrl: "https://api.deepseek.com",
    apiKey: "",
    enabled: true,
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
    defaultModelId: "",
    models: [],
  },
  {
    id: "openai",
    name: "OpenAI",
    apiFormat: "openai-chat-completions",
    baseUrl: "https://api.openai.com",
    apiKey: "",
    enabled: true,
    apiKeyUrl: "https://platform.openai.com/api-keys",
    defaultModelId: "",
    models: [],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    apiFormat: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    apiKey: "",
    enabled: true,
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    defaultModelId: "",
    models: [],
  },
  {
    id: "gemini",
    name: "Google Gemini",
    apiFormat: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "",
    enabled: true,
    apiKeyUrl: "https://aistudio.google.com/app/apikey",
    defaultModelId: "",
    models: [],
  },
  {
    id: "ollama",
    name: "Ollama (Local)",
    apiFormat: "openai-chat-completions",
    baseUrl: "http://localhost:11434",
    apiKey: "",
    enabled: true,
    defaultModelId: "",
    models: [],
  },
];

/**
 * 获取初始内置服务商列表（纯内存，不依赖任何存储）
 */
export function getInitialPresetProviders(currentSettings?: Settings): ProviderItem[] {
  const list = PRESET_PROVIDERS.map((p) => ({
    ...p,
    models: p.models.map((m) => ({ ...m })),
  }));

  if (currentSettings) {
    const curProvider = list.find((p) => p.id === currentSettings.provider);
    if (curProvider) {
      if (currentSettings.apiKey && !curProvider.apiKey) {
        curProvider.apiKey = currentSettings.apiKey;
      }
      if (currentSettings.baseUrl && !curProvider.baseUrl) {
        curProvider.baseUrl = currentSettings.baseUrl;
      }
    }
  }

  return list;
}

/**
 * 从后端 ~/.ReinAgent/provider_config.json 读取多服务商配置
 */
export async function loadProvidersConfigFromDisk(currentSettings?: Settings): Promise<ProviderItem[]> {
  let list: ProviderItem[] = [];
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const content = await invoke<string>("provider_config_load");
    if (content && content.trim()) {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed) && parsed.length > 0) {
        list = parsed.map((item) => {
          const cleanedBaseUrl = cleanBaseUrl(item.baseUrl);
          if (item.apiFormat === "openai-completions") {
            return { ...item, baseUrl: cleanedBaseUrl, apiFormat: "openai-chat-completions" };
          }
          return { ...item, baseUrl: cleanedBaseUrl };
        });
      }
    }
  } catch (e) {
    console.warn("[provider_config] Failed to load provider_config.json from disk", e);
  }

  // 若磁盘文件为空或不存在，生成初始预设并立即写盘初始化 ~/.ReinAgent/provider_config.json
  if (list.length === 0) {
    list = getInitialPresetProviders(currentSettings);
    saveProvidersConfigToDisk(list).catch((err) => {
      console.warn("[provider_config] Failed to initialize provider_config.json on disk", err);
    });
  } else {
    // 补齐缺失的预设提供商
    for (const preset of PRESET_PROVIDERS) {
      const existing = list.find((p) => p.id === preset.id);
      if (!existing) {
        list.push({
          ...preset,
          models: preset.models.map((m) => ({ ...m })),
        });
      }
    }
  }

  // 将当前全局 settings.json 中的值合并同步到对应的 Provider
  if (currentSettings) {
    const curProvider = list.find((p) => p.id === currentSettings.provider);
    if (curProvider) {
      if (currentSettings.apiKey && !curProvider.apiKey) {
        curProvider.apiKey = currentSettings.apiKey;
      }
      if (currentSettings.baseUrl && !curProvider.baseUrl) {
        curProvider.baseUrl = cleanBaseUrl(currentSettings.baseUrl);
      }
      if (currentSettings.modelId) {
        if (curProvider.models.some((m) => m.id === currentSettings.modelId)) {
          curProvider.defaultModelId = currentSettings.modelId;
        } else if (curProvider.isCustom) {
          curProvider.defaultModelId = currentSettings.modelId;
          curProvider.models.unshift({
            id: currentSettings.modelId,
            name: currentSettings.modelId,
            enabled: true,
            isCustom: true,
          });
        }
      }
    }
  }

  return list;
}

/**
 * 实时保存多服务商配置到 ~/.ReinAgent/provider_config.json
 */
export async function saveProvidersConfigToDisk(providers: ProviderItem[]): Promise<void> {
  try {
    const normalizedProviders = providers.map((p) => ({
      ...p,
      baseUrl: cleanBaseUrl(p.baseUrl),
    }));
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("provider_config_save", {
      content: JSON.stringify(normalizedProviders, null, 2),
    });
  } catch (e) {
    console.error("[provider_config] Failed to save provider_config.json to disk", e);
  }
}

/**
 * 实时同步更新指定 provider 下指定模型的默认推理等级并写盘
 */
export async function updateModelEffortDefaultLevel(
  providerId: string,
  modelId: string,
  defaultLevel: EffortLevel
): Promise<void> {
  try {
    const providers = await loadProvidersConfigFromDisk();
    const provider = providers.find((p) => p.id === providerId);
    if (!provider) return;
    const model = provider.models.find((m) => m.id === modelId);
    if (!model) return;
    if (!model.effort) {
      model.effort = { supportedLevels: [defaultLevel], defaultLevel };
    } else {
      model.effort.defaultLevel = defaultLevel;
      if (!model.effort.supportedLevels.includes(defaultLevel)) {
        model.effort.supportedLevels.push(defaultLevel);
      }
    }
    await saveProvidersConfigToDisk(providers);
  } catch (e) {
    console.error("[provider_config] Failed to update model effort default level", e);
  }
}

