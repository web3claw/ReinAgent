import type { Settings } from "../../../lib/settings/store";
import { cleanBaseUrl } from "../../../lib/providers/modelFactory";

// API 格式类型唯一定义在 lib/providers/modelFactory（ProviderConfig.apiFormat 同源）
export type { ApiFormatType } from "../../../lib/providers/modelFactory";
import type { ApiFormatType } from "../../../lib/providers/modelFactory";

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

/**
 * 未声明 effort 元数据的模型所使用的隐式档位集（F6 单一真相源，2026-10-05）。
 *
 * 未声明 ≠ 支持全部档位：宁保守不加档（不含 xhigh/max）。发送链路与 UI 选档
 * 必须共用这一份集合，否则会出现"界面显示 Default、请求实发 Max"的脱节——
 * 残留的 xhigh/max 必须在切换到无元数据模型时被收敛回本集合。
 */
export const IMPLICIT_EFFORT_LEVELS: EffortLevel[] = ["default", "low", "medium", "high"];

/**
 * 解析模型实际支持的档位集：有声明用声明，无声明用隐式集合。
 */
export function resolveSupportedEffortLevels(
  model: Pick<ModelItem, "effort"> | null | undefined,
): EffortLevel[] {
  const declared = model?.effort?.supportedLevels;
  return declared && declared.length > 0 ? declared : IMPLICIT_EFFORT_LEVELS;
}

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

/**
 * 免 Key 供应商判定（F5 单一真相源，2026-10-05）。
 *
 * 本地网关（Ollama / LM Studio / vLLM 等本地 OpenAI 兼容端点）无需 API Key，
 * 留空属正常配置，**必须走真实请求**（不再落入 faux 演示假流）；网关若要求鉴权，
 * 如实返回 401 而不是假装成功。
 *
 * 判定规则（与 settings 层既有 testConnectivity / fetchModels 的口径一致）：
 *  - 预设 `ollama`：本地服务，天然免 Key；
 *  - 自定义供应商（`isCustom` 且填了 Base URL）：可能是本地网关，按免 Key 处理。
 *
 * 注意：这里只回答「缺 Key 是否代表未配置」，不回答「供应商是否可用」——
 * 后者还要看 `enabled`。
 */
export function providerAllowsMissingApiKey(
  provider: Pick<ProviderItem, "id" | "isCustom" | "baseUrl"> | null | undefined,
): boolean {
  if (!provider) return false;
  if (provider.id === "ollama") return true;
  return Boolean(provider.isCustom && provider.baseUrl?.trim());
}

/**
 * 供应商「可用」判定：已启用，且要么有 Key、要么是免 Key 网关。
 * 禁用或（云端）缺 Key 都视为不可用——调用方据此 fail-fast，绝不静默回落。
 */
export function isProviderUsable(
  provider: Pick<ProviderItem, "id" | "isCustom" | "baseUrl" | "apiKey" | "enabled"> | null | undefined,
): boolean {
  if (!provider) return false;
  if (!provider.enabled) return false;
  if (provider.apiKey?.trim()) return true;
  return providerAllowsMissingApiKey(provider);
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
 *
 * F18（2026-10-05）：读取失败与「文件不存在」必须区分——旧实现把两者都当成
 * `list=[]`，随后走初始化分支把空白预设**写盘覆盖**用户配置（含全部 API Key），
 * 不可恢复。现约定：
 *  - 文件不存在（Rust 返回空串）→ 正常初始化预设并写盘（首次运行语义）；
 *  - 读取/解析失败（invoke 异常、JSON 损坏、结构非法）→ **抛错**，绝不自动写盘，
 *    由调用方（设置页）显示错误态横幅，用户修复文件后重启即可恢复。
 */
export async function loadProvidersConfigFromDisk(currentSettings?: Settings): Promise<ProviderItem[]> {
  let list: ProviderItem[] = [];
  let rawContent = "";
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    rawContent = await invoke<string>("provider_config_load");
  } catch (e) {
    // invoke 异常 = 后端读取失败（IO 错误等），绝不能当「空配置」覆盖用户数据。
    throw new Error(
      `读取 provider_config.json 失败（未做任何写盘，用户配置保持原样）：${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (rawContent && rawContent.trim()) {
    // 文件存在且有内容：解析失败或结构非法 → 抛错（禁止用空白预设覆盖）。
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch (e) {
      throw new Error(
        `provider_config.json 解析失败（文件已损坏，未做任何写盘）：${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error("provider_config.json 结构非法（期望数组，未做任何写盘）");
    }
    if (parsed.length > 0) {
      list = parsed.map((item) => {
        const cleanedBaseUrl = cleanBaseUrl(item.baseUrl);
        if (item.apiFormat === "openai-completions") {
          return { ...item, baseUrl: cleanedBaseUrl, apiFormat: "openai-chat-completions" };
        }
        return { ...item, baseUrl: cleanedBaseUrl };
      });
    }
  }

  // 文件确实不存在（rawContent 为空串）或内容为空数组 → 首次运行，初始化预设并写盘。
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

